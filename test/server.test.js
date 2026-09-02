import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { initLibrary, MARKER_FILENAME } from '../src/volume.js';
import { cleanup, isolateConfig, tempDir, writeImage } from './helpers.js';

await isolateConfig();

let instance;
let drive;
let libraryPath;

/** Routes that must not answer while the drive is away. */
const GATED = [
  '/api/folders',
  '/api/folder?path=',
  '/api/photos',
  '/api/photos/1',
  '/api/photos/1/thumb',
  '/api/photos/1/preview',
  '/api/photos/1/original',
  '/api/jobs',
  '/api/cache',
];

const url = (suffix) => `${instance.url}${suffix}`;
const get = (suffix, init) => fetch(url(suffix), init);
const post = (suffix, body) =>
  fetch(url(suffix), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

before(async () => {
  drive = await tempDir();
  libraryPath = path.join(drive, 'Photos');
  await initLibrary(libraryPath, 'Test drive');
  await writeImage(path.join(libraryPath, 'Trips', 'Iceland', 'a.jpg'), { width: 300, height: 200 });
  await writeImage(path.join(libraryPath, 'Trips', 'b.jpg'));

  const config = loadConfig();
  config.server = { host: '127.0.0.1', port: 0 };
  config.scanOnUnlock = false;
  instance = await startServer({ config });
});

after(async () => {
  await instance?.close();
  await cleanup();
});

describe('before a library is paired', () => {
  test('status says so and every photo route is closed', async () => {
    const status = await (await get('/api/status')).json();
    assert.equal(status.configured, false);
    assert.equal(status.locked, true);
    assert.equal(status.library, null);

    for (const route of GATED) {
      const response = await get(route);
      assert.equal(response.status, 423, route);
    }
  });

  test('the interface itself still loads, so it can show the setup screen', async () => {
    const response = await get('/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Darkroom/);
  });
});

describe('pairing and unlocking', () => {
  test('attaching an existing library unlocks it', async () => {
    const response = await post('/api/volume/attach', { path: libraryPath });
    assert.equal(response.status, 200);

    const status = await (await get('/api/status')).json();
    assert.equal(status.configured, true);
    assert.equal(status.locked, false);
    assert.equal(status.volume.label, 'Test drive');
    assert.equal(status.volume.path, libraryPath);
  });

  test('attaching a folder with no library is refused', async () => {
    const response = await post('/api/volume/attach', { path: drive });
    assert.equal(response.status, 404);
  });

  test('a scan indexes what is on the drive', async () => {
    const { job } = await (await post('/api/jobs/scan')).json();
    let finished;
    for (let i = 0; i < 100; i += 1) {
      finished = (await (await get(`/api/jobs/${job.id}`)).json()).job;
      if (finished.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(finished.status, 'done', finished.error ?? '');
    assert.equal(finished.result.added, 2);
  });

  test('photos and folders are listable', async () => {
    const photos = await (await get('/api/photos?folder=&recursive=1')).json();
    assert.equal(photos.total, 2);

    const { tree } = await (await get('/api/folders')).json();
    assert.equal(tree.count, 2);
    assert.equal(tree.children[0].name, 'Trips');
    assert.equal(tree.children[0].children[0].name, 'Iceland');
  });
});

describe('serving images', () => {
  let photo;

  before(async () => {
    const photos = await (await get('/api/photos?folder=&recursive=1&sort=name_asc')).json();
    [photo] = photos.items;
  });

  test('thumbnails render as webp and are never written to the browser cache', async () => {
    const response = await get(`/api/photos/${photo.id}/thumb`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    // A disk cache of thumbnails on the internal drive would undo the point of
    // the whole project.
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  });

  test('previews and originals are served too', async () => {
    assert.equal((await get(`/api/photos/${photo.id}/preview`)).status, 200);
    const original = await get(`/api/photos/${photo.id}/original`);
    assert.equal(original.status, 200);
    assert.equal(original.headers.get('content-type'), 'image/jpeg');
  });

  test('an unknown photo is a 404, not a crash', async () => {
    assert.equal((await get('/api/photos/999999/thumb')).status, 404);
    assert.equal((await get('/api/photos/not-a-number')).status, 404);
  });
});

describe('editing', () => {
  test('titles, captions and favourites round-trip', async () => {
    const { items } = await (await get('/api/photos?folder=&recursive=1&sort=name_asc')).json();
    const target = items[0];

    const response = await fetch(url(`/api/photos/${target.id}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Blue hour', favorite: true }),
    });
    const { photo } = await response.json();
    assert.equal(photo.title, 'Blue hour');
    assert.equal(photo.favorite, 1);

    const favorites = await (await get('/api/photos?favorite=1&folder=&recursive=1')).json();
    assert.equal(favorites.total, 1);
  });

  test('a folder cover can be set and shows up in the tree', async () => {
    const { items } = await (await get('/api/photos?folder=Trips/Iceland')).json();
    const cover = items[0];

    const response = await fetch(url('/api/folders'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'Trips/Iceland', coverPhotoId: cover.id, description: 'Ring road' }),
    });
    assert.equal(response.status, 200);

    const { tree } = await (await get('/api/folders')).json();
    const iceland = tree.children[0].children[0];
    assert.equal(iceland.cover.id, cover.id);
    assert.equal(iceland.cover.explicit, true);
    assert.equal(iceland.description, 'Ring road');
  });

  test('a cover from another folder is rejected', async () => {
    const { items } = await (await get('/api/photos?folder=Trips')).json();
    const response = await fetch(url('/api/folders'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'Trips/Iceland', coverPhotoId: items[0].id }),
    });
    assert.equal(response.status, 400);
  });

  test('folders can be created, and bad names are refused', async () => {
    const created = await post('/api/folders', { parent: '', name: 'Work' });
    assert.equal(created.status, 201);
    assert.ok(await fsp.stat(path.join(libraryPath, 'Work')));

    for (const name of ['../escape', 'a/b', '', '.hidden', 'CON']) {
      const response = await post('/api/folders', { parent: '', name });
      assert.equal(response.status, 400, `name ${JSON.stringify(name)} should be refused`);
    }
    // And nothing was created outside the library.
    assert.equal(await fsp.stat(path.join(drive, 'escape')).catch(() => null), null);
  });
});

describe('config', () => {
  test('sync sources are validated before they are stored', async () => {
    const bad = await fetch(url('/api/config'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sync: { sources: [{ path: '/tmp/x', into: '../../etc' }] } }),
    });
    assert.equal(bad.status, 400);

    const good = await fetch(url('/api/config'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sync: { sources: [{ path: '/tmp/x', into: 'Inbox' }] } }),
    });
    assert.equal(good.status, 200);
    const { config } = await good.json();
    assert.equal(config.sync.sources[0].into, 'Inbox');
    assert.equal(config.sync.sources[0].organizeBy, 'date');
  });
});

describe('locking when the drive goes away', () => {
  test('every photo route closes again the moment the marker is gone', async () => {
    // Pulling a USB drive looks exactly like this from the filesystem's side.
    await fsp.rename(path.join(libraryPath, MARKER_FILENAME), path.join(drive, 'stashed-marker'));
    await instance.watcher.check();

    const status = await (await get('/api/status')).json();
    assert.equal(status.locked, true);
    assert.equal(status.library, null, 'no counts, no dates, nothing');

    for (const route of GATED) {
      const response = await get(route);
      assert.equal(response.status, 423, route);
    }
  });

  test('plugging it back in unlocks it again', async () => {
    await fsp.rename(path.join(drive, 'stashed-marker'), path.join(libraryPath, MARKER_FILENAME));
    await instance.watcher.check();

    const status = await (await get('/api/status')).json();
    assert.equal(status.locked, false);
    assert.equal((await (await get('/api/photos?folder=&recursive=1')).json()).total, 2);
  });
});

describe('hardening', () => {
  test('requests claiming a non-local Host are refused', async () => {
    // A page on the internet cannot read a cross-origin response, but DNS
    // rebinding can make a browser send requests here. Pinning Host stops it.
    // fetch() refuses to set Host, so this goes through the raw http client.
    const status = (host) =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: Number(new URL(instance.url).port),
            path: '/api/status',
            headers: { host },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on('error', reject);
        request.end();
      });

    assert.equal(await status('evil.example.com'), 403);
    assert.equal(await status('127.0.0.1:1234'), 200, 'a local host with any port is fine');
    assert.equal(await status('localhost'), 200);
  });

  test('a strict CSP and nosniff are set on every response', async () => {
    const response = await get('/');
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  test('the browse endpoint lists directories only, never file contents', async () => {
    await fsp.writeFile(path.join(drive, 'secret.txt'), 'do not list me');
    const listing = await (await get(`/api/browse?path=${encodeURIComponent(drive)}`)).json();
    assert.equal(listing.path, drive);
    assert.ok(listing.entries.some((entry) => entry.name === 'Photos'));
    assert.ok(!listing.entries.some((entry) => entry.name === 'secret.txt'));
  });

  test('unknown api routes are a clean 404', async () => {
    const response = await get('/api/nope');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'no such endpoint');
  });
});
