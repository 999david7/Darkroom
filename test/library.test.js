import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { Library } from '../src/library.js';
import { pruneMissing, scanLibrary, verifyLibrary } from '../src/scanner.js';
import { ensureThumb } from '../src/thumbs.js';
import { initLibrary } from '../src/volume.js';
import { cleanup, copyImage, tempDir, writeImage } from './helpers.js';

after(cleanup);

const open = [];
async function makeLibrary() {
  const drive = await tempDir();
  const root = path.join(drive, 'Photos');
  const marker = await initLibrary(root, 'Test drive');
  const library = new Library(root, marker);
  open.push(library);
  return library;
}

after(() => { for (const library of open) library.close(); });

describe('scanning', () => {
  test('indexes images and mirrors the directory tree into folders', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'a.jpg'));
    await writeImage(path.join(library.path, 'Trips', 'Iceland', 'b.jpg'));
    await writeImage(path.join(library.path, 'Trips', 'Iceland', 'c.jpg'));

    const report = await scanLibrary(library);
    assert.equal(report.added, 3);
    assert.equal(report.foldersAdded, 2, 'Trips and Trips/Iceland');

    const tree = library.folderTree();
    assert.equal(tree.count, 3, 'the root counts everything beneath it');
    const trips = tree.children.find((node) => node.name === 'Trips');
    assert.equal(trips.count, 2);
    assert.equal(trips.directCount, 0, 'photos sit in the child folder, not in Trips itself');

    const { items } = library.listPhotos({ folder: 'Trips/Iceland' });
    assert.deepEqual(items.map((p) => p.filename).sort(), ['b.jpg', 'c.jpg']);
    assert.ok(items[0].width > 0 && items[0].height > 0, 'dimensions come from the file');
  });

  test('skips the internal directory and hidden folders', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'keep.jpg'));
    await writeImage(path.join(library.path, '.darkroom', 'trash', 'gone.jpg'));
    await writeImage(path.join(library.path, '.hidden', 'nope.jpg'));

    const report = await scanLibrary(library);
    assert.equal(report.added, 1);
    assert.equal(library.stats().count, 1);
  });

  test('a rescan with nothing changed does no work', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'a.jpg'));
    await scanLibrary(library);

    const second = await scanLibrary(library);
    assert.equal(second.added, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.unchanged, 1);
  });

  test('a moved file keeps its id, caption and favourite', async () => {
    const library = await makeLibrary();
    const original = path.join(library.path, 'a.jpg');
    await writeImage(original);
    await scanLibrary(library);

    const before = library.listPhotos({ folder: '' }).items[0];
    library.updatePhoto(before.id, { title: 'Sunrise', caption: 'On the ferry', favorite: true });

    // Reorganised in the file manager, not in the app.
    await fsp.mkdir(path.join(library.path, 'Trips'), { recursive: true });
    await fsp.rename(original, path.join(library.path, 'Trips', 'renamed.jpg'));

    const report = await scanLibrary(library);
    assert.equal(report.moved, 1);
    assert.equal(report.added, 0);
    assert.equal(report.missing, 0);

    const after = library.getPhoto(before.id);
    assert.equal(after.rel_path, 'Trips/renamed.jpg');
    assert.equal(after.folder_path, 'Trips');
    assert.equal(after.title, 'Sunrise');
    assert.equal(after.caption, 'On the ferry');
    assert.equal(after.favorite, 1);
  });

  test('a deleted file is flagged missing, and pruning forgets it', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'a.jpg'));
    await writeImage(path.join(library.path, 'b.jpg'));
    await scanLibrary(library);

    await fsp.rm(path.join(library.path, 'a.jpg'));
    const report = await scanLibrary(library);
    assert.equal(report.missing, 1);
    assert.equal(library.stats().count, 1, 'missing photos drop out of the visible library');
    assert.equal(library.stats().missing, 1);

    assert.deepEqual(pruneMissing(library), { pruned: 1 });
    assert.equal(library.stats().missing, 0);
    assert.ok(await fsp.stat(path.join(library.path, 'b.jpg')), 'pruning must not touch files');
  });

  test('edited bytes update the row', async () => {
    const library = await makeLibrary();
    const file = path.join(library.path, 'a.jpg');
    await writeImage(file, { width: 40, height: 40 });
    await scanLibrary(library);
    const before = library.listPhotos({}).items[0];

    await writeImage(file, { width: 90, height: 60 });
    await fsp.utimes(file, new Date(), new Date(Date.now() + 5000));

    const report = await scanLibrary(library);
    assert.equal(report.updated, 1);
    const after = library.getPhoto(before.id);
    assert.equal(after.width, 90);
    assert.notEqual(after.hash, before.hash);
  });

  test('RAW files are indexed but marked undecodable', async () => {
    const library = await makeLibrary();
    await fsp.writeFile(path.join(library.path, 'shot.cr2'), Buffer.from('not really a raw file'));
    await scanLibrary(library);

    const { items } = library.listPhotos({});
    assert.equal(items.length, 1, 'a RAW file still belongs in the index');
    assert.equal(items[0].thumb_state, 'unsupported');
  });
});

