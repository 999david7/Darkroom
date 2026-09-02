import fsp from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, trashDir } from './db.js';
import { assertValidName, baseName, parentOf, relFrom, safeJoin, toPosix } from './paths.js';
import { dropThumbs } from './thumbs.js';

/**
 * Query and mutation layer over one mounted library.
 *
 * An instance is only ever alive while the drive is plugged in. The server
 * creates one on `mounted` and closes it on `unmounted`, so there is no way to
 * read photo data through a stale handle after the SSD is pulled.
 */

/** Escape LIKE wildcards in user input; pair with `ESCAPE '\'` in the SQL. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * SQL fragment matching a folder and everything beneath it. The root ('')
 * matches every photo, which saves a pointless `LIKE '%'` scan.
 */
function subtree(relPath, column = 'folder_path') {
  if (relPath === '') return { sql: '1 = 1', params: [] };
  return {
    sql: `(${column} = ? OR ${column} LIKE ? ESCAPE '\\')`,
    params: [relPath, `${escapeLike(relPath)}/%`],
  };
}

const SORTS = {
  taken_desc: 'taken_at DESC, filename DESC',
  taken_asc: 'taken_at ASC, filename ASC',
  name_asc: 'filename COLLATE NOCASE ASC',
  name_desc: 'filename COLLATE NOCASE DESC',
  added_desc: 'indexed_at DESC, id DESC',
};

export class Library {
  constructor(libraryPath, marker) {
    this.path = libraryPath;
    this.marker = marker;
    this.db = openDatabase(libraryPath);
  }

  close() {
    try {
      this.db.close();
    } catch {
      // Already closed, or the drive vanished mid-flight. Nothing to salvage.
    }
  }

  /** Absolute path of a photo, guaranteed to sit inside the library. */
  absPathOf(photo) {
    return safeJoin(this.path, photo.rel_path);
  }

  // ---------------------------------------------------------------- folders

  getFolder(relPath) {
    return this.db.prepare('SELECT * FROM folders WHERE rel_path = ?').get(relPath) ?? null;
  }

  /**
   * The whole folder tree in three queries: the folders, a per-folder photo
   * count, and a per-folder newest photo. Counts and cover fallbacks are then
   * rolled up through the tree in JavaScript, which beats issuing a recursive
   * query per folder for a structure that is only ever a few hundred nodes.
   */
  folderTree() {
    const rows = this.db
      .prepare('SELECT * FROM folders ORDER BY rel_path')
      .all();

    const counts = new Map();
    for (const row of this.db
      .prepare(
        `SELECT folder_path, COUNT(*) AS n, SUM(size) AS bytes
         FROM photos WHERE missing = 0 GROUP BY folder_path`,
      )
      .all()) {
      counts.set(row.folder_path, { n: row.n, bytes: row.bytes ?? 0 });
    }

    // SQLite's bare-column rule: with exactly one max() aggregate, the other
    // selected columns come from the row that produced the maximum.
    const newest = new Map();
    for (const row of this.db
      .prepare(
        `SELECT folder_path, id, hash, MAX(taken_at) AS taken_at
         FROM photos
         WHERE missing = 0 AND thumb_state <> 'unsupported'
         GROUP BY folder_path`,
      )
      .all()) {
      newest.set(row.folder_path, { id: row.id, takenAt: row.taken_at ?? 0 });
    }

    const nodes = new Map();
    for (const row of rows) {
      const own = counts.get(row.rel_path) ?? { n: 0, bytes: 0 };
      nodes.set(row.rel_path, {
        path: row.rel_path,
        parent: row.parent_path,
        name: row.rel_path === '' ? 'All photos' : row.name,
        description: row.description ?? null,
        coverPhotoId: row.cover_photo_id ?? null,
        directCount: own.n,
        count: 0,
        bytes: 0,
        children: [],
        // Bubbled up below so an empty parent still shows a picture from the
        // folders inside it.
        _fallback: newest.get(row.rel_path) ?? null,
      });
    }

    for (const node of nodes.values()) {
      if (node.parent === null) continue;
      const parent = nodes.get(node.parent);
      if (parent) parent.children.push(node);
    }

    // Deepest-first so a child is always finished before its parent reads it.
    // The root is depth 0; ''.split('/') would otherwise report 1 and tie with
    // the top-level folders it needs to sum.
    const depth = (relPath) => (relPath === '' ? 0 : relPath.split('/').length);
    const ordered = [...nodes.values()].sort((a, b) => depth(b.path) - depth(a.path));
    for (const node of ordered) {
      const own = counts.get(node.path) ?? { n: 0, bytes: 0 };
      node.count = own.n;
      node.bytes = own.bytes;
      for (const child of node.children) {
        node.count += child.count;
        node.bytes += child.bytes;
        if (child._fallback && (!node._fallback || child._fallback.takenAt > node._fallback.takenAt)) {
          node._fallback = child._fallback;
        }
      }
      node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }

    // Resolve each folder's cover: the explicit choice when it still points at
    // a live photo, otherwise the newest picture anywhere inside.
    const validCover = this.db.prepare(
      `SELECT id FROM photos WHERE id = ? AND missing = 0 AND thumb_state <> 'unsupported'`,
    );
    for (const node of nodes.values()) {
      let cover = null;
      if (node.coverPhotoId && validCover.get(node.coverPhotoId)) {
        cover = { id: node.coverPhotoId, explicit: true };
      } else if (node._fallback) {
        cover = { id: node._fallback.id, explicit: false };
      }
      node.cover = cover;
      delete node._fallback;
      delete node.parent;
    }

    return nodes.get('') ?? null;
  }

