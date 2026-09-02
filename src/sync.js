import fsp from 'node:fs/promises';
import path from 'node:path';
import { hashFile, isMediaFile, isRenderable, readMetadata } from './media.js';
import { assertValidName, contains, safeJoin, toPosix } from './paths.js';
import { throwIfAborted } from './util.js';

/**
 * Importing from the computer into the library on the SSD.
 *
 * Three rules this module does not bend:
 *
 *   1. Sources are read-only. Nothing here opens a source file for writing,
 *      renames it, or deletes it. "Sync" means copy-in; if you want the phone
 *      dump cleared out afterwards, you do that yourself, once you can see the
 *      photos in the library.
 *   2. Identity is the content hash, so importing the same folder twice, or
 *      two folders that overlap, cannot produce duplicates.
 *   3. Every copy is verified by re-reading what landed on the drive. A silent
 *      truncation during a copy to removable media is exactly the failure this
 *      whole project exists to protect against.
 */

const ORGANISE = new Set(['date', 'mirror', 'flat']);

export function normaliseSource(source) {
  if (!source || typeof source.path !== 'string' || !source.path.trim()) {
    throw Object.assign(new Error('a sync source needs a path'), { status: 400 });
  }
  const organizeBy = source.organizeBy ?? 'date';
  if (!ORGANISE.has(organizeBy)) {
    throw Object.assign(
      new Error(`organizeBy must be one of: ${[...ORGANISE].join(', ')}`),
      { status: 400 },
    );
  }
  // `into` is a folder name inside the library, not a path, so an import can
  // never be steered outside the drive by a config edit.
  const into = source.into ? assertValidName(source.into) : 'Imported';
  return { path: path.resolve(source.path), into, organizeBy };
}

async function collect(sourceRoot, { signal }) {
  const found = [];
  const queue = [sourceRoot];
  while (queue.length > 0) {
    throwIfAborted(signal);
    const dir = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        queue.push(full);
      } else if (entry.isFile() && isMediaFile(entry.name)) {
        found.push(full);
      }
    }
  }
  return found.sort();
}

