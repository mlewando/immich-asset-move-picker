// Read side against the real local Immich (npm run dev:up && npm run dev:seed), through the real
// HTTP server. Asserts the seeded cases from dev/seed.ts. Run: npm run test:int
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { createDb } from '../../src/immich/db.ts';
import { createImmich, type GridItem, type Member } from '../../src/immich/index.ts';
import { mapImmichPath } from '../../src/immich/paths.ts';
import { openQueue } from '../../src/queue.ts';
import { buildApp } from '../../src/server.ts';

const config = loadConfig(process.env);
const immich = createImmich(config);
const db = createDb(config.db); // for assertions only
const queue = openQueue(':memory:');
const app = await buildApp({
  immich,
  guard: () => undefined,
  queue,
  worker: { kick: () => {}, state: () => ({ running: false, paused: false, pausedReason: [] }) },
});
let base: string;
const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, path);
  return (await res.json()) as T;
};
const familyId = async () =>
  (await fetch(`${config.immich.apiUrl}/users/me`, { headers: { 'x-api-key': config.immich.familyApiKey } }).then((r) => r.json()) as { id: string }).id;

before(async () => {
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
after(async () => {
  await app.close();
  queue.close();
  await immich.close();
  await db.close();
});

const byName = (items: GridItem[]) => new Map(items.map((i) => [i.fileName, i]));

test('members: everyone but the family account', async () => {
  const members = await get<Member[]>('/api/members');
  assert.deepEqual(members.map((m) => m.email), ['admin@example.test', 'anna@example.test', 'bob@example.test']);
  const fam = await familyId();
  assert.ok(!members.some((m) => m.id === fam));
});

test("Anna's timeline: timeline only, 1 entry per stack, badges", async () => {
  const anna = (await get<Member[]>('/api/members')).find((m) => m.email === 'anna@example.test')!;
  const items = await get<GridItem[]>(`/api/members/${anna.id}/assets`);
  const m = byName(items);

  assert.deepEqual([...m.keys()].sort(), [
    'burst-1.jpg', 'clip.mp4', 'live-still.jpg', 'photo-1.jpg', 'photo-2.jpg', 'photo-3.jpg',
    'photo-4.jpg', 'photo-5.jpg', 'photo-6.jpg', 'shared.jpg',
  ], 'no burst-2/3 (stack members), no live-motion.mp4 (hidden video half)');

  assert.deepEqual(m.get('burst-1.jpg')!.stack?.size, 3);
  assert.ok(m.get('live-still.jpg')!.livePhotoVideoId);
  assert.equal(m.get('photo-5.jpg')!.edited, true);
  assert.equal(m.get('clip.mp4')!.type, 'video');
  assert.equal(m.get('clip.mp4')!.durationMs, 3000);
  assert.deepEqual(items.filter((i) => i.inFamily).map((i) => i.fileName), ['shared.jpg']);
  assert.equal(m.get('photo-1.jpg')!.day, '2026-07-01');
  const days = items.map((i) => i.localDateTime);
  assert.deepEqual(days, [...days].sort().reverse(), 'newest first');
});

test("Anna's albums and the album filter: a stack shows when any member is in the album", async () => {
  const anna = (await get<Member[]>('/api/members')).find((m) => m.email === 'anna@example.test')!;
  const albums = await get<{ id: string; name: string; count: number }[]>(`/api/members/${anna.id}/albums`);
  assert.deepEqual(albums.map((a) => [a.name, a.count]), [['Summer trip', 3]]);
  const items = await get<GridItem[]>(`/api/members/${anna.id}/assets?album=${albums[0]!.id}`);
  assert.deepEqual(items.map((i) => i.fileName).sort(), ['burst-1.jpg', 'photo-1.jpg', 'photo-2.jpg']);
  const bob = (await get<Member[]>('/api/members')).find((m) => m.email === 'bob@example.test')!;
  assert.deepEqual(await get(`/api/members/${bob.id}/albums`), []);
});

test('day range filter: inclusive, by the local (wall-clock) day', async () => {
  const anna = (await get<Member[]>('/api/members')).find((m) => m.email === 'anna@example.test')!;
  const all = await get<GridItem[]>(`/api/members/${anna.id}/assets`);
  const range = await get<GridItem[]>(`/api/members/${anna.id}/assets?from=2026-07-02&to=2026-07-03`);
  assert.ok(range.length > 0);
  assert.deepEqual(range.map((i) => i.id), all.filter((i) => i.day >= '2026-07-02' && i.day <= '2026-07-03').map((i) => i.id));
  const from = await get<GridItem[]>(`/api/members/${anna.id}/assets?from=2026-07-03`);
  assert.deepEqual(from.map((i) => i.id), all.filter((i) => i.day >= '2026-07-03').map((i) => i.id));
});

test('family timeline: its own, nothing moved yet so no origins', async () => {
  const items = await get<GridItem[]>('/api/family/assets');
  assert.deepEqual(items.map((i) => i.fileName).sort(), ['family-only.jpg', 'shared.jpg']);
  assert.ok(items.every((i) => i.noOrigin === true));
});

test('family account is not a picking source', async () => {
  assert.equal((await fetch(`${base}/api/members/${await familyId()}/assets`)).status, 404);
});

test('media: every thumbnail and preview is served; live and plain videos play', async () => {
  const anna = (await get<Member[]>('/api/members')).find((m) => m.email === 'anna@example.test')!;
  const items = await get<GridItem[]>(`/api/members/${anna.id}/assets`);
  for (const i of items) {
    for (const kind of ['thumbnail', 'preview'] as const) {
      const res = await fetch(`${base}/media/${i.id}/${kind}`);
      assert.equal(res.status, 200, `${i.fileName} ${kind}`);
      assert.match(res.headers.get('content-type') ?? '', /^image\//);
      await res.arrayBuffer();
    }
  }
  const m = byName(items);
  for (const videoId of [m.get('clip.mp4')!.id, m.get('live-still.jpg')!.livePhotoVideoId!]) {
    const res = await fetch(`${base}/media/${videoId}/video`, { headers: { range: 'bytes=0-1023' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal((await res.arrayBuffer()).byteLength, 1024);
  }
  assert.equal((await fetch(`${base}/media/${m.get('photo-1.jpg')!.id}/video`)).status, 404, 'image has no video');

  // Edited photo: the edited thumbnail (what Immich shows), not the original one.
  const edited = m.get('photo-5.jpg')!;
  const [file] = await db.query<{ path: string }>(
    `SELECT path FROM asset_file WHERE "assetId" = $1 AND type = 'thumbnail' AND "isEdited"`,
    [edited.id],
  );
  const expected = readFileSync(mapImmichPath(file!.path, config.library)!);
  const served = Buffer.from(await (await fetch(`${base}/media/${edited.id}/thumbnail`)).arrayBuffer());
  assert.ok(served.equals(expected));
});
