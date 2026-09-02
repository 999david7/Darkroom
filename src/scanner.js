import fsp from 'node:fs/promises';
import path from 'node:path';
import { INTERNAL_DIRNAME } from './volume.js';
import { hashFile, isMediaFile, isRenderable, readMetadata } from './media.js';
import { relFrom, safeJoin } from './paths.js';
import { dropThumbs } from './thumbs.js';
import { mapPool, throwIfAborted } from './util.js';

/**
 * Bringing the index in line with what is actually on the drive.
 *
 * The scan is deliberately reconciliation rather than rebuild. A photo library
 * accumulates things that only exist in the index — a caption, a favourite, a
 * folder cover — and those must survive the file being moved into a different
 * folder or the whole library being reorganised in Finder. So the scanner
 * matches by content hash and *moves* index rows to follow their files instead
 * of deleting and reinserting them.
 */

/** Directories never worth walking into. */
const SKIP_DIRS = new Set([INTERNAL_DIRNAME, '.git', 'node_modules', '@eaDir', '.Trashes', '$RECYCLE.BIN']);

async function walk(root, { signal } = {}) {
  const files = [];
  const folders = [];
  const queue = [''];

  while (queue.length > 0) {
    throwIfAborted(signal);
    const relDir = queue.shift();
    const absDir = relDir === '' ? root : safeJoin(root, relDir);

    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (relDir === '') throw err;
      continue; // A directory that vanished mid-walk is simply not there.
    }

    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        folders.push(rel);
        queue.push(rel);
      } else if (entry.isFile() && isMediaFile(entry.name)) {
        files.push(rel);
      }
      // Symlinks are skipped: following them can leave the library root and
      // can loop, and neither is worth supporting for an archive on a drive.
    }
  }
  return { files, folders };
}

async function describe(root, relPath) {
  const abs = safeJoin(root, relPath);
  const stat = await fsp.stat(abs);
  const hash = await hashFile(abs);
  const meta = await readMetadata(abs, { fallbackMtime: Math.round(stat.mtimeMs) });
  return {
    relPath,
    abs,
    size: stat.size,
    mtime: Math.round(stat.mtimeMs),
    hash,
    ...meta,
    thumbState: isRenderable(relPath) ? 'pending' : 'unsupported',
  };
}

/**
 * Reconcile the index with the filesystem.
 *
 * `onProgress` receives `{ phase, processed, total, current }`. `signal`
 * aborts between files, so cancelling never leaves a half-written row.
 */
