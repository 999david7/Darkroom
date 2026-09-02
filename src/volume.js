import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Volume identity and presence.
 *
 * A Darkroom library is identified by a marker file at its root rather than by
 * a mount path or an OS-specific device handle. That choice does a lot of work:
 *
 *   - Mount points move. macOS appends " 1" when a name collides, Linux uses
 *     /media/<user>/<label> or /run/media/<user>/<label> depending on the
 *     distro, Windows hands out whichever drive letter is free. An identifier
 *     stored *in* the library survives all of it.
 *   - It is portable. No udev, no diskutil, no WMI, no native bindings — just
 *     a JSON file and stat().
 *   - It is honest about what it proves. The marker proves "this is the library
 *     you paired with", which is exactly the question the lock screen asks. It
 *     is not a security boundary, and this module never pretends otherwise.
 */

export const MARKER_FILENAME = '.darkroom-library.json';

/** Internal directory inside the library: index, thumbnail cache, trash. */
export const INTERNAL_DIRNAME = '.darkroom';

export function newVolumeId() {
  return crypto.randomUUID();
}

/**
 * Read and validate the marker file at a library root.
 * Returns null when it is absent, unreadable or not ours — callers treat all
 * three as "no library here", which is the only useful distinction.
 */
export async function readMarker(libraryPath) {
  try {
    const raw = await fsp.readFile(path.join(libraryPath, MARKER_FILENAME), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.darkroom !== 1 || typeof parsed.id !== 'string' || !parsed.id) {
      return null;
    }
    return {
      id: parsed.id,
      label: typeof parsed.label === 'string' ? parsed.label : 'Darkroom library',
      createdAt: parsed.createdAt ?? null,
    };
  } catch {
    return null;
  }
}

