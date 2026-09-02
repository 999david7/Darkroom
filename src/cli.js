#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { loadConfig, configPath, saveConfig } from './config.js';
import { Library } from './library.js';
import { pruneMissing, scanLibrary, verifyLibrary } from './scanner.js';
import { normaliseSource, syncSources } from './sync.js';
import { startServer } from './server.js';
import { formatBytes } from './util.js';
import { initLibrary, locateLibrary, readMarker } from './volume.js';

const USAGE = `
darkroom — a photo library that lives on your external drive

  darkroom init <folder> [--label "Archive SSD"]
      Create a library in <folder> (on the drive) and pair this computer with it.
      Pointing init at an existing library adopts it instead.

  darkroom attach <folder>
      Pair with a library that already exists, e.g. on a second computer.

  darkroom serve [--port 4600] [--host 127.0.0.1]
      Start the web interface. It stays locked until the paired drive appears.

  darkroom status          Where the drive is, and what is in the library.
  darkroom scan            Reconcile the index with the files on the drive.
  darkroom sync [folder]   Copy new photos in from your configured sources.
  darkroom verify          Re-hash every file and report anything that changed.
  darkroom prune           Forget index entries whose files are gone.
  darkroom forget          Unpair this computer. Touches nothing on the drive.

Config lives at ${configPath()} and holds nothing but the pairing.
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function die(message) {
  console.error(`darkroom: ${message}`);
  process.exit(1);
}

/** Open the paired library, or explain why we cannot. */
async function requireLibrary() {
  const config = loadConfig();
  if (!config.volume) {
    die('no library is paired with this computer yet — run `darkroom init <folder>` first');
  }
  const found = await locateLibrary(config.volume, { extraRoots: config.extraMountRoots ?? [] });
  if (!found) {
    die(`the drive holding "${config.volume.label ?? 'your library'}" is not connected`);
  }
  if (found.path !== config.volume.lastPath) {
    saveConfig({ ...config, volume: { ...config.volume, lastPath: found.path } });
  }
  return { library: new Library(found.path, found.marker), config };
}

/** Single-line progress that does not scroll the terminal into oblivion. */
function progressReporter() {
  const tty = process.stdout.isTTY;
  let last = 0;
  return ({ phase, processed, total, current }) => {
    const now = Date.now();
    if (!tty) {
      if (phase === 'done' || now - last > 5000) {
        last = now;
        console.log(`  ${phase}: ${processed}/${total || '?'}`);
      }
      return;
    }
    if (now - last < 80 && phase !== 'done') return;
    last = now;
    const name = current ? path.basename(current) : '';
    const line = `  ${phase} ${processed}${total ? `/${total}` : ''}  ${name}`;
    process.stdout.write(`\r${line.slice(0, (process.stdout.columns ?? 80) - 1).padEnd(60)}`);
    if (phase === 'done') process.stdout.write('\n');
  };
}

const commands = {
  async init({ positional, flags }) {
    const target = positional[0];
    if (!target) die('usage: darkroom init <folder>');
    const resolved = path.resolve(target);
    const result = await initLibrary(resolved, typeof flags.label === 'string' ? flags.label : undefined);

    saveConfig({
      ...loadConfig(),
      volume: { id: result.id, label: result.label, lastPath: result.path },
    });
    console.log(result.adopted ? `Adopted the library already in ${result.path}` : `Created a library in ${result.path}`);
    console.log(`  label: ${result.label}`);
    console.log(`  id:    ${result.id}`);
    console.log('\nNext: `darkroom serve`, then open the address it prints.');
  },

  async attach({ positional }) {
    const target = positional[0];
    if (!target) die('usage: darkroom attach <folder>');
    const resolved = path.resolve(target);
    const marker = await readMarker(resolved);
    if (!marker) die(`no Darkroom library found in ${resolved}`);

    saveConfig({ ...loadConfig(), volume: { id: marker.id, label: marker.label, lastPath: resolved } });
    console.log(`Paired with "${marker.label}" at ${resolved}`);
  },

  async forget() {
    const config = loadConfig();
    if (!config.volume) return console.log('Nothing is paired with this computer.');
    saveConfig({ ...config, volume: null });
    return console.log(`Unpaired from "${config.volume.label}". Nothing on the drive was changed.`);
  },

  async status() {
    const config = loadConfig();
    if (!config.volume) {
      console.log('No library paired. Run `darkroom init <folder-on-your-drive>`.');
      return;
    }
    console.log(`Library:  ${config.volume.label}`);
    console.log(`Id:       ${config.volume.id}`);

    const found = await locateLibrary(config.volume, { extraRoots: config.extraMountRoots ?? [] });
    if (!found) {
      console.log('Drive:    not connected — the library is locked');
      return;
    }
    console.log(`Drive:    connected at ${found.path}`);

    const library = new Library(found.path, found.marker);
    const stats = library.stats();
    library.close();
    console.log(`Photos:   ${stats.count} in ${stats.folders} folders (${formatBytes(stats.bytes)})`);
    if (stats.favorites) console.log(`Favorites:${String(stats.favorites).padStart(4)}`);
    if (stats.unsupported) console.log(`Undecodable (RAW etc.): ${stats.unsupported}`);
    if (stats.missing) console.log(`Missing:  ${stats.missing} — run \`darkroom scan\``);
  },

  async scan() {
    const { library } = await requireLibrary();
    console.log(`Scanning ${library.path}`);
    try {
      const report = await scanLibrary(library, { onProgress: progressReporter() });
      console.log(
        `Done: ${report.added} added, ${report.updated} updated, ${report.moved} moved, ` +
          `${report.restored} restored, ${report.missing} now missing, ${report.unchanged} unchanged.`,
      );
      if (report.failed) console.log(`${report.failed} file(s) could not be read.`);
    } finally {
      library.close();
    }
  },

  async sync({ positional, flags }) {
    const { library, config } = await requireLibrary();
    try {
      const sources = positional.length
        ? positional.map((p) => normaliseSource({
            path: p,
            into: typeof flags.into === 'string' ? flags.into : undefined,
            organizeBy: typeof flags.organize === 'string' ? flags.organize : undefined,
          }))
        : (config.sync?.sources ?? []);

      if (sources.length === 0) {
        die('no sources given and none configured — try `darkroom sync ~/Pictures`');
      }
      for (const source of sources) console.log(`Source: ${source.path} -> ${source.into}/ (${source.organizeBy})`);

      const report = await syncSources(library, sources, { onProgress: progressReporter() });
      console.log(
        `Imported ${report.imported} photo(s), ${formatBytes(report.bytes)}. ` +
          `${report.duplicates} already in the library, ${report.skipped} unchanged since last sync.`,
      );
      for (const error of report.errors) console.log(`  ! ${error.source}: ${error.error}`);
      await scanLibrary(library, { onProgress: progressReporter() });
    } finally {
      library.close();
    }
  },

  async verify() {
    const { library } = await requireLibrary();
    try {
      const report = await verifyLibrary(library, { onProgress: progressReporter() });
      console.log(`Checked ${report.checked} file(s): ${report.ok} intact.`);
      for (const item of report.changed) console.log(`  changed:    ${item.path}`);
      for (const item of report.missing) console.log(`  missing:    ${item.path}`);
      for (const item of report.unreadable) console.log(`  unreadable: ${item.path} (${item.error})`);
      if (report.changed.length + report.missing.length + report.unreadable.length === 0) {
        console.log('Everything matches the index.');
      } else {
        process.exitCode = 2;
      }
    } finally {
      library.close();
    }
  },

  async prune() {
    const { library } = await requireLibrary();
    try {
      const { pruned } = pruneMissing(library);
      console.log(`Forgot ${pruned} index entr${pruned === 1 ? 'y' : 'ies'}. No files were deleted.`);
    } finally {
      library.close();
    }
  },

  async serve({ flags }) {
    const config = loadConfig();
    if (flags.port) config.server.port = Number(flags.port);
    if (typeof flags.host === 'string') config.server.host = flags.host;

    const instance = await startServer({ config });
    console.log(`Darkroom is running at ${instance.url}`);
    if (!config.volume) {
      console.log('No library paired yet — open the address above to set one up.');
    } else if (instance.state.library) {
      console.log(`"${config.volume.label}" is connected and unlocked.`);
    } else {
      console.log(`Waiting for "${config.volume.label}" to be plugged in.`);
    }
    if (config.server.host !== '127.0.0.1' && config.server.host !== 'localhost') {
      console.log(
        `\n! Listening on ${config.server.host}, not just this machine. Darkroom has no ` +
          'login of its own, so anyone who can reach that address can see your photos.',
      );
    }

    const shutdown = async () => {
      console.log('\nStopping.');
      await instance.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  },
};

const { positional, flags } = parseArgs(process.argv.slice(2));
const name = positional.shift();

if (!name || flags.help || name === 'help') {
  console.log(USAGE);
  process.exit(name && name !== 'help' ? 1 : 0);
}

const command = commands[name];
if (!command) {
  console.error(`darkroom: unknown command "${name}"`);
  console.log(USAGE);
  process.exit(1);
}

try {
  await command({ positional, flags });
} catch (err) {
  die(err.message);
}
