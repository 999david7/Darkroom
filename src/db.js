import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { INTERNAL_DIRNAME } from './volume.js';

/**
 * The index database.
 *
 * It lives on the SSD, next to the photos it describes, not on the computer.
 * That is the whole point of the project: unplug the drive and there is
 * nothing left behind to browse — no filenames, no dates, no cached grid of
 * everything you own. It also means the library is portable between machines
 * with no export step, and that a lost laptop leaks nothing.
 */

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS folders (
  id             INTEGER PRIMARY KEY,
  rel_path       TEXT NOT NULL UNIQUE,   -- '' is the library root
  parent_path    TEXT,                   -- NULL only for the root
  name           TEXT NOT NULL,
  description    TEXT,
  cover_photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
  sort_key       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_path);

CREATE TABLE IF NOT EXISTS photos (
  id           INTEGER PRIMARY KEY,
  rel_path     TEXT NOT NULL UNIQUE,
  folder_path  TEXT NOT NULL,
  filename     TEXT NOT NULL,
  ext          TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mtime        INTEGER NOT NULL,
  hash         TEXT,                     -- sha256 of file contents
  width        INTEGER,
  height       INTEGER,
  orientation  INTEGER,
  taken_at     INTEGER,                  -- ms since epoch; EXIF where available
  camera       TEXT,
  lens         TEXT,
  title        TEXT,
  caption      TEXT,
  favorite     INTEGER NOT NULL DEFAULT 0,
  -- 'pending' | 'ready' | 'unsupported'. 'unsupported' covers RAW files and
  -- any format the local image library cannot decode; they stay in the index
  -- with a placeholder tile rather than vanishing.
  thumb_state  TEXT NOT NULL DEFAULT 'pending',
  missing      INTEGER NOT NULL DEFAULT 0,
  indexed_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_folder   ON photos(folder_path, taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_hash     ON photos(hash);
CREATE INDEX IF NOT EXISTS idx_photos_taken    ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_favorite ON photos(favorite) WHERE favorite = 1;
CREATE INDEX IF NOT EXISTS idx_photos_missing  ON photos(missing);

-- Remembers which files a sync already pulled in, keyed by their path in the
-- source folder. Lets a repeat sync skip untouched files on a stat alone
-- instead of re-hashing gigabytes to rediscover that nothing changed.
CREATE TABLE IF NOT EXISTS import_ledger (
  source_path TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,
  hash        TEXT NOT NULL,
  rel_path    TEXT,
  imported_at INTEGER NOT NULL
);
`;

export function databasePath(libraryPath) {
  return path.join(libraryPath, INTERNAL_DIRNAME, 'index.db');
}

export function cacheDir(libraryPath) {
  return path.join(libraryPath, INTERNAL_DIRNAME, 'cache');
}

export function trashDir(libraryPath) {
  return path.join(libraryPath, INTERNAL_DIRNAME, 'trash');
}

export function openDatabase(libraryPath) {
  const file = databasePath(libraryPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);

  // WAL is the right mode on a normal filesystem, but external drives are
  // routinely exFAT, where the shared-memory file WAL needs may be refused.
  // Fall back rather than fail: a slower journal beats an unopenable library.
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    db.pragma('journal_mode = TRUNCATE');
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(SCHEMA);
  migrate(db);
  ensureRootFolder(db);
  return db;
}

function migrate(db) {
  const current = Number(db.pragma('user_version', { simple: true }));
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `this library was written by a newer version of Darkroom ` +
        `(schema ${current}, this build understands ${SCHEMA_VERSION})`,
    );
  }
  // Future schema changes go here as `if (current < N) { ... }` blocks.
  if (current !== SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

function ensureRootFolder(db) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO folders (rel_path, parent_path, name, created_at, updated_at)
     VALUES ('', NULL, 'Library', ?, ?)
     ON CONFLICT(rel_path) DO NOTHING`,
  ).run(now, now);
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}