  /** Register a directory that exists on disk. Idempotent; used by the scanner. */
  ensureFolderRow(relPath) {
    if (relPath === '') return;
    const parent = parentOf(relPath);
    if (parent !== null && parent !== '') this.ensureFolderRow(parent);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO folders (rel_path, parent_path, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(rel_path) DO NOTHING`,
      )
      .run(relPath, parent, baseName(relPath), now, now);
  }

  async createFolder(parentPath, rawName) {
    const name = assertValidName(rawName);
    const parent = this.getFolder(parentPath);
    if (!parent) throw Object.assign(new Error('parent folder not found'), { status: 404 });

    const relPath = parentPath === '' ? name : `${parentPath}/${name}`;
    const abs = safeJoin(this.path, relPath);
    const existing = await fsp.stat(abs).catch(() => null);
    if (existing) {
      throw Object.assign(new Error(`"${name}" already exists here`), { status: 409 });
    }
    await fsp.mkdir(abs, { recursive: false });
    this.ensureFolderRow(relPath);
    return this.getFolder(relPath);
  }

  /**
   * Rename the directory on disk and repoint every index row beneath it.
   * Folders are real directories, so this has to move actual bytes' worth of
   * paths — but a rename within one filesystem is atomic and instant.
   */
  async renameFolder(relPath, rawName) {
    if (relPath === '') throw Object.assign(new Error('the library root cannot be renamed'), { status: 400 });
    const name = assertValidName(rawName);
    const folder = this.getFolder(relPath);
    if (!folder) throw Object.assign(new Error('folder not found'), { status: 404 });
    if (name === folder.name) return folder;

    const parent = parentOf(relPath);
    const nextPath = parent === '' ? name : `${parent}/${name}`;
    const from = safeJoin(this.path, relPath);
    const to = safeJoin(this.path, nextPath);

    if (await fsp.stat(to).catch(() => null)) {
      throw Object.assign(new Error(`"${name}" already exists here`), { status: 409 });
    }
    await fsp.rename(from, to);

    const prefix = `${relPath}/`;
    const nextPrefix = `${nextPath}/`;
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE folders SET rel_path = ?, name = ?, updated_at = ? WHERE rel_path = ?')
        .run(nextPath, name, now, relPath);
      this.db
        .prepare(
          `UPDATE folders
           SET rel_path    = ? || substr(rel_path, ?),
               parent_path = ? || substr(parent_path, ?)
           WHERE rel_path LIKE ? ESCAPE '\\'`,
        )
        .run(nextPrefix, prefix.length + 1, nextPrefix, prefix.length + 1, `${escapeLike(relPath)}/%`);
      this.db
        .prepare('UPDATE folders SET parent_path = ? WHERE parent_path = ?')
        .run(nextPath, relPath);
      this.db
        .prepare(
          `UPDATE photos
           SET rel_path    = ? || substr(rel_path, ?),
               folder_path = CASE WHEN folder_path = ?
                                  THEN ?
                                  ELSE ? || substr(folder_path, ?) END
           WHERE rel_path LIKE ? ESCAPE '\\'`,
        )
        .run(
          nextPrefix, prefix.length + 1,
          relPath, nextPath,
          nextPrefix, prefix.length + 1,
          `${escapeLike(relPath)}/%`,
        );
    })();

    return this.getFolder(nextPath);
  }

  /** Set a folder's description or its cover photo. */
  updateFolder(relPath, { description, coverPhotoId }) {
    const folder = this.getFolder(relPath);
    if (!folder) throw Object.assign(new Error('folder not found'), { status: 404 });

    if (coverPhotoId !== undefined && coverPhotoId !== null) {
      const photo = this.getPhoto(coverPhotoId);
      if (!photo) throw Object.assign(new Error('cover photo not found'), { status: 404 });
      // A cover must come from inside the folder, otherwise the tile lies about
      // what you are about to open.
      const inside = relPath === '' || photo.folder_path === relPath || photo.folder_path.startsWith(`${relPath}/`);
      if (!inside) {
        throw Object.assign(
          new Error('a cover photo must live in that folder or one inside it'),
          { status: 400 },
        );
      }
    }

    const fields = [];
    const params = [];
    if (description !== undefined) {
      fields.push('description = ?');
      params.push(description === null || description === '' ? null : String(description).slice(0, 2000));
    }
    if (coverPhotoId !== undefined) {
      fields.push('cover_photo_id = ?');
      params.push(coverPhotoId === null ? null : Number(coverPhotoId));
    }
    if (fields.length === 0) return folder;

    fields.push('updated_at = ?');
    params.push(Date.now(), relPath);
    this.db.prepare(`UPDATE folders SET ${fields.join(', ')} WHERE rel_path = ?`).run(...params);
    return this.getFolder(relPath);
  }

  // ----------------------------------------------------------------- photos

  getPhoto(id) {
    return this.db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(id)) ?? null;
  }

  listPhotos({
    folder = '',
    recursive = false,
    q = '',
    favorite = false,
    sort = 'taken_desc',
    limit = 200,
    offset = 0,
  } = {}) {
    const where = ['missing = 0'];
    const params = [];

    if (folder !== null) {
      if (recursive) {
        const scope = subtree(folder);
        where.push(scope.sql);
        params.push(...scope.params);
      } else {
        where.push('folder_path = ?');
        params.push(folder);
      }
    }
    if (favorite) where.push('favorite = 1');
    if (q) {
      const needle = `%${escapeLike(q.toLowerCase())}%`;
      where.push(
        `(LOWER(filename) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(title, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(caption, '')) LIKE ? ESCAPE '\\'
          OR LOWER(folder_path) LIKE ? ESCAPE '\\')`,
      );
      params.push(needle, needle, needle, needle);
    }

    const orderBy = SORTS[sort] ?? SORTS.taken_desc;
    const clause = where.join(' AND ');
    const capped = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const skip = Math.max(Number(offset) || 0, 0);

    const items = this.db
      .prepare(
        `SELECT id, rel_path, folder_path, filename, ext, size, hash, width, height,
                taken_at, camera, lens, title, caption, favorite, thumb_state
         FROM photos WHERE ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      )
      .all(...params, capped, skip);

    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM photos WHERE ${clause}`)
      .get(...params);

    return { items, total, limit: capped, offset: skip };
  }

  /** Neighbours of a photo within the current view, for lightbox navigation. */
  updatePhoto(id, { title, caption, favorite }) {
    const photo = this.getPhoto(id);
    if (!photo) throw Object.assign(new Error('photo not found'), { status: 404 });

    const fields = [];
    const params = [];
    if (title !== undefined) {
      fields.push('title = ?');
      params.push(title === null || title === '' ? null : String(title).slice(0, 300));
    }
    if (caption !== undefined) {
      fields.push('caption = ?');
      params.push(caption === null || caption === '' ? null : String(caption).slice(0, 4000));
    }
    if (favorite !== undefined) {
      fields.push('favorite = ?');
      params.push(favorite ? 1 : 0);
    }
    if (fields.length === 0) return photo;

    params.push(Number(id));
    this.db.prepare(`UPDATE photos SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return this.getPhoto(id);
  }

