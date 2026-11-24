// Moves into a family album, and deleting the member's album they came from, against the real
// local Immich (npm run dev:up && npm run dev:seed), through the real HTTP API and worker, with
// the picker's own database role (so a missing grant fails here). Uses Anna's photo-3 to 6, her
// stack (burst-1..3) and live photo. Undoes everything afterwards. Run: npm run test:int
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { createDb } from '../../src/immich/db.ts';
import { createImmich, type FamilyAlbum, type Member } from '../../src/immich/index.ts';
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

// Every job finished or failed, and the album requests decided (the worker does that once the
// queue is empty, in the same run).
const settled = async (): Promise<void> => {
  const until = Date.now() + 120_000;
  for (;;) {
    await worker.idle();
    const c = queue.counts();
    if (c.pending + c.running === 0) return;
    if (Date.now() > until) throw new Error('jobs still unfinished after 2 min');
    await new Promise((r) => setTimeout(r, 250));
  }
};

let base: string;
const json = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: (await res.json()) as T };
};
let csrf: { token: string; cookie: string } | undefined;
const post = async (path: string, body: unknown) => {
  if (!csrf) {
    const res = await fetch(`${base}/api/csrf`);
    csrf = { cookie: res.headers.getSetCookie()[0]!.split(';')[0]!, token: ((await res.json()) as { token: string }).token };
  }
  const headers = { 'content-type': 'application/json', 'csrf-token': csrf.token, cookie: csrf.cookie };
  return json<Record<string, unknown>>(path, { method: 'POST', headers, body: JSON.stringify(body) });
};

