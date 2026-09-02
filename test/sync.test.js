import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { Library } from '../src/library.js';
import { scanLibrary } from '../src/scanner.js';
import { normaliseSource, syncSources } from '../src/sync.js';
import { initLibrary } from '../src/volume.js';
import { cleanup, copyImage, listFiles, tempDir, writeImage } from './helpers.js';

after(cleanup);

const open = [];
after(() => { for (const library of open) library.close(); });

async function makeLibrary() {
  const drive = await tempDir();
  const root = path.join(drive, 'Photos');
  const marker = await initLibrary(root, 'Test drive');
  const library = new Library(root, marker);
  open.push(library);
  return library;
}

/** A file with a known capture date, so date-organised imports are testable. */
async function writeDated(absPath, date) {
  await writeImage(absPath);
  await fsp.utimes(absPath, date, date);
  return absPath;
}

describe('normaliseSource', () => {
  test('fills in sensible defaults', () => {
    const source = normaliseSource({ path: '/home/me/Pictures' });
    assert.equal(source.into, 'Imported');
    assert.equal(source.organizeBy, 'date');
    assert.equal(source.path, path.resolve('/home/me/Pictures'));
  });

  test('rejects a destination that is a path rather than a folder name', () => {
    // `into` is joined onto the library root, so allowing separators here would
    // let a config edit steer an import off the drive entirely.
    assert.throws(() => normaliseSource({ path: '/x', into: '../../etc' }), /cannot contain/);
    assert.throws(() => normaliseSource({ path: '/x', into: 'a/b' }), /cannot contain/);
  });

  test('rejects an unknown organise mode and an empty path', () => {
    assert.throws(() => normaliseSource({ path: '/x', organizeBy: 'chaos' }), /organizeBy/);
    assert.throws(() => normaliseSource({ path: '  ' }), /needs a path/);
  });
});

describe('importing', () => {
  test('copies new photos in and leaves the source untouched', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeDated(path.join(source, 'one.jpg'), new Date('2024-03-05T10:00:00Z'));
    await writeDated(path.join(source, 'holiday', 'two.jpg'), new Date('2024-07-19T10:00:00Z'));

    const before = await listFiles(source);
    const report = await syncSources(library, [{ path: source }]);

    assert.equal(report.imported, 2);
    assert.equal(report.failed, 0);
    assert.deepEqual(await listFiles(source), before, 'the source folder is read-only to us');

    const files = await listFiles(library.path);
    assert.ok(files.includes('Imported/2024/2024-03-05/one.jpg'), files.join(', '));
    assert.ok(files.includes('Imported/2024/2024-07-19/two.jpg'), files.join(', '));

    // Imported files are in the index immediately, no scan required.
    const listed = library.listPhotos({ folder: '', recursive: true });
    assert.equal(listed.total, 2);
  });

  test('never imports the same bytes twice, even from a different folder', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    const original = await writeDated(path.join(source, 'a.jpg'), new Date('2024-01-01T00:00:00Z'));
    await copyImage(original, path.join(source, 'backup', 'a-copy.jpg'));

    const report = await syncSources(library, [{ path: source }]);
    assert.equal(report.imported, 1);
    assert.equal(report.duplicates, 1);
    assert.equal(library.listPhotos({ folder: '', recursive: true }).total, 1);
  });

  test('a second sync of an unchanged folder copies nothing', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeDated(path.join(source, 'a.jpg'), new Date('2024-01-01T00:00:00Z'));
    await syncSources(library, [{ path: source }]);

    const second = await syncSources(library, [{ path: source }]);
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 1, 'the ledger skips it without re-hashing');
  });

  test('a name collision gets a suffix instead of overwriting', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    const day = new Date('2024-05-05T12:00:00Z');
    // Same filename, same date, different pixels.
    await writeDated(path.join(source, 'a', 'shot.jpg'), day);
    await writeDated(path.join(source, 'b', 'shot.jpg'), day);

    const report = await syncSources(library, [{ path: source }]);
    assert.equal(report.imported, 2);

    const files = (await listFiles(library.path)).filter((f) => f.startsWith('Imported/'));
    assert.equal(files.length, 2);
    assert.ok(files.includes('Imported/2024/2024-05-05/shot.jpg'));
    assert.ok(files.includes('Imported/2024/2024-05-05/shot-1.jpg'), files.join(', '));
  });

  test('mirror mode keeps the source layout', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeImage(path.join(source, 'Trips', 'Iceland', 'a.jpg'));

    await syncSources(library, [{ path: source, into: 'Archive', organizeBy: 'mirror' }]);
    const files = await listFiles(library.path);
    assert.ok(files.includes('Archive/Trips/Iceland/a.jpg'), files.join(', '));

    // And the folder rows exist, so the tree renders without a scan.
    assert.ok(library.getFolder('Archive/Trips/Iceland'));
  });

  test('flat mode drops everything in one folder', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeImage(path.join(source, 'deep', 'nested', 'a.jpg'));

    await syncSources(library, [{ path: source, into: 'Inbox', organizeBy: 'flat' }]);
    assert.ok((await listFiles(library.path)).includes('Inbox/a.jpg'));
  });

  test('refuses a source inside the library, which would copy forever', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'Trips', 'a.jpg'));

    const report = await syncSources(library, [{ path: path.join(library.path, 'Trips') }]);
    assert.equal(report.imported, 0);
    assert.match(report.errors[0].error, /inside the library/);

    const itself = await syncSources(library, [{ path: library.path }]);
    assert.match(itself.errors[0].error, /inside the library/);
  });

  test('a missing source folder is reported, not thrown', async () => {
    const library = await makeLibrary();
    const report = await syncSources(library, [{ path: '/definitely/not/here' }]);
    assert.equal(report.imported, 0);
    assert.match(report.errors[0].error, /not found/);
  });

  test('non-image files are ignored', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeImage(path.join(source, 'a.jpg'));
    await fsp.writeFile(path.join(source, 'notes.txt'), 'hello');
    await fsp.writeFile(path.join(source, 'movie.mp4'), 'not handled yet');

    const report = await syncSources(library, [{ path: source }]);
    assert.equal(report.imported, 1);
    assert.equal((await listFiles(library.path)).filter((f) => f.startsWith('Imported/')).length, 1);
  });

  test('cancelling stops the copy partway', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    for (let i = 0; i < 5; i += 1) await writeImage(path.join(source, `img${i}.jpg`));

    const controller = new AbortController();
    await assert.rejects(
      () => syncSources(library, [{ path: source }], {
        signal: controller.signal,
        onProgress: ({ processed }) => { if (processed >= 2) controller.abort(); },
      }),
      (err) => err.cancelled === true,
    );
  });

  test('imports survive a later scan without being duplicated', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeImage(path.join(source, 'a.jpg'));
    await syncSources(library, [{ path: source }]);

    const report = await scanLibrary(library);
    assert.equal(report.added, 0, 'the sync already indexed it');
    assert.equal(report.missing, 0);
    assert.equal(library.listPhotos({ folder: '', recursive: true }).total, 1);
  });
});
