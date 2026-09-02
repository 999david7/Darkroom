import assert from 'node:assert/strict';
import path from 'node:path';
import test, { describe } from 'node:test';
import { assertValidName, baseName, contains, parentOf, relFrom, safeJoin, toPosix } from '../src/paths.js';

describe('safeJoin', () => {
  const root = path.resolve('/tmp/library');

  test('resolves ordinary relative paths', () => {
    assert.equal(safeJoin(root, 'Trips/2024/a.jpg'), path.join(root, 'Trips', '2024', 'a.jpg'));
    assert.equal(safeJoin(root, 'a.jpg'), path.join(root, 'a.jpg'));
  });

  test('refuses to climb out of the library', () => {
    for (const attempt of [
      '../secrets.txt',
      'Trips/../../secrets.txt',
      '..',
      'a/../../..',
    ]) {
      assert.throws(() => safeJoin(root, attempt), /escapes the library root/, attempt);
    }
  });

  test('refuses absolute paths and NUL bytes', () => {
    assert.throws(() => safeJoin(root, '/etc/passwd'), /expected a relative path/);
    assert.throws(() => safeJoin(root, 'C:\\Windows'), /expected a relative path/);
    assert.throws(() => safeJoin(root, 'a\0b'), /NUL byte/);
  });

  test('a name that merely starts with .. is fine', () => {
    // "..jpg" and "..data" are legal filenames; only real traversal is blocked.
    assert.equal(safeJoin(root, '..data/x.jpg'), path.join(root, '..data', 'x.jpg'));
  });
});

describe('contains', () => {
  test('is true for the root itself and its descendants', () => {
    assert.equal(contains('/a/b', '/a/b'), true);
    assert.equal(contains('/a/b', '/a/b/c'), true);
  });

  test('is false for siblings sharing a prefix', () => {
    assert.equal(contains('/a/b', '/a/bc'), false);
    assert.equal(contains('/a/b', '/a'), false);
  });
});

describe('posix helpers', () => {
  test('round-trips separators', () => {
    assert.equal(toPosix(path.join('a', 'b', 'c')), 'a/b/c');
  });

  test('relFrom produces posix-relative paths', () => {
    const root = path.resolve('/tmp/lib');
    assert.equal(relFrom(root, path.join(root, 'x', 'y.jpg')), 'x/y.jpg');
    assert.equal(relFrom(root, root), '');
  });

  test('parentOf and baseName agree on the tree shape', () => {
    assert.equal(parentOf('a/b/c'), 'a/b');
    assert.equal(parentOf('a'), '');
    assert.equal(parentOf(''), null);
    assert.equal(baseName('a/b/c'), 'c');
    assert.equal(baseName('a'), 'a');
  });
});

describe('assertValidName', () => {
  test('accepts and trims ordinary names', () => {
    assert.equal(assertValidName('  Iceland 2024 '), 'Iceland 2024');
    assert.equal(assertValidName('Ålesund — trip'), 'Ålesund — trip');
  });

  test('rejects anything that would not survive a round trip between platforms', () => {
    for (const bad of ['', '   ', '.', '..', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'a\0b']) {
      assert.throws(() => assertValidName(bad), Error, JSON.stringify(bad));
    }
  });

  test('rejects Windows reserved names and trailing periods', () => {
    assert.throws(() => assertValidName('CON'), /reserved/);
    assert.throws(() => assertValidName('lpt1.txt'), /reserved/);
    assert.throws(() => assertValidName('trip.'), /period/);
  });

  test('rejects leading dots so folders cannot hide from the scanner', () => {
    // The scanner skips dot-directories, so a folder named ".x" would be
    // created and then immediately vanish from the index.
    assert.throws(() => assertValidName('.hidden'), /start with a period/);
  });
});
