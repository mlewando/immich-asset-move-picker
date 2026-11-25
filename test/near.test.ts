import assert from 'node:assert/strict';
import test from 'node:test';
import type { FamilyAlbum } from '../src/immich/index.ts';
import { albumWindow, intersect, suggestAlbum } from '../src/near.ts';

const album = (id: string, from: string | null, to: string | null): FamilyAlbum => ({
  id, name: id, count: 1, from, to, coverId: null, updatedAt: '2026-01-01T00:00:00.000Z',
});

test('albumWindow: first to last photo day, widened each way, across months and years', () => {
  assert.deepEqual(albumWindow(album('a', '2026-07-01', '2026-07-03'), 0, 0), { from: '2026-07-01', to: '2026-07-03' });
  assert.deepEqual(albumWindow(album('a', '2026-01-01', '2026-12-31'), 2, 1), { from: '2025-12-30', to: '2027-01-01' });
  assert.deepEqual(albumWindow(album('a', '2024-03-01', '2024-03-01'), 1, 0), { from: '2024-02-29', to: '2024-03-01' }, 'leap day');
  assert.equal(albumWindow(album('a', null, null), 2, 2), null, 'empty album');
});

test('intersect: open bounds, overlap, apart', () => {
  const w = { from: '2026-07-01', to: '2026-07-10' };
  assert.deepEqual(intersect({}, w), w);
  assert.deepEqual(intersect({ from: '2026-07-05' }, w), { from: '2026-07-05', to: '2026-07-10' });
  assert.deepEqual(intersect({ from: '2026-06-01', to: '2026-07-02' }, w), { from: '2026-07-01', to: '2026-07-02' });
  assert.equal(intersect({ to: '2026-06-30' }, w), null);
});

test('suggestAlbum: latest last day first; only own days; in-family and skipped left out', () => {
  const trip = album('trip', '2026-07-01', '2026-07-03');
  const xmas = album('xmas', '2025-12-24', '2025-12-26');
  const empty = album('empty', null, null);
  const items = [
    { day: '2026-07-04', inFamily: false }, // surround only: not counted
    { day: '2026-07-02', inFamily: true },
    { day: '2025-12-25', inFamily: false },
    { day: '2025-12-24', inFamily: false },
  ];
  assert.deepEqual(suggestAlbum([xmas, empty, trip], items), { album: xmas, count: 2 });
  const withTrip = [...items, { day: '2026-07-01' }];
  assert.deepEqual(suggestAlbum([xmas, trip], withTrip), { album: trip, count: 1 });
  assert.deepEqual(suggestAlbum([xmas, trip], withTrip, new Set(['trip'])), { album: xmas, count: 2 });
  assert.equal(suggestAlbum([xmas, trip], withTrip, new Set(['trip', 'xmas'])), null);
  assert.equal(suggestAlbum([], withTrip), null);
});
