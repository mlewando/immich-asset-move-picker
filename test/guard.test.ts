import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGuard } from '../src/immich/guard.ts';
import { fakeApi, fakeDb, healthySchema } from './fakes.ts';

for (const [major, minor, patch] of [[3, 3, 5], [3, 3, 6], [3, 4, 0], [3, 4, 1]]) {
  test(`supported version ${major}.${minor}.${patch} + expected schema → ok`, async () => {
    const r = await checkGuard({ api: fakeApi({ major: major!, minor: minor!, patch: patch! }), db: fakeDb() });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  });
}

// 3.3.7 sorts inside the supported range but was never tested.
for (const [major, minor, patch] of [[3, 3, 4], [3, 3, 7], [3, 4, 2], [3, 5, 0]]) {
  test(`unsupported version ${major}.${minor}.${patch} → not ok`, async () => {
    const r = await checkGuard({ api: fakeApi({ major: major!, minor: minor!, patch: patch! }), db: fakeDb() });
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, [
      `Immich version ${major}.${minor}.${patch} not supported (supported: 3.3.5, 3.3.6, 3.4.0, 3.4.1)`,
    ]);
  });
}

test('Immich unreachable → not ok', async () => {
  const r = await checkGuard({ api: fakeApi(new Error('fetch failed')), db: fakeDb() });
  assert.deepEqual(r.problems, ['Immich version check failed: fetch failed']);
});

test('renamed column or missing grant → not ok, names the columns', async () => {
  const s = healthySchema();
  s.columns.asset = s.columns.asset!.filter((c) => c !== 'livePhotoVideoId');
  delete s.columns.stack;
  const r = await checkGuard({ api: fakeApi(), db: fakeDb(s) });
  assert.deepEqual(r.problems, [
    'public.asset: missing or not granted: livePhotoVideoId',
    'public.stack: missing or not granted: id, primaryAssetId, ownerId',
  ]);
});

test('enum gained or lost a value → not ok', async () => {
  const s = healthySchema();
  s.enums.asset_visibility_enum!.push('shared');
  delete s.enums.assets_status_enum;
  const r = await checkGuard({ api: fakeApi(), db: fakeDb(s) });
  assert.deepEqual(r.problems, [
    'enum public.asset_visibility_enum is [archive, timeline, hidden, locked, shared], expected [archive, timeline, hidden, locked]',
    'enum public.assets_status_enum missing',
  ]);
});

test('missing UPDATE grant for archiving → not ok, names the columns', async () => {
  const s = healthySchema();
  s.updatable.delete('asset.visibility');
  s.updatable.delete('asset_face.assetVisibility');
  const r = await checkGuard({ api: fakeApi(), db: fakeDb(s) });
  assert.deepEqual(r.problems, ['no UPDATE grant on: asset.visibility, asset_face.assetVisibility']);
});

test('DB down → not ok', async () => {
  const r = await checkGuard({ api: fakeApi(), db: fakeDb(healthySchema(), { down: true }) });
  assert.deepEqual(r.problems, ['schema check failed: connect ECONNREFUSED 127.0.0.1:5432']);
});
