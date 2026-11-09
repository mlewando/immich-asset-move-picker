import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapImmichPath } from '../src/immich/paths.ts';

const lib = { mount: '/library', subdirs: ['upload', 'library', 'backups', 'encoded-video'], thumbsDir: '/data/thumbs' };

test('library subdirs map under the 1 library mount', () => {
  assert.equal(mapImmichPath('/data/upload/u1/ab/cd/x.jpg', lib), '/library/upload/u1/ab/cd/x.jpg');
  assert.equal(mapImmichPath('/data/library/family-photos/2026/x.jpg', lib), '/library/library/family-photos/2026/x.jpg');
  assert.equal(mapImmichPath('/data/encoded-video/u1/ab/cd/x.mp4', lib), '/library/encoded-video/u1/ab/cd/x.mp4');
});

test('thumbs map to thumbsDir', () => {
  assert.equal(mapImmichPath('/data/thumbs/u1/ab/cd/x_thumbnail.webp', lib), '/data/thumbs/u1/ab/cd/x_thumbnail.webp');
  assert.equal(
    mapImmichPath('/data/thumbs/u1/x.webp', { ...lib, thumbsDir: '/dev/.data/immich/thumbs' }),
    '/dev/.data/immich/thumbs/u1/x.webp',
  );
});

test('rejects paths outside the known subdirs', () => {
  for (const p of [
    '/data/profile/u1/x.jpg', // not in PICKER_LIBRARY_SUBDIRS
    '/etc/passwd',
    '/datax/upload/x.jpg',
    'data/upload/x.jpg',
    '/data/upload', // the subdir itself, no file
    '/data/upload/',
    '/data/',
    '',
  ]) {
    assert.equal(mapImmichPath(p, lib), null, p);
  }
});

test('rejects non-normalized paths (.., ., //)', () => {
  for (const p of [
    '/data/upload/../../etc/passwd',
    '/data/upload/u1/../../thumbs/x',
    '/data/upload/./x.jpg',
    '/data/upload//x.jpg',
    '/data/../data/upload/x.jpg',
    '/data/upload/..',
  ]) {
    assert.equal(mapImmichPath(p, lib), null, p);
  }
});
