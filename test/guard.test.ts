import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImmichError } from '../src/immich/api.ts';
import { checkGuard, VERSION_RECHECK_MS } from '../src/immich/guard.ts';
import { fakeApi, fakeDb, healthySchema, keyOk } from './fakes.ts';

for (const [major, minor, patch] of [[3, 4, 1], [3, 4, 2]]) {
  test(`supported version ${major}.${minor}.${patch} + expected schema → ok`, async () => {
    const r = await checkGuard({ api: fakeApi({ major: major!, minor: minor!, patch: patch! }), db: fakeDb() });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  });
}

// 3.3.5 to 3.4.0 were supported before; 3.4.3 and 3.5.0 are not tested yet.
for (const [major, minor, patch] of [[3, 3, 5], [3, 3, 6], [3, 4, 0], [3, 4, 3], [3, 5, 0]]) {
  test(`unsupported version ${major}.${minor}.${patch} → not ok`, async () => {
    const r = await checkGuard({ api: fakeApi({ major: major!, minor: minor!, patch: patch! }), db: fakeDb() });
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, [
      `Immich version ${major}.${minor}.${patch} not supported (supported: 3.4.1, 3.4.2)`,
    ]);
  });
}

test('Immich unreachable → not ok', async () => {
  const r = await checkGuard({ api: fakeApi(new Error('fetch failed')), db: fakeDb() });
  assert.deepEqual(r.problems, ['Immich version check failed: fetch failed']);
});

test('Immich slow to answer: asked once more with a longer timeout before going read-only', async () => {
  const timeouts: (number | undefined)[] = [];
  const slowOnce = {
    ...keyOk,
    async getServerVersion(timeoutMs?: number) {
      timeouts.push(timeoutMs);
      if (timeouts.length === 1) throw new ImmichError('Immich GET /server/version: no answer in 5 s', 0);
      return { major: 3, minor: 4, patch: 1 };
    },
  };
  const r = await checkGuard({ api: slowOnce, db: fakeDb() });
  assert.deepEqual([r.ok, timeouts], [true, [undefined, VERSION_RECHECK_MS]]);

  const down = { ...keyOk, getServerVersion: async () => Promise.reject(new ImmichError('Immich GET /server/version: no answer in 15 s', 0)) };
  assert.deepEqual((await checkGuard({ api: down, db: fakeDb() })).problems, [
    'Immich version check failed: Immich GET /server/version: no answer in 15 s',
  ]);
});

test('quick (already read-only): no 2nd, longer try', async () => {
  const timeouts: (number | undefined)[] = [];
  const slow = {
    ...keyOk,
    async getServerVersion(timeoutMs?: number) {
      timeouts.push(timeoutMs);
      throw new ImmichError('Immich GET /server/version: no answer in 5 s', 0);
    },
  };
  const r = await checkGuard({ api: slow, db: fakeDb(), quick: true });
  assert.deepEqual(timeouts, [undefined]);
  assert.deepEqual(r.problems, ['Immich version check failed: Immich GET /server/version: no answer in 5 s']);
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

test('missing grant for deleting a moved-out album → not ok, names the grants', async () => {
  const s = healthySchema();
  s.tableGrants.delete('DELETE album');
  s.tableGrants.delete('INSERT album_user_audit');
  const r = await checkGuard({ api: fakeApi(), db: fakeDb(s) });
  assert.deepEqual(r.problems, ['no grant: DELETE on album, INSERT on album_user_audit']);
});

test('family API key without the album permissions → not ok, names them', async () => {
  const old = ['asset.upload', 'asset.update', 'asset.delete', 'stack.create', 'user.read'];
  const r = await checkGuard({ api: fakeApi(undefined, old), db: fakeDb() });
  assert.deepEqual(r.problems, ['family API key lacks permissions: album.create, albumAsset.create']);
});

test("family API key with 'all' → ok", async () => {
  const r = await checkGuard({ api: fakeApi(undefined, ['all']), db: fakeDb() });
  assert.deepEqual(r.problems, []);
});

test('API key check fails → not ok; not asked while Immich does not answer', async () => {
  const r = await checkGuard({ api: fakeApi(undefined, new Error('Immich GET /api-keys/me → HTTP 401')), db: fakeDb() });
  assert.deepEqual(r.problems, ['API key check failed: Immich GET /api-keys/me → HTTP 401']);
  const down = await checkGuard({ api: fakeApi(new Error('fetch failed'), new Error('never asked')), db: fakeDb() });
  assert.deepEqual(down.problems, ['Immich version check failed: fetch failed']);
});

test('DB down → not ok', async () => {
  const r = await checkGuard({ api: fakeApi(), db: fakeDb(healthySchema(), { down: true }) });
  assert.deepEqual(r.problems, ['schema check failed: connect ECONNREFUSED 127.0.0.1:5432']);
});