export async function writeMarker(libraryPath, { id, label }) {
  const marker = {
    darkroom: 1,
    id,
    label,
    createdAt: new Date().toISOString(),
    note: 'This file identifies the folder as a Darkroom photo library. Keep it here.',
  };
  await fsp.mkdir(libraryPath, { recursive: true });
  await fsp.writeFile(
    path.join(libraryPath, MARKER_FILENAME),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
  return marker;
}

/**
 * Create a new library at `libraryPath`, or adopt the one already there.
 * Adopting is not an error: pointing `init` at an existing library is how you
 * re-pair a drive on a second computer.
 */
export async function initLibrary(libraryPath, label) {
  const resolved = path.resolve(libraryPath);
  const existing = await readMarker(resolved);
  if (existing) return { ...existing, path: resolved, adopted: true };

  const stat = await fsp.stat(resolved).catch(() => null);
  if (stat && !stat.isDirectory()) {
    throw new Error(`${resolved} exists and is not a directory`);
  }
  const marker = await writeMarker(resolved, {
    id: newVolumeId(),
    label: label || path.basename(resolved) || 'Darkroom library',
  });
  await fsp.mkdir(path.join(resolved, INTERNAL_DIRNAME), { recursive: true });
  return { ...marker, path: resolved, adopted: false };
}

/** Places removable media typically appears, by platform. */
export function mountRoots(extra = []) {
  const roots = [];
  const user = os.userInfo().username;
  if (process.platform === 'darwin') {
    roots.push('/Volumes');
  } else if (process.platform === 'win32') {
    for (let code = 'D'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
      roots.push(`${String.fromCharCode(code)}:\\`);
    }
  } else {
    roots.push('/media', `/media/${user}`, '/run/media', `/run/media/${user}`, '/mnt');
  }
  return [...roots, ...extra.map((p) => path.resolve(p))];
}

const SKIP_DIRS = new Set([
  'System Volume Information',
  '$RECYCLE.BIN',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  'node_modules',
  'lost+found',
]);

/**
 * Breadth-first hunt for a library carrying `volumeId`.
 *
 * Bounded on purpose: three levels below a mount root and a hard ceiling on
 * directories visited. A removable drive's library sits at `/Volumes/SSD` or
 * `/Volumes/SSD/Photos` in practice, and an unbounded walk of a plugged-in
 * archive drive would be both slow and pointless.
 */
export async function discoverLibrary(volumeId, { extraRoots = [], maxDepth = 3, maxDirs = 3000 } = {}) {
  const queue = [];
  for (const root of mountRoots(extraRoots)) {
    queue.push({ dir: root, depth: 0 });
  }

  let visited = 0;
  while (queue.length > 0 && visited < maxDirs) {
    const { dir, depth } = queue.shift();
    visited += 1;

    const marker = await readMarker(dir);
    if (marker) {
      // Found *a* library. Only stop if it is the one we were paired with;
      // otherwise don't descend into it — libraries do not nest.
      if (marker.id === volumeId) return { path: dir, marker };
      continue;
    }
    if (depth >= maxDepth) continue;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // Not mounted, not readable, not a directory: all uninteresting.
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      // Hidden directories are skipped except at depth 0, where a library may
      // legitimately live in a dotted folder the user chose.
      if (entry.name.startsWith('.') && depth > 0) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return null;
}

/**
 * Locate the paired library: last known path first (the overwhelmingly common
 * case, and a single stat), falling back to a scan of the mount roots.
 */
export async function locateLibrary(volume, { extraRoots = [] } = {}) {
  if (!volume?.id) return null;

  if (volume.lastPath) {
    const marker = await readMarker(volume.lastPath);
    if (marker?.id === volume.id) return { path: path.resolve(volume.lastPath), marker };
  }
  return discoverLibrary(volume.id, { extraRoots });
}

/**
 * Polls for the paired drive and emits `mounted` / `unmounted` as it comes and
 * goes. Polling rather than watching is intentional: fs.watch does not report
 * volume arrival consistently across platforms, and a stat every few seconds
 * costs nothing next to being wrong about whether the library is available.
 */
export class VolumeWatcher extends EventEmitter {
  constructor({ getVolume, getExtraRoots = () => [], intervalMs = 4000 }) {
    super();
    this.getVolume = getVolume;
    this.getExtraRoots = getExtraRoots;
    this.intervalMs = intervalMs;
    this.current = null; // { path, marker } when mounted
    this.timer = null;
    this.checking = false;
    this.stopped = true;
  }

  get mounted() {
    return this.current !== null;
  }

  get libraryPath() {
    return this.current?.path ?? null;
  }

  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.check().catch((err) => this.emit('error', err));
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Forget the current mount without emitting `unmounted`. For the case where
   * the caller is unpairing deliberately and has already torn down whatever
   * the event would have cleaned up.
   */
  reset() {
    this.current = null;
  }

  /**
   * One presence check. Overlapping calls collapse into the in-flight one so a
   * slow filesystem (a spinning-up drive, a stalled USB bus) cannot pile up
   * checks behind each other.
   */
  async check() {
    if (this.checking) return this.current;
    this.checking = true;
    try {
      const volume = this.getVolume();
      if (!volume?.id) {
        if (this.current) this.transition(null);
        return null;
      }

      // Fast path: confirm the library we are already using is still there.
      if (this.current) {
        const stillThere = await readMarker(this.current.path);
        if (stillThere?.id === volume.id) return this.current;
      }

      const found = await locateLibrary(
        { ...volume, lastPath: this.current?.path ?? volume.lastPath },
        { extraRoots: this.getExtraRoots() },
      );

      if (found && this.current && found.path === this.current.path) return this.current;
      if (!found && !this.current) return null;
      this.transition(found);
      return this.current;
    } finally {
      this.checking = false;
    }
  }

  transition(found) {
    const previous = this.current;
    this.current = found;
    if (previous && (!found || found.path !== previous.path)) {
      this.emit('unmounted', previous);
    }
    if (found && (!previous || found.path !== previous.path)) {
      this.emit('mounted', found);
    }
  }
}

/** Best-effort free space on the volume holding `dir`, in bytes. */
export function freeSpace(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return { free: stats.bfree * stats.bsize, total: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
}
