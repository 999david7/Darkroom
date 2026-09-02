import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig, saveConfig } from './config.js';
import { JobManager, publicView } from './jobs.js';
import { Library } from './library.js';
import { pruneMissing, scanLibrary, verifyLibrary } from './scanner.js';
import { normaliseSource, syncSources } from './sync.js';
import { cacheStats, clearCache, ensureThumb, isValidSize } from './thumbs.js';
import { freeSpace, initLibrary, mountRoots, readMarker, VolumeWatcher } from './volume.js';
import { mapPool } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg', '.jfif': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.avif': 'image/avif',
  '.heic': 'image/heic', '.heif': 'image/heif',
};

/** Hosts allowed in the Host header. Anything else is a rebinding attempt. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function fail(res, status, message) {
  res.status(status).json({ error: message });
}

/** Wrap an async handler so a rejected promise becomes a 4xx/5xx, not a hang. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export function createServer({ config = loadConfig() } = {}) {
  const state = {
    config,
    library: null,
    jobs: new JobManager(),
    // Thumbnail rendering is CPU-bound; without a gate, opening a folder of a
    // thousand photos would start a thousand decodes at once.
    renderSlots: 4,
    renderQueue: [],
  };

  const watcher = new VolumeWatcher({
    getVolume: () => state.config.volume,
    getExtraRoots: () => state.config.extraMountRoots ?? [],
    intervalMs: state.config.watch?.intervalMs ?? 4000,
  });

  watcher.on('mounted', ({ path: libraryPath, marker }) => {
    try {
      state.library = new Library(libraryPath, marker);
    } catch (err) {
      state.library = null;
      console.error(`[darkroom] could not open the library at ${libraryPath}: ${err.message}`);
      return;
    }
    // Remember where it turned up, so next time is a single stat.
    state.config = saveConfig({
      ...state.config,
      volume: { ...state.config.volume, label: marker.label, lastPath: libraryPath },
    });
    console.log(`[darkroom] library unlocked at ${libraryPath}`);
    if (state.config.scanOnUnlock) startScan(state);
  });

  watcher.on('unmounted', ({ path: libraryPath }) => {
    console.log(`[darkroom] library at ${libraryPath} went away — locking`);
    // Cancel first: a job mid-write against a yanked drive throws EIO, and
    // there is nothing useful it can do once the files are gone.
    state.jobs.cancelAll();
    state.library?.close();
    state.library = null;
  });

  watcher.on('error', (err) => console.error(`[darkroom] volume watcher: ${err.message}`));

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // --- guards ---------------------------------------------------------------

  app.use((req, res, next) => {
    // A page on the open internet can point a <script> or <img> at
    // 127.0.0.1, and DNS rebinding can get around the browser's origin rules.
    // Pinning the Host header closes that off.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!LOCAL_HOSTS.has(host) && host !== (state.config.server?.host ?? '').toLowerCase()) {
      return fail(res, 403, 'unexpected Host header');
    }
    // Everything is served from this origin; nothing is fetched from anywhere.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; " +
        "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return next();
  });

  app.use(express.json({ limit: '64kb' }));

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /**
   * The lock. Every route that could reveal something about the photos sits
   * behind it, image bytes and metadata alike — a library you can still browse
   * the filenames of with the drive unplugged is not locked.
   */
  const gate = (req, res, next) => {
    if (!state.library) {
      return fail(res, 423, state.config.volume ? 'the library drive is not connected' : 'no library has been set up yet');
    }
    return next();
  };

  // --- status and setup -----------------------------------------------------

  app.get('/api/status', wrap(async (req, res) => {
    const volume = state.config.volume;
    const space = state.library ? freeSpace(state.library.path) : null;
    res.json({
      configured: Boolean(volume),
      locked: !state.library,
      platform: process.platform,
      volume: volume
        ? {
            label: volume.label ?? 'Darkroom library',
            lastPath: volume.lastPath ?? null,
            path: state.library?.path ?? null,
            free: space?.free ?? null,
            total: space?.total ?? null,
          }
        : null,
      library: state.library ? state.library.stats() : null,
      jobs: state.jobs.list().slice(0, 5),
      settings: {
        scanOnUnlock: state.config.scanOnUnlock,
        sources: state.config.sync?.sources ?? [],
        watchIntervalMs: state.config.watch?.intervalMs,
      },
    });
  }));

  app.post('/api/volume/init', wrap(async (req, res) => {
    const target = String(req.body?.path ?? '').trim();
    if (!target) return fail(res, 400, 'a folder path is required');
    if (!path.isAbsolute(target)) return fail(res, 400, 'the path must be absolute');

    const result = await initLibrary(target, req.body?.label);
    state.config = saveConfig({
      ...state.config,
      volume: { id: result.id, label: result.label, lastPath: result.path },
    });
    await watcher.check();
    return res.json({ ok: true, adopted: result.adopted, label: result.label, path: result.path });
  }));

  app.post('/api/volume/attach', wrap(async (req, res) => {
    const target = String(req.body?.path ?? '').trim();
    if (!target) return fail(res, 400, 'a folder path is required');
    const marker = await readMarker(target);
    if (!marker) return fail(res, 404, 'no Darkroom library found in that folder');

    state.config = saveConfig({
      ...state.config,
      volume: { id: marker.id, label: marker.label, lastPath: path.resolve(target) },
    });
    await watcher.check();
    return res.json({ ok: true, label: marker.label, path: path.resolve(target) });
  }));

  app.post('/api/volume/forget', wrap(async (req, res) => {
    state.jobs.cancelAll();
    state.library?.close();
    state.library = null;
    watcher.reset();
    state.config = saveConfig({ ...state.config, volume: null });
    res.json({ ok: true });
  }));

  app.post('/api/volume/recheck', wrap(async (req, res) => {
    await watcher.check();
    res.json({ ok: true, locked: !state.library });
  }));

  /**
   * Directory listing for the setup screen's folder picker. Deliberately
   * limited to directory names — it never reveals file contents, and it is the
   * only route that reads outside the library.
   */
  /**
   * Where to start looking. An external drive is the point of the exercise, so
   * the picker opens on the first mount root that actually has something in it
   * rather than on the home folder, which is never the answer.
   */
  const pickerShortcuts = async () => {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    const candidates = [
      ...(home ? [{ name: 'Home', path: path.resolve(home) }] : []),
      ...mountRoots(state.config.extraMountRoots ?? []).map((root) => ({
        name: path.basename(root) || root,
        path: root,
      })),
    ];
    const usable = [];
    for (const candidate of candidates) {
      const entries = await fsp.readdir(candidate.path).catch(() => null);
      if (entries) usable.push({ ...candidate, populated: entries.length > 0 });
    }
    return usable;
  };

  app.get('/api/browse', wrap(async (req, res) => {
    const target = req.query.path ? String(req.query.path) : null;
    const shortcuts = await pickerShortcuts();
    const fallback =
      shortcuts.find((entry) => entry.name !== 'Home' && entry.populated)?.path ??
      shortcuts[0]?.path ??
      '/';
    const dir = target && path.isAbsolute(target) ? path.resolve(target) : fallback;
    let entries = [];
    try {
      entries = (await fsp.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .slice(0, 500);
    } catch (err) {
      return fail(res, err.code === 'ENOENT' ? 404 : 403, `cannot read ${dir}`);
    }
    const parent = path.dirname(dir);
    return res.json({
      path: dir,
      parent: parent === dir ? null : parent,
      entries,
      shortcuts: shortcuts.map(({ name, path: at }) => ({ name, path: at })),
    });
  }));

  app.get('/api/config', wrap(async (req, res) => {
    res.json({
      server: state.config.server,
      watch: state.config.watch,
      sync: state.config.sync,
      scanOnUnlock: state.config.scanOnUnlock,
      extraMountRoots: state.config.extraMountRoots,
    });
  }));

  app.patch('/api/config', wrap(async (req, res) => {
    const next = { ...state.config };
    const body = req.body ?? {};

    if (body.sync?.sources !== undefined) {
      if (!Array.isArray(body.sync.sources)) return fail(res, 400, 'sync.sources must be an array');
      next.sync = { ...next.sync, sources: body.sync.sources.map(normaliseSource) };
    }
    if (body.scanOnUnlock !== undefined) next.scanOnUnlock = Boolean(body.scanOnUnlock);
    if (body.extraMountRoots !== undefined) {
      if (!Array.isArray(body.extraMountRoots)) return fail(res, 400, 'extraMountRoots must be an array');
      next.extraMountRoots = body.extraMountRoots.map((p) => path.resolve(String(p)));
    }
    if (body.watch?.intervalMs !== undefined) {
      const ms = Number(body.watch.intervalMs);
      if (!Number.isFinite(ms) || ms < 1000 || ms > 120000) {
        return fail(res, 400, 'watch interval must be between 1000 and 120000 ms');
      }
      next.watch = { ...next.watch, intervalMs: ms };
      watcher.intervalMs = ms;
      watcher.stop();
      watcher.start();
    }

    state.config = saveConfig(next);
    return res.json({ ok: true, config: { sync: state.config.sync, scanOnUnlock: state.config.scanOnUnlock, watch: state.config.watch, extraMountRoots: state.config.extraMountRoots } });
  }));

  // --- folders --------------------------------------------------------------

  app.get('/api/folders', gate, wrap(async (req, res) => {
    res.json({ tree: state.library.folderTree() });
  }));

  app.get('/api/folder', gate, wrap(async (req, res) => {
    const relPath = String(req.query.path ?? '');
    const folder = state.library.getFolder(relPath);
    if (!folder) return fail(res, 404, 'folder not found');
    return res.json({ folder });
  }));

  app.post('/api/folders', gate, wrap(async (req, res) => {
    const parent = String(req.body?.parent ?? '');
    const folder = await state.library.createFolder(parent, String(req.body?.name ?? ''));
    res.status(201).json({ folder });
  }));

  app.patch('/api/folders', gate, wrap(async (req, res) => {
    const relPath = String(req.body?.path ?? '');
    let folder = state.library.getFolder(relPath);
    if (!folder) return fail(res, 404, 'folder not found');

    if (req.body?.name !== undefined) {
      folder = await state.library.renameFolder(relPath, String(req.body.name));
    }
    if (req.body?.description !== undefined || req.body?.coverPhotoId !== undefined) {
      folder = state.library.updateFolder(folder.rel_path, {
        description: req.body.description,
        coverPhotoId: req.body.coverPhotoId,
      });
    }
    return res.json({ folder });
  }));

  // --- photos ---------------------------------------------------------------

  app.get('/api/photos', gate, wrap(async (req, res) => {
    const { folder = '', recursive, q, favorite, sort, limit, offset } = req.query;
    res.json(
      state.library.listPhotos({
        folder: String(folder),
        recursive: recursive === '1' || recursive === 'true',
        q: q ? String(q).slice(0, 200) : '',
        favorite: favorite === '1' || favorite === 'true',
        sort: sort ? String(sort) : 'taken_desc',
        limit,
        offset,
      }),
    );
  }));

  app.get('/api/photos/:id', gate, wrap(async (req, res) => {
    const photo = state.library.getPhoto(req.params.id);
    if (!photo) return fail(res, 404, 'photo not found');
    return res.json({ photo });
  }));

  app.patch('/api/photos/:id', gate, wrap(async (req, res) => {
    res.json({ photo: state.library.updatePhoto(req.params.id, req.body ?? {}) });
  }));

  app.delete('/api/photos/:id', gate, wrap(async (req, res) => {
    res.json(await state.library.deletePhoto(req.params.id));
  }));

  /**
   * Rendered bytes.
   *
   * `no-store` on every image response, and it is not an oversight: a browser
   * disk cache full of thumbnails on the internal drive would quietly undo the
   * thing this app is for. Photos stay on the SSD; the browser keeps them in
   * memory for as long as the tab shows them and no longer.
   */
  const sendImage = (res, absPath, contentType) =>
    new Promise((resolve, reject) => {
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.sendFile(absPath, { dotfiles: 'allow', acceptRanges: true }, (err) =>
        err ? reject(err) : resolve(),
      );
    });

  /** Bounded thumbnail rendering, so a big folder cannot swamp the CPU. */
  const renderLimited = (task) =>
    new Promise((resolve, reject) => {
      const run = () => {
        state.renderSlots -= 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            state.renderSlots += 1;
            state.renderQueue.shift()?.();
          });
      };
      if (state.renderSlots > 0) run();
      else state.renderQueue.push(run);
    });

  const serveRendered = (size) => wrap(async (req, res) => {
    if (!isValidSize(size)) return fail(res, 400, 'unknown size');

    const photo = state.library.getPhoto(req.params.id);
    if (!photo) return fail(res, 404, 'photo not found');
    if (!photo.hash) return fail(res, 409, 'photo has not been indexed yet');

    const library = state.library;
    const file = await renderLimited(() =>
      ensureThumb(library.path, { absPath: library.absPathOf(photo), hash: photo.hash, size }),
    );

    if (!file) {
      // Record the failure so the grid can draw a placeholder immediately next
      // time instead of re-attempting a decode that will not work.
      if (state.library === library && photo.thumb_state !== 'unsupported') {
        library.db.prepare("UPDATE photos SET thumb_state = 'unsupported' WHERE id = ?").run(photo.id);
      }
      return fail(res, 415, 'this file cannot be displayed');
    }
    if (state.library === library && photo.thumb_state !== 'ready') {
      library.db.prepare("UPDATE photos SET thumb_state = 'ready' WHERE id = ?").run(photo.id);
    }
    return sendImage(res, file, 'image/webp');
  });

  app.get('/api/photos/:id/thumb', gate, serveRendered('thumb'));
  app.get('/api/photos/:id/preview', gate, serveRendered('preview'));

  app.get('/api/photos/:id/original', gate, wrap(async (req, res) => {
    const photo = state.library.getPhoto(req.params.id);
    if (!photo) return fail(res, 404, 'photo not found');
    const abs = state.library.absPathOf(photo);
    const type = CONTENT_TYPES[photo.ext] ?? 'application/octet-stream';
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(photo.filename)}"`);
    }
    return sendImage(res, abs, type);
  }));

  // --- jobs -----------------------------------------------------------------

  function startScan(current = state) {
    if (!current.library) return null;
    const library = current.library;
    return current.jobs.start('scan', ({ onProgress, signal }) =>
      scanLibrary(library, { onProgress, signal }),
    );
  }

  app.post('/api/jobs/scan', gate, wrap(async (req, res) => {
    res.json({ job: publicView(startScan()) });
  }));

  app.post('/api/jobs/sync', gate, wrap(async (req, res) => {
    const sources = req.body?.sources ?? state.config.sync?.sources ?? [];
    if (!Array.isArray(sources) || sources.length === 0) {
      return fail(res, 400, 'no sync sources are configured');
    }
    const library = state.library;
    const job = state.jobs.start('sync', async ({ onProgress, signal }) => {
      const result = await syncSources(library, sources, { onProgress, signal });
      // Fold anything that arrived outside the copy loop into the index too.
      await scanLibrary(library, { onProgress, signal });
      return result;
    });
    return res.json({ job: publicView(job) });
  }));

  app.post('/api/jobs/verify', gate, wrap(async (req, res) => {
    const library = state.library;
    const job = state.jobs.start('verify', ({ onProgress, signal }) =>
      verifyLibrary(library, { onProgress, signal }),
    );
    res.json({ job: publicView(job) });
  }));

  /** Pre-render every thumbnail that has not been made yet. */
  app.post('/api/jobs/thumbs', gate, wrap(async (req, res) => {
    const library = state.library;
    const job = state.jobs.start('thumbs', async ({ onProgress, signal }) => {
      const rows = library.db
        .prepare("SELECT id, rel_path, hash FROM photos WHERE missing = 0 AND thumb_state = 'pending'")
        .all();
      let processed = 0;
      let failed = 0;
      await mapPool(rows, 4, async (row) => {
        if (signal.aborted) return;
        const file = await ensureThumb(library.path, {
          absPath: library.absPathOf(row),
          hash: row.hash,
          size: 'thumb',
        });
        library.db
          .prepare('UPDATE photos SET thumb_state = ? WHERE id = ?')
          .run(file ? 'ready' : 'unsupported', row.id);
        if (!file) failed += 1;
        processed += 1;
        onProgress({ phase: 'rendering', processed, total: rows.length, current: row.rel_path });
      });
      return { rendered: processed - failed, undecodable: failed, total: rows.length };
    });
    res.json({ job: publicView(job) });
  }));

  app.post('/api/jobs/prune', gate, wrap(async (req, res) => {
    res.json(pruneMissing(state.library));
  }));

  app.get('/api/jobs', gate, wrap(async (req, res) => {
    res.json({ jobs: state.jobs.list() });
  }));

  app.get('/api/jobs/:id', gate, wrap(async (req, res) => {
    const job = state.jobs.get(req.params.id);
    if (!job) return fail(res, 404, 'job not found');
    return res.json({ job: publicView(job) });
  }));

  app.post('/api/jobs/:id/cancel', gate, wrap(async (req, res) => {
    res.json({ ok: state.jobs.cancel(req.params.id) });
  }));

  // --- cache ----------------------------------------------------------------

  app.get('/api/cache', gate, wrap(async (req, res) => {
    res.json(await cacheStats(state.library.path));
  }));

  app.delete('/api/cache', gate, wrap(async (req, res) => {
    await clearCache(state.library.path);
    state.library.db.prepare("UPDATE photos SET thumb_state = 'pending' WHERE thumb_state = 'ready'").run();
    res.json({ ok: true });
  }));

  // --- static ---------------------------------------------------------------

  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      dotfiles: 'ignore',
      // The UI is small and served from disk; revalidating keeps a rebuilt
      // client from being shadowed by a stale cached copy.
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );

  app.use('/api', (req, res) => fail(res, 404, 'no such endpoint'));
  app.use((req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  app.use((err, req, res, next) => {
    // A file transfer that dies partway — the drive pulled mid-download, the
    // browser navigating away — lands here with the response already open.
    // Express's own handler knows to close the socket; ours cannot.
    if (res.headersSent) return next(err);
    const status = err.status ?? (err.code === 'ENOENT' ? 404 : 500);
    if (status >= 500) console.error('[darkroom]', err);
    return res.status(status).json({ error: err.message ?? 'something went wrong' });
  });

  return { app, state, watcher, startScan };
}

export async function startServer(options = {}) {
  const { app, state, watcher } = createServer(options);
  const { host = '127.0.0.1', port = 4600 } = state.config.server ?? {};

  await watcher.check();
  watcher.start();

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.on('error', reject);
  });

  return {
    app,
    state,
    watcher,
    server,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}`,
    async close() {
      watcher.stop();
      state.jobs.cancelAll();
      state.library?.close();
      state.library = null;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
