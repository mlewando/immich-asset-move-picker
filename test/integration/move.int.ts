// Move to family and Give back against the real local Immich (npm run dev:up && npm run
// dev:seed), through the real HTTP API, worker, uploads, archive UPDATE and hard links. The queue
// is an in-memory SQLite. Moves 3 of Bob's photos:
//   photo-9   edited in Immich (description, location, rating, date + time zone) → carried
//   photo-10  plain → uploaded, nothing else
//   shared.jpg already in the family account → reused, no upload
// And Anna's live photo (video + still) and 3-photo stack, then gives some back. Plus ones that
// can't move → failed with the reason.
// Undoes everything afterwards (originals back on the timeline, new copies force-deleted), so
// it can run again. Run: npm run test:int
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { createDb } from '../../src/immich/db.ts';
import { createImmich, type GridItem, type Member } from '../../src/immich/index.ts';
import { mapImmichPath } from '../../src/immich/paths.ts';
import { openQueue } from '../../src/queue.ts';
import { buildApp } from '../../src/server.ts';
import { createWorker } from '../../src/worker.ts';

const config = loadConfig(process.env);
const immich = createImmich(config);
const db = createDb(config.db); // for assertions and cleanup only
const queue = openQueue(':memory:');
const guard = await immich.check();
const worker = createWorker({
  queue,
  immich,
  guard: async () => guard,
  log: { info: () => {}, error: () => {} },
});
const app = await buildApp({ immich, guard: () => guard, queue, worker });
const familyId = (
  (await fetch(`${config.immich.apiUrl}/users/me`, { headers: { 'x-api-key': config.immich.familyApiKey } }).then((r) => r.json())) as { id: string }
).id;

let base: string;
const json = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: (await res.json()) as T };
};
const post = (path: string, body: unknown) =>
  json(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-picker': '1' }, body: JSON.stringify(body) });

const asset = async (id: string) =>
  (await db.query<{ visibility: string; checksum: Buffer; localDateTime: Date }>(
    `SELECT visibility, checksum, "localDateTime" FROM asset WHERE id = $1`, [id],
  ))[0]!;
// The derived pair: the family asset with the original's bytes.
const familyCopyOf = async (originalId: string) =>
  (await db.query<{ id: string }>(
    `SELECT f.id FROM asset f JOIN asset o ON o.checksum = f.checksum
      WHERE o.id = $1 AND f."ownerId" = $2 AND f."deletedAt" IS NULL AND f.status = 'active'`,
    [originalId, familyId],
  )).map((r) => r.id);

// Hard link: the original's file name and its family copy's are 1 file (same inode, ≥2 links).
const assertLinked = async (originalId: string) => {
  const [familyId_] = await familyCopyOf(originalId);
  const paths = await db.query<{ id: string; originalPath: string }>(
    `SELECT id, "originalPath" FROM asset WHERE id = ANY($1::uuid[])`, [[originalId, familyId_]],
  );
  const [o, f] = [originalId, familyId_].map((id) => statSync(mapImmichPath(paths.find((p) => p.id === id)!.originalPath, config.library)!));
  assert.equal(o!.ino, f!.ino, `${originalId}: same inode`);
  assert.ok(o!.nlink >= 2, `${originalId}: ${o!.nlink} links`);
};

const annaAsset = async (fileName: string) =>
  (await db.query<{ id: string }>(
    `SELECT id FROM asset WHERE "ownerId" = $1 AND "originalFileName" = $2 AND "deletedAt" IS NULL`, [anna.id, fileName],
  ))[0]!.id;

let bob: Member;
let anna: Member;
let moved: Record<string, GridItem> = {};
let annaIds: Record<string, string> = {}; // file name → id: live-still/motion, burst-1..3
let familyBefore: Set<string>;

before(async () => {
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  const members = (await json<Member[]>('/api/members')).body;
  bob = members.find((m) => m.email === 'bob@example.test')!;
  anna = members.find((m) => m.email === 'anna@example.test')!;
  const grid = (await json<GridItem[]>(`/api/members/${bob.id}/assets`)).body;
  moved = Object.fromEntries(['photo-9.jpg', 'photo-10.jpg', 'shared.jpg'].map((n) => [n, grid.find((i) => i.fileName === n)!]));
  assert.ok(Object.values(moved).every(Boolean), 'seeded photos present (re-run npm run dev:seed?)');
  for (const f of ['live-still.jpg', 'live-motion.mp4', 'burst-1.jpg', 'burst-2.jpg', 'burst-3.jpg']) annaIds[f] = await annaAsset(f);
  familyBefore = new Set((await db.query<{ id: string }>(`SELECT id FROM asset WHERE "ownerId" = $1`, [familyId])).map((r) => r.id));
});

after(async () => {
  // Undo: originals back to the timeline, family copies this test created force-deleted.
  const originals = [...Object.values(moved).map((i) => i.id), ...Object.values(annaIds)];
  const created = [...new Set((await Promise.all(originals.map(familyCopyOf))).flat())].filter((id) => !familyBefore.has(id));
  await immich.restore(originals.filter((id) => id !== annaIds['live-motion.mp4'])); // the video stays hidden
  if (created.length) {
    const res = await fetch(`${config.immich.apiUrl}/assets`, {
      method: 'DELETE',
      headers: { 'x-api-key': config.immich.familyApiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: created, force: true }),
    });
    assert.ok(res.ok, `cleanup delete → HTTP ${res.status}`);
  }
  await app.close();
  queue.close();
  await immich.close();
  await db.close();
});

