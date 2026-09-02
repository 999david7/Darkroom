import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { cacheDir } from './db.js';
import { renderableSource } from './media.js';

/**
 * Derived images.
 *
 * The cache lives on the SSD alongside the originals, not in a system cache
 * directory. Anything else would defeat the premise — a locked library that
 * still had a folder of readable thumbnails on the internal disk would be
 * showing you your photos with the drive unplugged.
 *
 * Cache keys are content hashes, so two copies of the same photo share one
 * thumbnail and an edited file naturally misses the cache instead of serving a
 * stale rendering.
 */

export const SIZES = {
  thumb: { edge: 480, quality: 72 },
  preview: { edge: 2048, quality: 82 },
};

export function isValidSize(size) {
  return Object.hasOwn(SIZES, size);
}

export function thumbPath(libraryPath, hash, size) {
  if (!isValidSize(size)) throw new Error(`unknown thumbnail size: ${size}`);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('cache key must be a sha256 hex digest');
  // Two-character fan-out keeps directories small enough for filesystems that
  // slow down with tens of thousands of entries (exFAT very much among them).
  return path.join(cacheDir(libraryPath), size, hash.slice(0, 2), `${hash}.webp`);
}

/**
 * Render `size` for a photo, reusing the cached file when it exists.
 *
 * Returns the cache path, or null when the photo cannot be decoded at all —
 * a RAW file with no sidecar, an unsupported codec, a truncated download. The
 * caller turns that into a placeholder tile.
 */
export async function ensureThumb(libraryPath, { absPath, hash, size = 'thumb' }) {
  const target = thumbPath(libraryPath, hash, size);
  try {
    const stat = await fsp.stat(target);
    if (stat.size > 0) return target;
  } catch {
    // Not cached yet.
  }

  const source = await renderableSource(absPath);
  if (!source) return null;

  const { edge, quality } = SIZES[size];
  await fsp.mkdir(path.dirname(target), { recursive: true });

  // Render to a unique temp name and rename into place, so two requests racing
  // for the same uncached thumbnail cannot serve each other a partial file.
  const tmp = `${target}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await sharp(source, { failOn: 'none' })
      .rotate() // Bake in EXIF orientation; browsers cannot be trusted to.
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toFile(tmp);
    await fsp.rename(tmp, target);
    return target;
  } catch {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return null;
  }
}

/** Drop every cached rendering of one photo. Used when a file changes on disk. */
export async function dropThumbs(libraryPath, hash) {
  if (!hash) return;
  await Promise.all(
    Object.keys(SIZES).map((size) =>
      fsp.rm(thumbPath(libraryPath, hash, size), { force: true }).catch(() => {}),
    ),
  );
}

/**
 * Cache size on disk, for the settings screen. Walks the cache tree, which is
 * cheap enough to do on demand and avoids keeping a running total that could
 * drift out of sync with reality.
 */
export async function cacheStats(libraryPath) {
  let files = 0;
  let bytes = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.webp')) {
        files += 1;
        const stat = await fsp.stat(full).catch(() => null);
        if (stat) bytes += stat.size;
      }
    }
  };
  await walk(cacheDir(libraryPath));
  return { files, bytes };
}

export async function clearCache(libraryPath) {
  await fsp.rm(cacheDir(libraryPath), { recursive: true, force: true });
}