describe('folders', () => {
  test('creating, renaming and describing folders', async () => {
    const library = await makeLibrary();
    await library.createFolder('', 'Trips');
    await library.createFolder('Trips', 'Iceland');
    await writeImage(path.join(library.path, 'Trips', 'Iceland', 'a.jpg'));
    await scanLibrary(library);

    library.updateFolder('Trips/Iceland', { description: 'Ring road, September' });
    assert.equal(library.getFolder('Trips/Iceland').description, 'Ring road, September');

    const renamed = await library.renameFolder('Trips/Iceland', 'Iceland 2024');
    assert.equal(renamed.rel_path, 'Trips/Iceland 2024');
    assert.equal(renamed.description, 'Ring road, September', 'metadata follows the rename');

    // The directory really moved, and the photo rows moved with it.
    assert.ok(await fsp.stat(path.join(library.path, 'Trips', 'Iceland 2024', 'a.jpg')));
    const photo = library.listPhotos({ folder: 'Trips/Iceland 2024' }).items[0];
    assert.equal(photo.rel_path, 'Trips/Iceland 2024/a.jpg');
    assert.equal(library.listPhotos({ folder: 'Trips/Iceland' }).total, 0);
  });

  test('renaming a folder repoints its descendants too', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'A', 'B', 'C', 'deep.jpg'));
    await scanLibrary(library);

    await library.renameFolder('A', 'Z');
    assert.equal(library.getFolder('Z/B/C').parent_path, 'Z/B');
    const photo = library.listPhotos({ folder: 'Z/B/C' }).items[0];
    assert.equal(photo.rel_path, 'Z/B/C/deep.jpg');
    assert.equal(photo.folder_path, 'Z/B/C');
  });

  test('duplicate folder names are refused', async () => {
    const library = await makeLibrary();
    await library.createFolder('', 'Trips');
    await assert.rejects(() => library.createFolder('', 'Trips'), /already exists/);
  });

  test('a folder falls back to the newest photo inside it for a cover', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'Trips', 'Iceland', 'old.jpg'));
    await writeImage(path.join(library.path, 'Trips', 'Iceland', 'new.jpg'));
    await scanLibrary(library);

    const ids = Object.fromEntries(
      library.listPhotos({ folder: 'Trips/Iceland' }).items.map((p) => [p.filename, p.id]),
    );
    library.db.prepare('UPDATE photos SET taken_at = ? WHERE id = ?').run(1_000, ids['old.jpg']);
    library.db.prepare('UPDATE photos SET taken_at = ? WHERE id = ?').run(9_000, ids['new.jpg']);

    let trips = library.folderTree().children.find((n) => n.name === 'Trips');
    assert.equal(trips.cover.id, ids['new.jpg'], 'covers bubble up from nested folders');
    assert.equal(trips.cover.explicit, false);

    // An explicit choice wins over the automatic one.
    library.updateFolder('Trips', { coverPhotoId: ids['old.jpg'] });
    trips = library.folderTree().children.find((n) => n.name === 'Trips');
    assert.equal(trips.cover.id, ids['old.jpg']);
    assert.equal(trips.cover.explicit, true);
  });

  test('a cover has to come from inside the folder', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'Trips', 'a.jpg'));
    await writeImage(path.join(library.path, 'Work', 'b.jpg'));
    await scanLibrary(library);

    const outsider = library.listPhotos({ folder: 'Work' }).items[0];
    assert.throws(
      () => library.updateFolder('Trips', { coverPhotoId: outsider.id }),
      /must live in that folder/,
    );
  });

  test('a cover that is deleted falls back instead of leaving a hole', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'Trips', 'a.jpg'));
    await writeImage(path.join(library.path, 'Trips', 'b.jpg'));
    await scanLibrary(library);

    const [first, second] = library.listPhotos({ folder: 'Trips' }).items;
    library.updateFolder('Trips', { coverPhotoId: first.id });
    await library.deletePhoto(first.id);

    const trips = library.folderTree().children[0];
    assert.equal(trips.cover.id, second.id);
    assert.equal(trips.cover.explicit, false);
  });
});

