import path from 'node:path';

/**
 * Path helpers.
 *
 * Every relative path Darkroom stores in the database uses POSIX separators so
 * that a library written on macOS reads identically on Windows. Anything that
 * touches the filesystem converts back to the platform separator first, and
 * every conversion runs through the containment check below: a request must
 * never be able to address a file outside the library root.
 */

/** Convert a platform-native relative path to the POSIX form used in the DB. */
export function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/** Convert a stored POSIX relative path back to the platform form. */
export function fromPosix(relPath) {
  return relPath.split('/').join(path.sep);
}

/** True when `target` is `root` itself or lives underneath it. */
export function contains(root, target) {
  const from = path.resolve(root);
  const to = path.resolve(target);
  if (from === to) return true;
  const rel = path.relative(from, to);
  if (rel === '' || path.isAbsolute(rel)) return false;
  // Compare whole segments. A prefix test would read "..data" — a perfectly
  // legal directory name — as an attempt to climb out.
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * Join a stored relative path onto the library root, refusing anything that
 * escapes it. Absolute inputs, `..` segments and NUL bytes are all rejected
 * rather than sanitised, because a caller asking for them is either buggy or
 * hostile and both deserve a hard error.
 */
export function safeJoin(root, relPath) {
  if (typeof relPath !== 'string') throw new TypeError('relative path must be a string');
  if (relPath.includes('\0')) throw new Error('path contains a NUL byte');
  const native = fromPosix(relPath);
  if (path.isAbsolute(native) || /^[a-zA-Z]:/.test(native)) {
    throw new Error(`expected a relative path, got ${relPath}`);
  }
  const joined = path.resolve(root, native);
  if (!contains(root, joined)) throw new Error(`path escapes the library root: ${relPath}`);
  return joined;
}

/** POSIX relative path from `root` to `abs`. Returns '' for the root itself. */
export function relFrom(root, abs) {
  return toPosix(path.relative(root, abs));
}

/** The parent of a POSIX relative path, or null when it is already the root. */
export function parentOf(relPath) {
  if (!relPath) return null;
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

/** The last segment of a POSIX relative path. */
export function baseName(relPath) {
  if (!relPath) return '';
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

const INVALID_NAME = /[\\/:*?"<>|\0]/;
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** These are all "you typed something we can't use", so they carry a 400. */
function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Validate a single folder or file name typed by the user. Names are held to
 * the strictest of the platforms Darkroom targets so a library stays portable
 * between them — a folder created on Linux should still open on Windows.
 */
export function assertValidName(name) {
  if (typeof name !== 'string') throw invalid('name must be a string');
  const trimmed = name.trim();
  if (!trimmed) throw invalid('name cannot be empty');
  if (trimmed.length > 120) throw invalid('name is too long (max 120 characters)');
  if (trimmed === '.' || trimmed === '..') throw invalid('name cannot be "." or ".."');
  if (INVALID_NAME.test(trimmed)) throw invalid('name cannot contain \\ / : * ? " < > |');
  if (RESERVED_WINDOWS.test(trimmed)) throw invalid(`"${trimmed}" is a reserved name on Windows`);
  if (trimmed.endsWith('.')) throw invalid('name cannot end with a period');
  if (trimmed.startsWith('.')) throw invalid('name cannot start with a period');
  return trimmed;
}