// Immich as a user (the picker never does this): albums of Anna's to move from, cleanup.
const login = async (email: string) =>
  ((await (await fetch(`${config.immich.apiUrl}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }),
  })).json()) as { accessToken: string }).accessToken;
const as = async <T>(token: string, method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${config.immich.apiUrl}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(res.ok, `${method} ${path} → HTTP ${res.status}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
};

let anna: Member;
let bobId: string;
let familyId: string;
let annaToken: string;
let familyToken: string;
const ids: Record<string, string> = {}; // Anna's file name → asset id
let familyBefore: Set<string>;
const familyAlbumsMade: string[] = [];
const sourceAlbumsMade: string[] = [];

const idOf = async (ownerId: string, fileName: string) =>
  (await db.query<{ id: string }>(`SELECT id FROM asset WHERE "ownerId" = $1 AND "originalFileName" = $2 AND "deletedAt" IS NULL`, [ownerId, fileName]))[0]!.id;
const familyCopyOf = async (originalId: string) =>
  (await db.query<{ id: string }>(
    `SELECT f.id FROM asset f JOIN asset o ON o.checksum = f.checksum
      WHERE o.id = $1 AND f."ownerId" = $2 AND f."deletedAt" IS NULL AND f.status = 'active'`,
    [originalId, familyId],
  ))[0]?.id;
const albumAssets = async (albumId: string) =>
  new Set((await db.query<{ assetId: string }>(`SELECT "assetId" FROM album_asset WHERE "albumId" = $1`, [albumId])).map((r) => r.assetId));
const albumExists = async (albumId: string) => (await db.query(`SELECT 1 FROM album WHERE id = $1`, [albumId])).length > 0;
const albumEvents = async (assetId: string) => {
  const { jobs } = (await json<{ jobs: { id: number; sourceAssetId: string }[] }>('/api/jobs/list?section=done')).body;
  const job = jobs.find((j) => j.sourceAssetId === assetId)!;
  const events = (await json<{ type: string; step: string; message: string | null; outcome: string | null }[]>(`/api/jobs/${job.id}/events`)).body;
  return events.filter((e) => e.type === 'album' || e.step === 'albumed').map((e) => [e.type, e.outcome, e.message]);
};
const sourceAlbum = async (name: string, assetIds: string[], shareWith?: string) => {
  const a = await as<{ id: string }>(annaToken, 'POST', '/albums', {
    albumName: name, assetIds, ...(shareWith ? { albumUsers: [{ userId: shareWith, role: 'viewer' }] } : {}),
  });
  sourceAlbumsMade.push(a.id);
  return a.id;
};
const unique = (name: string) => `${name} ${Date.now().toString(36)}`;

before(async () => {
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  const members = (await json<Member[]>('/api/members')).body;
  anna = members.find((m) => m.email === 'anna@example.test')!;
  bobId = members.find((m) => m.email === 'bob@example.test')!.id;
  familyId = ((await (await fetch(`${config.immich.apiUrl}/users/me`, { headers: { 'x-api-key': config.immich.familyApiKey } })).json()) as { id: string }).id;
  annaToken = await login('anna@example.test');
  familyToken = await login('family-photos@example.test');
  for (const f of ['photo-3.jpg', 'photo-4.jpg', 'photo-5.jpg', 'photo-6.jpg', 'burst-1.jpg', 'burst-2.jpg', 'burst-3.jpg', 'live-still.jpg', 'live-motion.mp4']) {
    ids[f] = await idOf(anna.id, f);
  }
  familyBefore = new Set((await db.query<{ id: string }>(`SELECT id FROM asset WHERE "ownerId" = $1`, [familyId])).map((r) => r.id));
});

after(async () => {
  try {
    // Albums before assets: Immich deletes force-deleted assets in a background job that
    // deadlocks with an album delete on album_asset.
    for (const id of familyAlbumsMade) if (await albumExists(id)) await as(familyToken, 'DELETE', `/albums/${id}`);
    for (const id of sourceAlbumsMade) if (await albumExists(id)) await as(annaToken, 'DELETE', `/albums/${id}`);
    const originals = Object.entries(ids).filter(([f]) => f !== 'live-motion.mp4').map(([, id]) => id); // the video stays hidden
    await immich.restore(originals);
    const created = (await db.query<{ id: string }>(`SELECT id FROM asset WHERE "ownerId" = $1`, [familyId])).map((r) => r.id).filter((id) => !familyBefore.has(id));
    if (created.length) await as(familyToken, 'DELETE', '/assets', { ids: created, force: true });
  } finally {
    await app.close();
    queue.close();
    await immich.close();
    await db.close();
  }
});

test('the guard passes with the album grants and key permissions', () => {
  assert.equal(guard.ok, true, guard.problems.join('; '));
});

test('move into a new album, deleting the source album it empties (shared, so its sharing goes too)', async () => {
  const name = unique('Picker int new');
  const source = await sourceAlbum(unique('Picker int source'), [ids['photo-3.jpg']!], bobId);
  const res = await post('/api/moves', { memberId: anna.id, assetIds: [ids['photo-3.jpg']], album: { name }, deleteAlbumId: source });
  assert.equal(res.status, 202);
  const album = res.body.album as { id: string; name: string; created: boolean };
  familyAlbumsMade.push(album.id);
  assert.deepEqual([album.name, album.created], [name, true]);
  await settled();

  const copy = await familyCopyOf(ids['photo-3.jpg']!);
  assert.ok(copy && (await albumAssets(album.id)).has(copy), 'the family copy is in the new album');
  const listed = (await json<FamilyAlbum[]>('/api/family/albums')).body.find((a) => a.id === album.id);
  assert.deepEqual([listed?.count, listed?.coverId], [1, copy]);
  assert.equal(await albumExists(source), false, 'the source album is deleted');
  assert.equal((await db.query(`SELECT 1 FROM album_user WHERE "albumId" = $1`, [source])).length, 0, 'its sharing went with it');
  const [albumed, deleted] = await albumEvents(ids['photo-3.jpg']!);
  assert.deepEqual(albumed, ['step', null, `Album «${name}»`]);
  assert.deepEqual(deleted!.slice(0, 2), ['album', 'deleted']);
  assert.match(String(deleted![2]), /^Anna's album «Picker int source \w+» deleted, with its sharing with Bob$/);

  // The same name again (other letter case) is that album, not a 2nd one.
  const again = await post('/api/moves', { memberId: anna.id, assetIds: [ids['photo-4.jpg']], album: { name: ` ${name.toUpperCase()} ` } });
  assert.deepEqual(again.body.album, { id: album.id, name, created: false });
  await settled();
  assert.equal((await albumAssets(album.id)).size, 2);
});

test('stack and live photo into an existing album: its primary and the still, as Immich adds them', async () => {
  const made = await as<{ id: string }>(familyToken, 'POST', '/albums', { albumName: unique('Picker int existing') });
  familyAlbumsMade.push(made.id);
  const [primary] = await db.query<{ primaryAssetId: string }>(
    `SELECT st."primaryAssetId" FROM stack st JOIN asset a ON a."stackId" = st.id WHERE a.id = $1`, [ids['burst-1.jpg']],
  );
  const res = await post('/api/moves', { memberId: anna.id, assetIds: [primary!.primaryAssetId, ids['live-still.jpg']], album: { id: made.id } });
  assert.equal(res.status, 202);
  await settled();
  const inAlbum = await albumAssets(made.id);
  const expected = new Set([await familyCopyOf(primary!.primaryAssetId), await familyCopyOf(ids['live-still.jpg']!)]);
  assert.deepEqual(inAlbum, expected, 'only the stack primary and the live still');
});

test('a source album with a photo left on the timeline is kept, and the request closed', async () => {
  const name = unique('Picker int kept');
  const source = await sourceAlbum(name, [ids['photo-5.jpg']!, ids['photo-4.jpg']!]);
  // photo-4 is already moved (archived) by an earlier test; photo-5 is left out of this move.
  await immich.restore([ids['photo-5.jpg']!]);
  const res = await post('/api/moves', { memberId: anna.id, assetIds: [ids['photo-6.jpg']], deleteAlbumId: source });
  assert.equal(res.status, 202);
  await settled();
  assert.equal(await albumExists(source), true);
  assert.deepEqual(queue.openCleanups(), []);
  assert.deepEqual((await albumEvents(ids['photo-6.jpg']!)).at(-1), ['album', 'kept', `Anna's album «${name}» kept: 1 photo still on the timeline`]);
});

test('a family album deleted before the job runs: the move goes on, not added', async () => {
  const made = await as<{ id: string }>(familyToken, 'POST', '/albums', { albumName: unique('Picker int gone') });
  await as(familyToken, 'DELETE', `/albums/${made.id}`);
  queue.enqueue('move', [ids['photo-5.jpg']!], { memberId: anna.id, album: { id: made.id, name: 'Gone' } });
  worker.kick();
  await settled();
  assert.deepEqual(queue.failed(), []);
  assert.deepEqual(await albumEvents(ids['photo-5.jpg']!), [['step', 'gone', 'Album «Gone»']]);
  assert.equal((await db.query<{ visibility: string }>(`SELECT visibility FROM asset WHERE id = $1`, [ids['photo-5.jpg']]))[0]!.visibility, 'archive');
});