describe('photos', () => {
  test('search looks at filename, title, caption and folder', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'Iceland', 'DSC_0001.jpg'));
    await writeImage(path.join(library.path, 'Work', 'DSC_0002.jpg'));
    await scanLibrary(library);

    const target = library.listPhotos({ folder: 'Work' }).items[0];
    library.updatePhoto(target.id, { caption: 'the northern lights' });

    assert.equal(library.listPhotos({ folder: '', recursive: true, q: 'iceland' }).total, 1);
    assert.equal(library.listPhotos({ folder: '', recursive: true, q: 'northern' }).total, 1);
    assert.equal(library.listPhotos({ folder: '', recursive: true, q: 'DSC_' }).total, 2);
    assert.equal(library.listPhotos({ folder: '', recursive: true, q: 'nothing here' }).total, 0);
  });

  test('search treats % and _ as literal characters', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'a_b.jpg'));
    await writeImage(path.join(library.path, 'axb.jpg'));
    await scanLibrary(library);

    // Without escaping, "a_b" would match "axb" too — _ is a LIKE wildcard.
    assert.equal(library.listPhotos({ folder: '', recursive: true, q: 'a_b' }).total, 1);
    assert.equal(library.listPhotos({ folder: '', recursive: true, q: '%' }).total, 0);
  });

  test('deleting moves the file to the trash rather than erasing it', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'Trips', 'a.jpg'));
    await scanLibrary(library);

    const photo = library.listPhotos({ folder: 'Trips' }).items[0];
    const result = await library.deletePhoto(photo.id);

    assert.equal(library.getPhoto(photo.id), null);
    assert.match(result.movedTo, /^\.darkroom\/trash\//);
    assert.ok(await fsp.stat(path.join(library.path, result.movedTo)), 'the bytes are still on the drive');
    await assert.rejects(() => fsp.stat(path.join(library.path, 'Trips', 'a.jpg')));
  });

  test('paging is stable and bounded', async () => {
    const library = await makeLibrary();
    for (let i = 0; i < 7; i += 1) {
      await writeImage(path.join(library.path, `img-${String(i).padStart(2, '0')}.jpg`));
    }
    await scanLibrary(library);

    const first = library.listPhotos({ sort: 'name_asc', limit: 3, offset: 0 });
    const second = library.listPhotos({ sort: 'name_asc', limit: 3, offset: 3 });
    assert.equal(first.total, 7);
    assert.equal(first.items.length, 3);
    assert.equal(first.items[0].filename, 'img-00.jpg');
    assert.equal(second.items[0].filename, 'img-03.jpg');
    assert.equal(library.listPhotos({ limit: 100_000 }).limit, 500, 'limit is capped');
  });
});

