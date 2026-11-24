import assert from 'node:assert/strict';
import { test } from 'node:test';
import { albumOptions, chosenIndex, fieldKey } from '../public/albumchoice.js';

const album = (id: string, name: string) => ({ id, name });
const albums = [album('1', 'Trip 2024'), album('2', 'Żółw w zoo'), album('3', 'Garden'), album('4', 'trip')];
type Option = { kind: 'new'; name: string } | { kind: 'album'; album: { name: string } };
const show = (opts: Option[]) => opts.map((o) => (o.kind === 'new' ? `new:${o.name}` : o.album.name));

test('nothing typed: every album, as listed', () => {
  assert.deepEqual(show(albumOptions(albums, '  ')), ['Trip 2024', 'Żółw w zoo', 'Garden', 'trip']);
});

test('a name no album has: the new album first, then the albums it matches', () => {
  assert.deepEqual(show(albumOptions(albums, ' Tri ')), ['new:Tri', 'Trip 2024', 'trip']);
  assert.deepEqual(show(albumOptions(albums, 'Zoo trip')), ['new:Zoo trip']);
});

test("an album's exact name (any letter case, spaces around): that album first, no new one", () => {
  assert.deepEqual(show(albumOptions(albums, ' TRIP ')), ['trip', 'Trip 2024']);
  assert.deepEqual(show(albumOptions(albums, 'garden')), ['Garden']);
});

test('search ignores accents; creating keeps them as typed', () => {
  assert.deepEqual(show(albumOptions(albums, 'zolw')), ['new:zolw', 'Żółw w zoo']);
  assert.deepEqual(show(albumOptions(albums, 'Żółw w zoo')), ['Żółw w zoo']);
});

test('chosen: the last album moved into when nothing is typed (none when gone), else the 1st option', () => {
  const all = albumOptions(albums, '');
  assert.equal(chosenIndex(all, '', '3'), 2);
  assert.equal(chosenIndex(all, '', 'deleted-album'), -1);
  assert.equal(chosenIndex(all, '', null), -1);
  assert.equal(chosenIndex(albumOptions(albums, 'Tri'), 'Tri', '3'), 0);
  assert.equal(chosenIndex(albumOptions([], ''), '', '3'), -1);
});

test('arrows move the choice round; Enter only picks it (the Move button moves), never moves at once', () => {
  assert.deepEqual(fieldKey('ArrowDown', -1, 3), { index: 0 });
  assert.deepEqual(fieldKey('ArrowDown', 2, 3), { index: 0 });
  assert.deepEqual(fieldKey('ArrowUp', 0, 3), { index: 2 });
  assert.deepEqual(fieldKey('ArrowUp', -1, 3), { index: 2 });
  assert.equal(fieldKey('ArrowDown', -1, 0), null);
  assert.equal(fieldKey('Enter', 1, 3), 'pick');
  assert.equal(fieldKey('Enter', -1, 3), 'none');
  assert.equal(fieldKey('Enter', -1, 0), 'none');
  assert.equal(fieldKey('a', 0, 3), null);
});
