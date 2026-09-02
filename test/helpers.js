import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Test fixtures.
 *
 * Every test gets its own throwaway "drive" and its own DARKROOM_HOME, so a
 * test run can never read or write the config of whoever is running it.
 */

const roots = [];

export async function tempDir(prefix = 'darkroom-test-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

export async function cleanup() {
  await Promise.all(roots.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
}

/** Point config at a scratch directory before anything reads or writes it. */
export async function isolateConfig() {
  const home = await tempDir('darkroom-home-');
  process.env.DARKROOM_HOME = home;
  return home;
}

let seed = 0;

/**
 * Write a small, real JPEG. Real rather than a stub because the scanner reads
 * actual image headers, and a fake would test the mock instead of the code.
 */
export async function writeImage(absPath, { width = 64, height = 48, tint } = {}) {
  seed += 1;
  const colour = tint ?? { r: (seed * 47) % 255, g: (seed * 83) % 255, b: (seed * 131) % 255 };
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: colour } })
    .jpeg({ quality: 80 })
    .toFile(absPath);
  return absPath;
}

/** An identical copy, byte for byte — for dedupe and rename-detection tests. */
export async function copyImage(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
  return to;
}

export async function listFiles(dir) {
  const out = [];
  const walk = async (current, prefix) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  await walk(dir, '');
  return out.sort();
}
