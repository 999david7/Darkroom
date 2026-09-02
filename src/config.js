import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The local configuration file is deliberately the *only* thing Darkroom
 * writes to the computer's internal disk. It holds no photos, no thumbnails
 * and no metadata about them — just which drive to look for and where it was
 * last seen. Lose it and you lose nothing but the pairing; the library on the
 * SSD is entirely self-describing.
 */

const DEFAULTS = {
  version: 1,
  // The paired external volume. `id` is matched against the marker file at the
  // library root, so the library keeps working when the OS mounts the drive at
  // a different path (or letter) than last time.
  volume: null, // { id, label, lastPath }
  server: {
    host: '127.0.0.1',
    port: 4600,
  },
  watch: {
    // How often to look for the drive. Cheap: a handful of stat() calls.
    intervalMs: 4000,
  },
  // Directories to import from when you run a sync. Copy-only, never touched
  // destructively.
  sync: {
    sources: [], // [{ path, into, organizeBy: 'date' | 'mirror' | 'flat' }]
  },
  // Re-index the library automatically whenever the drive is plugged in.
  scanOnUnlock: true,
  // Additional places to look for the drive, if your system mounts removable
  // media somewhere unusual.
  extraMountRoots: [],
};

export function configHome() {
  if (process.env.DARKROOM_HOME) return path.resolve(process.env.DARKROOM_HOME);
  return path.join(os.homedir(), '.darkroom');
}

export function configPath() {
  return path.join(configHome(), 'config.json');
}

function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return override;
  if (typeof override !== 'object' || Array.isArray(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

export function loadConfig() {
  const file = configPath();
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`could not read ${file}: ${err.message}`);
    }
  }
  const config = deepMerge(structuredClone(DEFAULTS), stored);
  if (process.env.DARKROOM_PORT) config.server.port = Number(process.env.DARKROOM_PORT);
  if (process.env.DARKROOM_HOST) config.server.host = process.env.DARKROOM_HOST;
  return config;
}

export function saveConfig(config) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a truncated config.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return config;
}

export function updateConfig(mutate) {
  const config = loadConfig();
  const next = mutate(config) ?? config;
  return saveConfig(next);
}

export { DEFAULTS };
