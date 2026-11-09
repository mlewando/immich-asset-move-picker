import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGuard } from '../src/immich/guard.ts';
import { fakeApi, fakeDb, healthySchema } from './fakes.ts';

test('tested version + expected schema → ok', async () => {
  const r = await checkGuard({ api: fakeApi(), db: fakeDb() });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test('other Immich version → not ok', async () => {
  const r = await checkGuard({ api: fakeApi({ major: 3, minor: 4, patch: 0 }), db: fakeDb() });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['Immich version 3.4.0, picker tested with 3.3.5']);
});

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
