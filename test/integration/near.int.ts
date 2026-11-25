// A member's grid near a family album, and the suggested album, against the real local Immich
// (npm run dev:up && npm run dev:seed), through the real HTTP API and worker. Moves Anna's photo-1
// (1 Jul 2026) into a new family album, so the album's days are 1 Jul; undoes it afterwards.
// Run: npm run test:int
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { createDb } from '../../src/immich/db.ts';
import { createImmich, type FamilyAlbum, type GridItem, type Member } from '../../src/immich/index.ts';
import { openQueue } from '../../src/queue.ts';
import { buildApp } from '../../src/server.ts';
import { createWorker } from '../../src/worker.ts';

const config = loadConfig(process.env);
const immich = createImmich(config);
const db = createDb(config.db); // the picker's role: assertions (reads) only
const queue = openQueue(':memory:');
const guard = await immich.check();
const worker = createWorker({ queue, immich, guard: async () => guard, log: { info: () => {}, error: () => {} }, waitCheckMs: 500 });
const app = await buildApp({ immich, guard: () => guard, queue, worker });

let base: string;
let anna: Member;
let familyId: string;
let familyToken: string;
let photo1: string;
let familyBefore: Set<string>;
let album: { id: string; name: string };

const json = async <T>(path: string): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as T };
};
const days = (items: GridItem[]) => [...new Set(items.map((i) => i.day))].sort();

before(async () => {
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  anna = (await json<Member[]>('/api/members')).body.find((m) => m.email === 'anna@example.test')!;
  familyId = ((await (await fetch(`${config.immich.apiUrl}/users/me`, { headers: { 'x-api-key': config.immich.familyApiKey } })).json()) as { id: string }).id;
  familyToken = ((await (await fetch(`${config.immich.apiUrl}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'family-photos@example.test', password: 'password123' }),
  })).json()) as { accessToken: string }).accessToken;
  photo1 = (await db.query<{ id: string }>(
    `SELECT id FROM asset WHERE "ownerId" = $1 AND "originalFileName" = 'photo-1.jpg' AND "deletedAt" IS NULL`, [anna.id],
  ))[0]!.id;
  familyBefore = new Set((await db.query<{ id: string }>(`SELECT id FROM asset WHERE "ownerId" = $1`, [familyId])).map((r) => r.id));

  // A family album by a move, as the picker makes them.
  const res = await fetch(`${base}/api/csrf`);
  const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
  const { token } = (await res.json()) as { token: string };
  const moved = await fetch(`${base}/api/moves`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'csrf-token': token, cookie },
    body: JSON.stringify({ memberId: anna.id, assetIds: [photo1], album: { name: `Picker int near ${Date.now().toString(36)}` } }),
  });
  assert.equal(moved.status, 202);
  album = ((await moved.json()) as { album: { id: string; name: string } }).album;
  const until = Date.now() + 120_000;
  for (;;) {
    await worker.idle();
    const c = queue.counts();
    if (c.pending + c.running === 0) break;
    if (Date.now() > until) throw new Error('move still unfinished after 2 min');
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.deepEqual(queue.failed(), []);
});

after(async () => {
  try {
    // Album before assets: Immich's background delete of force-deleted assets deadlocks with it.
    if (album) {
      await fetch(`${config.immich.apiUrl}/albums/${album.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${familyToken}` } });
    }
    await immich.restore([photo1]);
    const created = (await db.query<{ id: string }>(`SELECT id FROM asset WHERE "ownerId" = $1`, [familyId])).map((r) => r.id).filter((id) => !familyBefore.has(id));
    if (created.length) {
      await fetch(`${config.immich.apiUrl}/assets`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${familyToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ids: created, force: true }),
      });
    }
  } finally {
    await app.close();
    queue.close();
    await immich.close();
    await db.close();
  }
});

test('the moved photo makes the family album’s days', async () => {
  const listed = (await json<FamilyAlbum[]>('/api/family/albums')).body.find((a) => a.id === album.id);
  assert.deepEqual([listed?.from, listed?.to, listed?.count], ['2026-07-01', '2026-07-01', 1]);
});

test('near: the album’s own days, then widened by before/after, narrowed by the other filters', async () => {
  const near = async (q: string) => (await json<GridItem[]>(`/api/members/${anna.id}/assets?near=${album.id}${q}`)).body;
  const own = await near('');
  assert.deepEqual(days(own), ['2026-07-01']);
  assert.ok(own.length > 0 && !own.some((i) => i.id === photo1), 'the moved photo is archived, off the grid');
  assert.deepEqual(days(await near('&after=2')), ['2026-07-01', '2026-07-02', '2026-07-03']);
  assert.deepEqual(days(await near('&after=2&from=2026-07-02')), ['2026-07-02', '2026-07-03']);
  assert.deepEqual(await near('&to=2026-06-30'), []);
  assert.deepEqual(days(await near('&before=30')), ['2026-07-01'], 'Anna has nothing in June');
});

test('near a family album that is not there: 404 no such album', async () => {
  const res = await json(`/api/members/${anna.id}/assets?near=00000000-0000-4000-8000-000000000bad`);
  assert.deepEqual([res.status, res.body], [404, { error: 'no such album' }]);
});

test('suggestion: the album, counting Anna’s photos on its days the family lacks; skip passes it over', async () => {
  // Other family albums (made by hand in the dev Immich) are passed over, so only this one counts.
  const others = (await json<FamilyAlbum[]>('/api/family/albums')).body.filter((a) => a.id !== album.id).map((a) => `skip=${a.id}`);
  const unmoved = (await json<GridItem[]>(`/api/members/${anna.id}/assets?near=${album.id}`)).body.filter((i) => !i.inFamily).length;
  const q = others.length ? `?${others.join('&')}` : '';
  assert.deepEqual((await json(`/api/members/${anna.id}/suggestion${q}`)).body, { suggestion: { albumId: album.id, count: unmoved } });
  const all = [...others, `skip=${album.id}`].join('&');
  assert.deepEqual((await json(`/api/members/${anna.id}/suggestion?${all}`)).body, { suggestion: null });
});