  /**
   * Remove a photo from the library.
   *
   * The file is moved into `.darkroom/trash/`, never unlinked. Darkroom is an
   * archive tool pointed at the only copy of someone's photographs; a bug or a
   * misclick here has to be recoverable, and "it is still on the drive, in a
   * folder called trash" is a guarantee anyone can verify without trusting the
   * code.
   */
  async deletePhoto(id) {
    const photo = this.getPhoto(id);
    if (!photo) throw Object.assign(new Error('photo not found'), { status: 404 });

    const from = this.absPathOf(photo);
    const stamp = new Date().toISOString().slice(0, 10);
    const destDir = path.join(trashDir(this.path), stamp, path.dirname(photo.rel_path));
    await fsp.mkdir(destDir, { recursive: true });

    let dest = path.join(destDir, photo.filename);
    for (let n = 1; await fsp.stat(dest).then(() => true, () => false); n += 1) {
      const ext = path.extname(photo.filename);
      dest = path.join(destDir, `${path.basename(photo.filename, ext)}-${n}${ext}`);
    }

    try {
      await fsp.rename(from, dest);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Already gone from disk; drop the row and call it done.
      } else {
        throw err;
      }
    }

    this.db.prepare('UPDATE folders SET cover_photo_id = NULL WHERE cover_photo_id = ?').run(photo.id);
    this.db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);

    // Only discard the rendered copies once nothing else shares the bytes.
    const stillUsed = this.db.prepare('SELECT 1 FROM photos WHERE hash = ? LIMIT 1').get(photo.hash);
    if (!stillUsed) await dropThumbs(this.path, photo.hash);

    return { id: photo.id, movedTo: toPosix(relFrom(this.path, dest)) };
  }

  // ------------------------------------------------------------------ stats

  stats() {
    const photos = this.db
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(size), 0) AS bytes,
                COALESCE(SUM(favorite), 0) AS favorites,
                COALESCE(SUM(thumb_state = 'unsupported'), 0) AS unsupported,
                MIN(taken_at) AS oldest,
                MAX(taken_at) AS newest
         FROM photos WHERE missing = 0`,
      )
      .get();
    const { folders } = this.db
      .prepare("SELECT COUNT(*) AS folders FROM folders WHERE rel_path <> ''")
      .get();
    const { missing } = this.db.prepare('SELECT COUNT(*) AS missing FROM photos WHERE missing = 1').get();
    return { ...photos, folders, missing };
  }
}