export async function scanLibrary(library, { onProgress = () => {}, signal, concurrency = 4 } = {}) {
  const { db, path: root } = library;
  const report = {
    added: 0, updated: 0, moved: 0, missing: 0, restored: 0,
    foldersAdded: 0, foldersRemoved: 0, unchanged: 0, failed: 0, scanned: 0,
  };

  onProgress({ phase: 'walking', processed: 0, total: 0, current: null });
  const { files, folders } = await walk(root, { signal });
  report.scanned = files.length;

  // ---- folders -------------------------------------------------------------
  const onDisk = new Set(folders);
  const known = new Set(
    db.prepare("SELECT rel_path FROM folders WHERE rel_path <> ''").all().map((r) => r.rel_path),
  );
  db.transaction(() => {
    for (const rel of onDisk) {
      if (!known.has(rel)) {
        library.ensureFolderRow(rel);
        report.foldersAdded += 1;
      }
    }
    const remove = db.prepare('DELETE FROM folders WHERE rel_path = ?');
    for (const rel of known) {
      if (!onDisk.has(rel)) {
        remove.run(rel);
        report.foldersRemoved += 1;
      }
    }
  })();

  // ---- classify ------------------------------------------------------------
  const rows = db
    .prepare('SELECT id, rel_path, size, mtime, hash, missing, thumb_state FROM photos')
    .all();
  const byPath = new Map(rows.map((row) => [row.rel_path, row]));

  const fresh = [];  // On disk, no index row at this path.
  const dirty = [];  // Indexed here, but the bytes changed.

  await mapPool(files, concurrency, async (rel) => {
    throwIfAborted(signal);
    const row = byPath.get(rel);
    if (!row) {
      fresh.push(rel);
      return;
    }
    byPath.delete(rel);
    const stat = await fsp.stat(safeJoin(root, rel)).catch(() => null);
    if (!stat) {
      fresh.push(rel);
      return;
    }
    const mtime = Math.round(stat.mtimeMs);
    if (row.size === stat.size && row.mtime === mtime && row.missing === 0) {
      report.unchanged += 1;
      return;
    }
    dirty.push({ rel, row });
  });

  // Whatever is left in `byPath` has no file at its recorded path: either it
  // moved somewhere else in the library, or it is gone.
  const orphans = [...byPath.values()];
  const orphansByHash = new Map();
  for (const orphan of orphans) {
    if (!orphan.hash) continue;
    if (!orphansByHash.has(orphan.hash)) orphansByHash.set(orphan.hash, []);
    orphansByHash.get(orphan.hash).push(orphan);
  }
  const claimed = new Set();

  // ---- changed files -------------------------------------------------------
  let processed = 0;
  const total = dirty.length + fresh.length;

  const updateRow = db.prepare(
    `UPDATE photos SET size = ?, mtime = ?, hash = ?, width = ?, height = ?,
            orientation = ?, taken_at = ?, camera = ?, lens = ?,
            thumb_state = ?, missing = 0, indexed_at = ?
     WHERE id = ?`,
  );

  await mapPool(dirty, concurrency, async ({ rel, row }) => {
    throwIfAborted(signal);
    try {
      const info = await describe(root, rel);
      if (row.hash && row.hash !== info.hash) await dropThumbs(root, row.hash);
      updateRow.run(
        info.size, info.mtime, info.hash, info.width, info.height,
        info.orientation, info.takenAt, info.camera, info.lens,
        info.thumbState, Date.now(), row.id,
      );
      report.updated += 1;
    } catch (err) {
      if (err.cancelled) throw err;
      report.failed += 1;
    }
    processed += 1;
    onProgress({ phase: 'indexing', processed, total, current: rel });
  });

  // ---- new files -----------------------------------------------------------
  const insertRow = db.prepare(
    `INSERT INTO photos (rel_path, folder_path, filename, ext, size, mtime, hash,
                         width, height, orientation, taken_at, camera, lens,
                         thumb_state, missing, indexed_at)
     VALUES (@relPath, @folderPath, @filename, @ext, @size, @mtime, @hash,
             @width, @height, @orientation, @takenAt, @camera, @lens,
             @thumbState, 0, @indexedAt)
     ON CONFLICT(rel_path) DO NOTHING`,
  );
  const moveRow = db.prepare(
    `UPDATE photos SET rel_path = @relPath, folder_path = @folderPath, filename = @filename,
            ext = @ext, size = @size, mtime = @mtime, hash = @hash, width = @width,
            height = @height, orientation = @orientation, taken_at = @takenAt,
            camera = @camera, lens = @lens, thumb_state = @thumbState,
            missing = 0, indexed_at = @indexedAt
     WHERE id = @id`,
  );

  await mapPool(fresh, concurrency, async (rel) => {
    throwIfAborted(signal);
    try {
      const info = await describe(root, rel);
      const params = {
        relPath: info.relPath,
        folderPath: path.posix.dirname(info.relPath) === '.' ? '' : path.posix.dirname(info.relPath),
        filename: path.posix.basename(info.relPath),
        ext: path.extname(info.relPath).toLowerCase(),
        size: info.size,
        mtime: info.mtime,
        hash: info.hash,
        width: info.width,
        height: info.height,
        orientation: info.orientation,
        takenAt: info.takenAt,
        camera: info.camera,
        lens: info.lens,
        thumbState: info.thumbState,
        indexedAt: Date.now(),
      };

      // Did a file we thought was lost just turn up here under a new path?
      // Reusing its row keeps the caption, the favourite and any folder cover
      // pointing at it.
      const candidates = orphansByHash.get(info.hash) ?? [];
      const inherit = candidates.find((row) => !claimed.has(row.id));
      if (inherit) {
        claimed.add(inherit.id);
        moveRow.run({ ...params, id: inherit.id });
        if (inherit.missing) report.restored += 1;
        else report.moved += 1;
      } else {
        insertRow.run(params);
        report.added += 1;
      }
    } catch (err) {
      if (err.cancelled) throw err;
      report.failed += 1;
    }
    processed += 1;
    onProgress({ phase: 'indexing', processed, total, current: rel });
  });

  // ---- everything still unaccounted for ------------------------------------
  const markMissing = db.prepare('UPDATE photos SET missing = 1 WHERE id = ?');
  db.transaction(() => {
    for (const orphan of orphans) {
      if (claimed.has(orphan.id)) continue;
      if (orphan.missing) continue; // Already flagged by an earlier scan.
      markMissing.run(orphan.id);
      report.missing += 1;
    }
  })();

  onProgress({ phase: 'done', processed: total, total, current: null });
  return report;
}

/** Forget index rows whose files are gone. Never touches anything on disk. */
export function pruneMissing(library) {
  const rows = library.db.prepare('SELECT id, hash FROM photos WHERE missing = 1').all();
  library.db.transaction(() => {
    for (const row of rows) {
      library.db
        .prepare('UPDATE folders SET cover_photo_id = NULL WHERE cover_photo_id = ?')
        .run(row.id);
      library.db.prepare('DELETE FROM photos WHERE id = ?').run(row.id);
    }
  })();
  return { pruned: rows.length };
}

/**
 * Re-hash every indexed file and report what no longer matches.
 *
 * An archive drive is the one place silent corruption actually matters, and
 * the index already stores a hash per file — so verifying is nearly free to
 * offer and is the difference between having a backup and hoping you do.
 */
export async function verifyLibrary(library, { onProgress = () => {}, signal, concurrency = 4 } = {}) {
  const rows = library.db
    .prepare('SELECT id, rel_path, hash, size FROM photos WHERE missing = 0 ORDER BY rel_path')
    .all();
  const report = { checked: 0, ok: 0, changed: [], missing: [], unreadable: [] };
  let processed = 0;

  await mapPool(rows, concurrency, async (row) => {
    throwIfAborted(signal);
    const abs = safeJoin(library.path, row.rel_path);
    try {
      const stat = await fsp.stat(abs);
      const hash = await hashFile(abs);
      if (hash === row.hash) report.ok += 1;
      else report.changed.push({ id: row.id, path: row.rel_path, was: row.size, now: stat.size });
    } catch (err) {
      if (err.cancelled) throw err;
      if (err.code === 'ENOENT') report.missing.push({ id: row.id, path: row.rel_path });
      else report.unreadable.push({ id: row.id, path: row.rel_path, error: err.code ?? 'error' });
    }
    report.checked += 1;
    processed += 1;
    onProgress({ phase: 'verifying', processed, total: rows.length, current: row.rel_path });
  });

  return report;
}
