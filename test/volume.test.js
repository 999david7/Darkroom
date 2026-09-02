import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import {
  discoverLibrary, initLibrary, locateLibrary, MARKER_FILENAME, readMarker, VolumeWatcher,
} from '../src/volume.js';
import { cleanup, tempDir } from './helpers.js';

after(cleanup);

describe('library markers', () => {
  test('init creates a marker and an internal directory', async () => {
    const drive = await tempDir();
    const library = path.join(drive, 'Photos');
    const result = await initLibrary(library, 'Archive SSD');

    assert.equal(result.adopted, false);
    assert.equal(result.label, 'Archive SSD');
    assert.match(result.id, /^[0-9a-f-]{36}$/);

    const marker = await readMarker(library);
    assert.equal(marker.id, result.id);
    assert.ok(await fsp.stat(path.join(library, '.darkroom')));
  });

  test('init on an existing library adopts it instead of replacing the id', async () => {
    const drive = await tempDir();
    const first = await initLibrary(drive, 'One');
    const second = await initLibrary(drive, 'Two');

    assert.equal(second.adopted, true);
    assert.equal(second.id, first.id, 'adopting must not mint a new identity');
    assert.equal(second.label, 'One');
  });

  test('a malformed or foreign marker reads as no library', async () => {
    const drive = await tempDir();
    await fsp.writeFile(path.join(drive, MARKER_FILENAME), 'not json at all');
    assert.equal(await readMarker(drive), null);

    await fsp.writeFile(path.join(drive, MARKER_FILENAME), JSON.stringify({ hello: 'world' }));
    assert.equal(await readMarker(drive), null);

    assert.equal(await readMarker(path.join(drive, 'nope')), null);
  });
});

describe('discovery', () => {
  test('finds a library nested under a mount root', async () => {
    const mount = await tempDir();
    const library = path.join(mount, 'MyDrive', 'Pictures');
    const { id } = await initLibrary(library, 'Nested');

    const found = await discoverLibrary(id, { extraRoots: [mount] });
    assert.equal(found?.path, library);
  });

  test('ignores a different drive that also holds a library', async () => {
    const mount = await tempDir();
    await initLibrary(path.join(mount, 'OtherDrive'), 'Someone else');
    const mine = await initLibrary(path.join(mount, 'MyDrive'), 'Mine');

    const found = await discoverLibrary(mine.id, { extraRoots: [mount] });
    assert.equal(found?.path, path.join(mount, 'MyDrive'));

    assert.equal(await discoverLibrary('00000000-0000-0000-0000-000000000000', { extraRoots: [mount] }), null);
  });

  test('respects the depth limit', async () => {
    const mount = await tempDir();
    const deep = path.join(mount, 'a', 'b', 'c', 'd', 'e');
    const { id } = await initLibrary(deep, 'Too deep');
    assert.equal(await discoverLibrary(id, { extraRoots: [mount], maxDepth: 2 }), null);
    assert.ok(await discoverLibrary(id, { extraRoots: [mount], maxDepth: 6 }));
  });
});

describe('locateLibrary', () => {
  test('prefers the remembered path', async () => {
    const drive = await tempDir();
    const { id } = await initLibrary(drive, 'Remembered');
    const found = await locateLibrary({ id, lastPath: drive });
    assert.equal(found.path, path.resolve(drive));
  });

  test('a remembered path holding someone else’s library does not count', async () => {
    const a = await tempDir();
    const b = await tempDir();
    const mine = await initLibrary(a, 'Mine');
    await initLibrary(b, 'Theirs');

    // The OS mounted a different drive where ours used to be.
    const found = await locateLibrary({ id: mine.id, lastPath: b });
    assert.equal(found, null);
  });
});

describe('VolumeWatcher', () => {
  test('emits mounted and unmounted as the marker appears and disappears', async () => {
    const drive = await tempDir();
    const { id } = await initLibrary(drive, 'Hotplug');

    const events = [];
    const watcher = new VolumeWatcher({
      getVolume: () => ({ id, lastPath: drive }),
      intervalMs: 10_000, // Driven manually; no timers in the test.
    });
    watcher.on('mounted', () => events.push('mounted'));
    watcher.on('unmounted', () => events.push('unmounted'));

    await watcher.check();
    assert.deepEqual(events, ['mounted']);
    assert.equal(watcher.mounted, true);

    // Simulate the drive being yanked.
    await fsp.rm(path.join(drive, MARKER_FILENAME));
    await watcher.check();
    assert.deepEqual(events, ['mounted', 'unmounted']);
    assert.equal(watcher.mounted, false);
    assert.equal(watcher.libraryPath, null);

    // And plugged back in.
    await initLibrary(drive, 'Hotplug');
    // A fresh init after deletion mints a new id, so the old pairing stays
    // locked — which is the correct, if inconvenient, behaviour.
    await watcher.check();
    assert.deepEqual(events, ['mounted', 'unmounted']);
  });

  test('overlapping checks collapse into one', async () => {
    const drive = await tempDir();
    const { id } = await initLibrary(drive, 'Busy');
    const watcher = new VolumeWatcher({ getVolume: () => ({ id, lastPath: drive }) });

    const [a, b, c] = await Promise.all([watcher.check(), watcher.check(), watcher.check()]);
    assert.ok(a);
    // The later two either returned the in-flight result or null; neither may
    // have started a second scan, which the null return signals.
    for (const result of [b, c]) assert.ok(result === null || result.path === a.path);
  });

  test('reports nothing when no volume is paired', async () => {
    const watcher = new VolumeWatcher({ getVolume: () => null });
    assert.equal(await watcher.check(), null);
    assert.equal(watcher.mounted, false);
  });
});