describe('thumbnails', () => {
  test('render into the cache on the drive and are reused', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'a.jpg'), { width: 800, height: 600 });
    await scanLibrary(library);
    const photo = library.listPhotos({}).items[0];

    const file = await ensureThumb(library.path, {
      absPath: library.absPathOf(photo),
      hash: photo.hash,
      size: 'thumb',
    });
    assert.ok(file.startsWith(path.join(library.path, '.darkroom', 'cache')), 'cache lives on the drive');
    const first = await fsp.stat(file);
    assert.ok(first.size > 0);

    const again = await ensureThumb(library.path, {
      absPath: library.absPathOf(photo),
      hash: photo.hash,
      size: 'thumb',
    });
    assert.equal(again, file);
    assert.equal((await fsp.stat(file)).mtimeMs, first.mtimeMs, 'a cache hit does not re-render');
  });

  test('an undecodable file yields null rather than throwing', async () => {
    const library = await makeLibrary();
    const file = path.join(library.path, 'broken.jpg');
    await fsp.writeFile(file, Buffer.from('this is not a jpeg'));
    await scanLibrary(library);
    const photo = library.listPhotos({}).items[0];

    const result = await ensureThumb(library.path, {
      absPath: library.absPathOf(photo),
      hash: photo.hash,
      size: 'thumb',
    });
    assert.equal(result, null);
  });

  test('a RAW file borrows a sidecar JPEG for its thumbnail', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'shot.jpg'), { width: 200, height: 150 });
    await fsp.writeFile(path.join(library.path, 'shot.cr2'), Buffer.from('raw bytes'));
    await scanLibrary(library);

    const raw = library.listPhotos({}).items.find((p) => p.ext === '.cr2');
    const file = await ensureThumb(library.path, {
      absPath: library.absPathOf(raw),
      hash: raw.hash,
      size: 'thumb',
    });
    assert.ok(file, 'the sidecar stands in for the RAW file');
  });
});

describe('verify', () => {
  test('reports files whose bytes no longer match the index', async () => {
    const library = await makeLibrary();
    await writeImage(path.join(library.path, 'good.jpg'));
    await writeImage(path.join(library.path, 'rotten.jpg'));
    await writeImage(path.join(library.path, 'vanished.jpg'));
    await scanLibrary(library);

    const clean = await verifyLibrary(library);
    assert.equal(clean.ok, 3);
    assert.equal(clean.changed.length, 0);

    // Corrupt one in place without changing its size or mtime, the way bit rot
    // on a failing drive would.
    const target = path.join(library.path, 'rotten.jpg');
    const stat = await fsp.stat(target);
    const bytes = await fsp.readFile(target);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await fsp.writeFile(target, bytes);
    await fsp.utimes(target, stat.atime, stat.mtime);
    await fsp.rm(path.join(library.path, 'vanished.jpg'));

    const report = await verifyLibrary(library);
    assert.equal(report.ok, 1);
    assert.deepEqual(report.changed.map((c) => c.path), ['rotten.jpg']);
    assert.deepEqual(report.missing.map((m) => m.path), ['vanished.jpg']);
  });
});

describe('duplicates', () => {
  test('two identical files are two photos sharing one cached thumbnail', async () => {
    const library = await makeLibrary();
    const first = path.join(library.path, 'a.jpg');
    await writeImage(first);
    await copyImage(first, path.join(library.path, 'Copies', 'a.jpg'));
    await scanLibrary(library);

    const all = library.listPhotos({ folder: '', recursive: true });
    assert.equal(all.total, 2);
    const [one, two] = all.items;
    assert.equal(one.hash, two.hash);

    // Deleting one must not remove the thumbnail the other still needs.
    await ensureThumb(library.path, { absPath: library.absPathOf(one), hash: one.hash, size: 'thumb' });
    await library.deletePhoto(one.id);
    const still = await ensureThumb(library.path, {
      absPath: library.absPathOf(library.getPhoto(two.id)),
      hash: two.hash,
      size: 'thumb',
    });
    assert.ok(still);
  });
});