const familyApi = (method: string, path: string, body: unknown) =>
  fetch(`${config.immich.apiUrl}${path}`, {
    method,
    headers: { 'x-api-key': config.immich.familyApiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test("bytes only in the family account's trash → refused, original untouched (then restored from trash)", async () => {
  const [famShared] = await db.query<{ id: string }>(
    `SELECT id FROM asset WHERE "ownerId" = $1 AND "originalFileName" = 'shared.jpg'`, [familyId],
  );
  assert.ok((await familyApi('DELETE', '/assets', { ids: [famShared!.id] })).ok, 'trash it');
  try {
    const annaShared = await annaAsset('shared.jpg');
    await post('/api/moves', { memberId: anna.id, assetIds: [annaShared] });
    await worker.idle();
    const { failed } = (await json<{ failed: { sourceAssetId: string; error: string }[] }>('/api/moves')).body;
    assert.equal(failed.find((f) => f.sourceAssetId === annaShared)?.error, 'the family account has shared.jpg in its trash: restore it or empty the trash, then Retry');
    assert.equal((await asset(annaShared)).visibility, 'timeline');
  } finally {
    assert.ok((await familyApi('POST', '/trash/restore/assets', { ids: [famShared!.id] })).ok, 'restore it');
  }
});

test('move 3 photos: queued, done, originals archived, copies in the family timeline', async () => {
  assert.equal(guard.ok, true, guard.problems.join('; '));
  const ids = Object.values(moved).map((i) => i.id);
  const res = await post('/api/moves', { memberId: bob.id, assetIds: ids });
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { queued: 3, alreadyQueued: 0 });

  await worker.idle();
  const summary = (await json<{ done: number; failed: { sourceAssetId: string }[] }>('/api/moves')).body;
  assert.deepEqual([summary.done, summary.failed.filter((f) => ids.includes(f.sourceAssetId))], [3, []]);

  for (const i of Object.values(moved)) assert.equal((await asset(i.id)).visibility, 'archive', i.fileName);
  for (const i of Object.values(moved)) await assertLinked(i.id);
  const bobGrid = (await json<GridItem[]>(`/api/members/${bob.id}/assets`)).body.map((i) => i.fileName);
  assert.ok(!bobGrid.includes('photo-9.jpg') && !bobGrid.includes('photo-10.jpg') && !bobGrid.includes('shared.jpg'));

  // Exactly 1 family copy per original; shared.jpg's is the one the family already had.
  for (const i of Object.values(moved)) assert.equal((await familyCopyOf(i.id)).length, 1, i.fileName);
  assert.ok(familyBefore.has((await familyCopyOf(moved['shared.jpg']!.id))[0]!), 'shared.jpg reused the existing family copy');

  const familyGrid = (await json<GridItem[]>('/api/family/assets')).body;
  const newCopies = familyGrid.filter((i) => !familyBefore.has(i.id));
  assert.deepEqual(newCopies.map((i) => i.fileName).sort(), ['photo-10.jpg', 'photo-9.jpg']);
  // Each has an origin now (Bob's archived original) → can be given back.
  const byName = new Map(familyGrid.map((i) => [i.fileName, i]));
  for (const n of ['photo-9.jpg', 'photo-10.jpg', 'shared.jpg']) assert.equal(byName.get(n)!.noOrigin, false, n);
  assert.equal(byName.get('family-only.jpg')!.noOrigin, true);
});

test("photo-9's edits are on its family copy, with the original's time zone", async () => {
  const [copy] = await familyCopyOf(moved['photo-9.jpg']!.id);
  const exif = async (id: string) =>
    (await db.query<Record<string, unknown>>(
      `SELECT description, "dateTimeOriginal", "timeZone", latitude, longitude, rating FROM asset_exif WHERE "assetId" = $1`, [id],
    ))[0]!;
  // Immich extracts the uploaded file's metadata in a background job; it must not undo the edit.
  await new Promise((r) => setTimeout(r, 3000));
  assert.deepEqual(await exif(copy!), await exif(moved['photo-9.jpg']!.id));
  assert.equal((await asset(copy!)).localDateTime.toISOString(), (await asset(moved['photo-9.jpg']!.id)).localDateTime.toISOString());
});

test("what can't move is queued, then fails with Immich's reason; nothing written", async () => {
  const nonPrimary = annaIds['burst-2.jpg']!;
  const archived = moved['photo-10.jpg']!; // moved above → archived
  const res = await post('/api/moves', { memberId: anna.id, assetIds: [nonPrimary, archived.id] });
  assert.deepEqual(res.body, { queued: 2, alreadyQueued: 0 });
  await worker.idle();
  const { failed } = (await json<{ failed: { sourceAssetId: string; fileName: string; step: string; error: string }[] }>('/api/moves')).body;
  const byId = new Map(failed.map((f) => [f.sourceAssetId, f]));
  assert.deepEqual(byId.get(nonPrimary), { ...byId.get(nonPrimary)!, fileName: 'burst-2.jpg', step: 'queued', error: 'part of a stack: move the stack by its primary photo' });
  assert.equal(byId.get(archived.id)!.error, "asset is not on the member's timeline (it is archive)");
  assert.equal((await asset(nonPrimary)).visibility, 'timeline');
  assert.equal((await familyCopyOf(nonPrimary)).length, 0);
});

test('live photo: video + still copied and linked, video hidden; only the still archived', async () => {
  const still = annaIds['live-still.jpg']!;
  const video = annaIds['live-motion.mp4']!;
  await post('/api/moves', { memberId: anna.id, assetIds: [still] });
  await worker.idle();
  const [famStill] = await familyCopyOf(still);
  const [famVideo] = await familyCopyOf(video);
  assert.ok(famStill && famVideo);
  const [s] = await db.query<{ livePhotoVideoId: string; visibility: string }>(`SELECT "livePhotoVideoId", visibility FROM asset WHERE id = $1`, [famStill]);
  assert.deepEqual(s, { livePhotoVideoId: famVideo, visibility: 'timeline' });
  assert.equal((await asset(famVideo)).visibility, 'hidden', 'Immich hid the family video');
  assert.equal((await asset(still)).visibility, 'archive');
  assert.equal((await asset(video)).visibility, 'hidden', 'original video untouched');
  await assertLinked(still);
  await assertLinked(video);
  const familyGrid = (await json<GridItem[]>('/api/family/assets')).body;
  const live = familyGrid.find((i) => i.id === famStill)!;
  assert.deepEqual([live.livePhotoVideoId, live.noOrigin], [famVideo, false]);
});

test('stack: picked by its primary, moves whole, re-stacked with the same primary; all archived', async () => {
  const [b1, b2, b3] = [annaIds['burst-1.jpg']!, annaIds['burst-2.jpg']!, annaIds['burst-3.jpg']!] as const;
  // burst-2 failed above (not primary): retrying that row would fail again; queue the primary.
  await post('/api/moves', { memberId: anna.id, assetIds: [b1] });
  await worker.idle();
  const copies = (await Promise.all([b1, b2, b3].map(familyCopyOf))).map((c) => c[0]!);
  const stacks = await db.query<{ stackId: string; primaryAssetId: string }>(
    `SELECT a."stackId", st."primaryAssetId" FROM asset a JOIN stack st ON st.id = a."stackId" WHERE a.id = ANY($1::uuid[])`, [copies],
  );
  assert.equal(stacks.length, 3);
  assert.equal(new Set(stacks.map((s) => s.stackId)).size, 1, 'all 3 copies in 1 stack');
  assert.equal(stacks[0]!.primaryAssetId, copies[0]);
  for (const id of [b1, b2, b3]) assert.equal((await asset(id)).visibility, 'archive');
  for (const id of [b1, b2, b3]) await assertLinked(id);
  const annaGrid = (await json<GridItem[]>(`/api/members/${anna.id}/assets`)).body.map((i) => i.fileName);
  assert.ok(!annaGrid.includes('burst-1.jpg'));
  const fam = (await json<GridItem[]>('/api/family/assets')).body.find((i) => i.id === copies[0])!;
  assert.equal(fam.stack?.size, 3);
});

test('archive and restore report each asset', async () => {
  const hidden = (await db.query<{ id: string }>(`SELECT id FROM asset WHERE visibility = 'hidden' LIMIT 1`))[0]!.id;
  const gone = '00000000-0000-4000-8000-000000000bad';
  const archived = moved['photo-10.jpg']!.id;
  assert.deepEqual(await immich.archive([archived, hidden, gone]), [
    { id: archived, result: 'unchanged' },
    { id: hidden, result: 'refused', reason: 'asset is hidden' },
    { id: gone, result: 'refused', reason: 'asset no longer exists' },
  ]);
  assert.equal((await asset(hidden)).visibility, 'hidden', 'hidden live-photo video untouched');
});

test('give back: photo, live photo and stack return to the member; family copies gone, files kept', async () => {
  const photo10 = moved['photo-10.jpg']!.id;
  const still = annaIds['live-still.jpg']!;
  const video = annaIds['live-motion.mp4']!;
  const bursts = ['burst-1.jpg', 'burst-2.jpg', 'burst-3.jpg'].map((f) => annaIds[f]!);
  const fam = async (id: string) => (await familyCopyOf(id))[0]!;
  const familyIds = { photo10: await fam(photo10), still: await fam(still), video: await fam(video), burst: await Promise.all(bursts.map(fam)) };
  const originalFile = async (id: string) => {
    const [r] = await db.query<{ originalPath: string }>(`SELECT "originalPath" FROM asset WHERE id = $1`, [id]);
    return mapImmichPath(r!.originalPath, config.library)!;
  };

  const res = await json<{ queued: number }>('/api/givebacks', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-picker': '1' },
    body: JSON.stringify({ assetIds: [familyIds.photo10, familyIds.still, familyIds.burst[0]] }),
  });
  assert.deepEqual(res.body, { queued: 3, alreadyQueued: 0 });
  await worker.idle();

  for (const id of [photo10, still, ...bursts]) assert.equal((await asset(id)).visibility, 'timeline', id);
  assert.equal((await asset(video)).visibility, 'hidden', "the member's video stays hidden with its still");
  const gone = [familyIds.photo10, familyIds.still, familyIds.video, ...familyIds.burst];
  // Force delete: status 'deleted' at once (not 'trashed'); Immich's job then removes the rows.
  assert.deepEqual(await db.query(`SELECT id FROM asset WHERE id = ANY($1::uuid[]) AND status <> 'deleted'`, [gone]), [], 'force-deleted, not in the trash');
  // Hard-linked before: the original's name kept the data when Immich removed the family name.
  for (const id of [photo10, still, video, ...bursts]) assert.ok(statSync(await originalFile(id)).size > 0, id);

  const bobGrid = (await json<GridItem[]>(`/api/members/${bob.id}/assets`)).body.map((i) => i.fileName);
  assert.ok(bobGrid.includes('photo-10.jpg'));
});

test("give back without an original (family-only.jpg) fails with the reason; nothing deleted", async () => {
  const [famOnly] = await db.query<{ id: string }>(`SELECT id FROM asset WHERE "ownerId" = $1 AND "originalFileName" = 'family-only.jpg' AND "deletedAt" IS NULL`, [familyId]);
  await json('/api/givebacks', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-picker': '1' },
    body: JSON.stringify({ assetIds: [famOnly!.id] }),
  });
  await worker.idle();
  const { failed } = (await json<{ failed: { sourceAssetId: string; kind: string; error: string }[] }>('/api/moves')).body;
  const f = failed.find((x) => x.sourceAssetId === famOnly!.id)!;
  assert.deepEqual([f.kind, f.error], ['giveback', "no original of family-only.jpg in any member's account: giving it back would delete its only copy"]);
  assert.equal((await asset(famOnly!.id)).visibility, 'timeline');
});
