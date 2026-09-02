import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';

/**
 * Format knowledge, content hashing and metadata extraction.
 *
 * Darkroom indexes more file types than it can draw. A RAW archive is exactly
 * the kind of thing that ends up on an external SSD, and dropping those files
 * from the library because the bundled image decoder cannot read them would
 * make the index lie about what is on the drive. They are indexed, counted and
 * browsable; they simply get a placeholder tile unless a sidecar JPEG sits
 * next to them.
 */

/** Formats the bundled decoder can turn into a thumbnail. */
export const RENDERABLE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jpe', '.png', '.webp', '.gif', '.tif', '.tiff', '.avif',
  '.heic', '.heif', '.jfif',
]);

/** Camera RAW and other formats we index but do not attempt to decode. */
export const OPAQUE_EXTENSIONS = new Set([
  '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf', '.orf',
  '.rw2', '.pef', '.dng', '.raw', '.rwl', '.iiq', '.3fr', '.erf', '.mos',
  '.mrw', '.x3f', '.srw', '.gpr',
]);

export function extensionOf(filename) {
  return path.extname(filename).toLowerCase();
}

export function isRenderable(filename) {
  return RENDERABLE_EXTENSIONS.has(extensionOf(filename));
}

export function isMediaFile(filename) {
  if (filename.startsWith('.')) return false; // ._resource forks, .DS_Store, etc.
  const ext = extensionOf(filename);
  return RENDERABLE_EXTENSIONS.has(ext) || OPAQUE_EXTENSIONS.has(ext);
}

/** Streaming sha256 — identity for dedupe, rename detection and cache keys. */
export function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * A RAW file shot alongside a JPEG can borrow its sibling for display. Cameras
 * write both with the same basename, so this costs one stat per RAW file and
 * turns an unbrowsable archive into a browsable one.
 */
export async function findSidecar(absPath) {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath, path.extname(absPath));
  for (const ext of ['.jpg', '.JPG', '.jpeg', '.JPEG', '.png', '.PNG']) {
    const candidate = path.join(dir, base + ext);
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/**
 * The file to actually feed the decoder for a given photo: itself when the
 * format is renderable, otherwise a sidecar JPEG, otherwise nothing.
 */
export async function renderableSource(absPath) {
  if (isRenderable(absPath)) return absPath;
  return findSidecar(absPath);
}

function toEpoch(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function describeCamera(exif) {
  const make = typeof exif?.Make === 'string' ? exif.Make.trim() : '';
  const model = typeof exif?.Model === 'string' ? exif.Model.trim() : '';
  if (!make && !model) return null;
  // "NIKON CORPORATION" + "NIKON Z 6" should not read "NIKON CORPORATION NIKON Z 6".
  if (model && make && model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0])) {
    return model;
  }
  return [make, model].filter(Boolean).join(' ');
}

/**
 * Dimensions and capture time.
 *
 * Deliberately does not read GPS. Location is the most sensitive thing in a
 * photo's metadata and nothing in this app needs it, so it is never parsed and
 * never written to the index. The original file keeps whatever it came with —
 * Darkroom does not modify originals — but the index stays clean.
 */
export async function readMetadata(absPath, { fallbackMtime }) {
  const result = {
    width: null,
    height: null,
    orientation: null,
    takenAt: fallbackMtime ?? null,
    camera: null,
    lens: null,
  };

  const source = await renderableSource(absPath);
  if (source) {
    try {
      const meta = await sharp(source, { failOn: 'none' }).metadata();
      result.orientation = meta.orientation ?? null;
      // Orientation 5-8 mean the image is stored rotated a quarter turn.
      const swap = (meta.orientation ?? 1) >= 5;
      result.width = swap ? meta.height ?? null : meta.width ?? null;
      result.height = swap ? meta.width ?? null : meta.height ?? null;
    } catch {
      // Unreadable header. The file stays indexed with unknown dimensions.
    }
  }

  try {
    const exif = await exifr.parse(absPath, {
      tiff: true,
      ifd0: true,
      exif: true,
      gps: false,
      interop: false,
      xmp: false,
      icc: false,
      iptc: false,
      translateValues: true,
      reviveValues: true,
    });
    if (exif) {
      result.takenAt =
        toEpoch(exif.DateTimeOriginal) ??
        toEpoch(exif.CreateDate) ??
        toEpoch(exif.ModifyDate) ??
        result.takenAt;
      result.camera = describeCamera(exif);
      result.lens =
        (typeof exif.LensModel === 'string' && exif.LensModel.trim()) ||
        (typeof exif.LensMake === 'string' && exif.LensMake.trim()) ||
        null;
    }
  } catch {
    // No EXIF, or a parser that dislikes this file. The mtime fallback stands.
  }

  return result;
}