function destinationFor({ sourceRoot, absPath, into, organizeBy, takenAt }) {
  const filename = path.basename(absPath);
  if (organizeBy === 'flat') return `${into}/${filename}`;
  if (organizeBy === 'mirror') {
    const rel = toPosix(path.relative(sourceRoot, absPath));
    return `${into}/${rel}`;
  }
  const date = new Date(takenAt ?? Date.now());
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${into}/${year}/${year}-${month}-${day}/${filename}`;
}

/** First free name at `relPath`, appending -1, -2, … before the extension. */
async function uniqueDestination(libraryRoot, relPath) {
  const ext = path.posix.extname(relPath);
  const stem = relPath.slice(0, relPath.length - ext.length);
  for (let n = 0; n < 1000; n += 1) {
    const candidate = n === 0 ? relPath : `${stem}-${n}${ext}`;
    const exists = await fsp.stat(safeJoin(libraryRoot, candidate)).then(() => true, () => false);
    if (!exists) return candidate;
  }
  throw new Error(`could not find a free filename for ${relPath}`);
}

/**
 * Copy every new photo from the configured sources into the library.
 *
 * `onProgress` receives `{ phase, processed, total, current }`.
 */
export async function syncSources(library, sources, { onProgress = () => {}, signal, verifyCopies = true } = {}) {
  const report = {
    imported: 0, duplicates: 0, skipped: 0, failed: 0, bytes: 0,
    sources: [], errors: [],
  };
  const normalised = sources.map(normaliseSource);

  onProgress({ phase: 'listing', processed: 0, total: 0, current: null });
  const work = [];
  for (const source of normalised) {
    const stat = await fsp.stat(source.path).catch(() => null);
    if (!stat?.isDirectory()) {
      report.errors.push({ source: source.path, error: 'source folder not found' });
      report.sources.push({ path: source.path, files: 0, imported: 0 });
      continue;
    }
    // Refuse to import a folder that is the library, or sits inside it — that
    // would copy the drive onto itself, forever.
    if (contains(library.path, source.path)) {
      report.errors.push({ source: source.path, error: 'source is inside the library itself' });
      report.sources.push({ path: source.path, files: 0, imported: 0 });
      continue;
    }
    const files = await collect(source.path, { signal });
    work.push({ source, files });
    report.sources.push({ path: source.path, files: files.length, imported: 0 });
  }

  const total = work.reduce((sum, item) => sum + item.files.length, 0);
  let processed = 0;

  const ledgerGet = library.db.prepare('SELECT size, mtime FROM import_ledger WHERE source_path = ?');
  const ledgerPut = library.db.prepare(
    `INSERT INTO import_ledger (source_path, size, mtime, hash, rel_path, imported_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET
       size = excluded.size, mtime = excluded.mtime, hash = excluded.hash,
       rel_path = excluded.rel_path, imported_at = excluded.imported_at`,
  );
  const byHash = library.db.prepare('SELECT rel_path FROM photos WHERE hash = ? AND missing = 0 LIMIT 1');
  const insertPhoto = library.db.prepare(
    `INSERT INTO photos (rel_path, folder_path, filename, ext, size, mtime, hash,
                         width, height, orientation, taken_at, camera, lens,
                         thumb_state, missing, indexed_at)
     VALUES (@relPath, @folderPath, @filename, @ext, @size, @mtime, @hash,
             @width, @height, @orientation, @takenAt, @camera, @lens,
             @thumbState, 0, @indexedAt)
     ON CONFLICT(rel_path) DO NOTHING`,
  );

  // Sequential on purpose: this is a large streaming copy to removable media,
  // where parallel writes buy nothing and make progress meaningless.
  for (const { source, files } of work) {
    const summary = report.sources.find((entry) => entry.path === source.path);
    for (const absPath of files) {
      throwIfAborted(signal);
      processed += 1;
      onProgress({ phase: 'importing', processed, total, current: path.basename(absPath) });

      try {
        const stat = await fsp.stat(absPath);
        const mtime = Math.round(stat.mtimeMs);

        const seen = ledgerGet.get(absPath);
        if (seen && seen.size === stat.size && seen.mtime === mtime) {
          report.skipped += 1;
          continue;
        }

        const hash = await hashFile(absPath);
        if (byHash.get(hash)) {
          // Already in the library under some path. Record it so the next sync
          // does not have to hash it again.
          ledgerPut.run(absPath, stat.size, mtime, hash, null, Date.now());
          report.duplicates += 1;
          continue;
        }

        const meta = await readMetadata(absPath, { fallbackMtime: mtime });
        const wanted = destinationFor({
          sourceRoot: source.path,
          absPath,
          into: source.into,
          organizeBy: source.organizeBy,
          takenAt: meta.takenAt,
        });
        const relPath = await uniqueDestination(library.path, wanted);
        const dest = safeJoin(library.path, relPath);

        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(absPath, dest);
        await fsp.utimes(dest, stat.atime, stat.mtime).catch(() => {});

        if (verifyCopies) {
          const written = await hashFile(dest);
          if (written !== hash) {
            await fsp.rm(dest, { force: true });
            throw new Error('copy did not match the source (drive full, or a bad cable?)');
          }
        }

        const folderPath = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
        library.ensureFolderRow(folderPath);
        insertPhoto.run({
          relPath,
          folderPath,
          filename: path.posix.basename(relPath),
          ext: path.extname(relPath).toLowerCase(),
          size: stat.size,
          mtime,
          hash,
          width: meta.width,
          height: meta.height,
          orientation: meta.orientation,
          takenAt: meta.takenAt,
          camera: meta.camera,
          lens: meta.lens,
          thumbState: isRenderable(relPath) ? 'pending' : 'unsupported',
          indexedAt: Date.now(),
        });
        ledgerPut.run(absPath, stat.size, mtime, hash, relPath, Date.now());

        report.imported += 1;
        report.bytes += stat.size;
        if (summary) summary.imported += 1;
      } catch (err) {
        if (err.cancelled) throw err;
        report.failed += 1;
        if (report.errors.length < 50) {
          report.errors.push({ source: absPath, error: err.message });
        }
      }
    }
  }

  onProgress({ phase: 'done', processed: total, total, current: null });
  return report;
}
