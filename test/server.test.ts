import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import type { GridItem, GuardResult } from '../src/immich/index.ts';
import { openQueue } from '../src/queue.ts';
import { buildApp, type ServerDeps } from '../src/server.ts';
import { FAMILY_ID, fakeImmich, fakeWorker, serverDeps, withCsrf } from './fakes.ts';

const failedGuard: GuardResult = { ok: false, problems: ['Immich version 3.4.2 not supported (supported: 3.4.1)'], checkedAt: new Date() };
const guardOk = () => ({ ok: true, problems: [], checkedAt: new Date() });
const ANNA = '00000000-0000-4000-8000-0000000a0001';
const ASSET = '00000000-0000-4000-8000-00000000a551';
const item = (id: string): GridItem => ({
  id, type: 'image', localDateTime: '2026-07-01T09:12:00.000Z', day: '2026-07-01', fileName: 'x.jpg',
  width: 10, height: 10, durationMs: null, livePhotoVideoId: null, stack: null, edited: false,
});

// Local files mediaFile() may return: 1 video (bytes 0..99), 1 thumbnail, 1 dotfile.
const root = mkdtempSync(join(tmpdir(), 'picker-test-'));
mkdirSync(join(root, 'u1'), { recursive: true });
writeFileSync(join(root, 'u1/v.mp4'), Buffer.from(Array.from({ length: 100 }, (_, i) => i)));
writeFileSync(join(root, 'u1/.picker-x.tmp'), 'tmp');
writeFileSync(join(root, 'u1/t.webp'), 'webp');
after(() => rmSync(root, { recursive: true, force: true }));

// Fresh app per call, with the given deps overriding healthy defaults; no network port. A write
// gets its CSRF token the way the page does, unless it brings its own csrf-token header.
async function call(over: Partial<ServerDeps>, req: InjectOptions | string) {
  const app = await buildApp(serverDeps(over));
  try {
    const write = typeof req !== 'string' && req.method && req.method !== 'GET' && !req.headers?.['csrf-token'];
    return await app.inject(write ? await withCsrf(app, req) : req);
  } finally {
    await app.close();
  }
}

test('page: index.html with CSP that allows exactly its import map', async () => {
  const res = await call({}, '/');
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/html/);
  const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(res.body)![1]!;
  const hash = createHash('sha256').update(importMap).digest('base64');
  const csp = String(res.headers['content-security-policy']);
  assert.ok(csp.includes(`script-src 'self' 'sha256-${hash}'`), csp);
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(!csp.includes('upgrade-insecure-requests'), 'not on plain http (dev, tests)');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  // Revalidated on every load, so an update is never hidden behind a heuristically cached app.js.
  assert.equal(res.headers['cache-control'], 'public, max-age=0');
  assert.equal((await call({}, '/app.js')).headers['cache-control'], 'public, max-age=0');
});

test('page: client-side routes load index.html; malformed ones do not', async () => {
  const index = (await call({}, '/')).body;
  for (const url of ['/family', '/queue', `/members/${ANNA}`, `/members/${ANNA}?asset=${ASSET}`]) {
    const res = await call({}, url);
    assert.equal(res.statusCode, 200, url);
    assert.equal(res.body, index, url);
  }
  assert.equal((await call({}, '/members/not-a-uuid')).statusCode, 400);
  assert.equal((await call({}, '/nope')).statusCode, 404);
});

test('page: app modules and the vendored libraries named in the import map are served', async () => {
  const page = (await call({}, '/')).body;
  const { imports } = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(page)![1]!) as { imports: Record<string, string> };
  for (const url of [...Object.values(imports), '/app.js', '/api.js', '/selection.js', '/grid.js', '/viewer.js', '/icons.js', '/jobs.js', '/queue.js', '/expiry.js', '/app.css']) {
    const res = await call({}, url);
    assert.equal(res.statusCode, 200, url);
  }
  assert.match(String((await call({}, '/vendor/preact.mjs')).headers['content-type']), /javascript/);
  assert.equal((await call({}, '/vendor/package.json')).statusCode, 400);
  assert.match(String((await call({}, '/fonts/overpass-latin.woff2')).headers['content-type']), /font\/woff2/);
  assert.equal((await call({}, '/fonts/package.json')).statusCode, 400);
  assert.equal((await call({}, '/../package.json')).statusCode, 404);
});

test('healthz 200 when DB + Immich reachable, even with failed guard', async () => {
  const res = await call({ guard: () => failedGuard }, '/healthz');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { db: 'ok', immich: 'ok', guard: { ok: false, problems: failedGuard.problems } });
});

test('healthz 503 when DB or Immich down', async () => {
  const db = await call({ immich: fakeImmich({ ping: { db: 'error: connect ECONNREFUSED', api: 'ok' } }) }, '/healthz');
  assert.equal(db.statusCode, 503);
  assert.deepEqual(db.json(), { db: 'error: connect ECONNREFUSED', immich: 'ok', guard: { ok: false, problems: ['not checked yet'] } });
  const api = await call({ immich: fakeImmich({ ping: { db: 'ok', api: 'error: fetch failed' } }) }, '/healthz');
  assert.equal(api.statusCode, 503);
  assert.equal(api.json().immich, 'error: fetch failed');
});

test('healthz: basic auth when credentials are set', async () => {
  const app = await buildApp(serverDeps(), { healthz: { user: 'probe', password: 'pw' } });
  const basic = (s: string) => ({ authorization: `Basic ${Buffer.from(s).toString('base64')}` });
  const none = await app.inject('/healthz');
  assert.equal(none.statusCode, 401);
  assert.match(String(none.headers['www-authenticate']), /^Basic /);
  assert.ok(!('db' in none.json()));
  assert.equal((await app.inject({ url: '/healthz', headers: basic('probe:wrong') })).statusCode, 401);
  assert.equal((await app.inject({ url: '/healthz', headers: basic('probe:pw') })).statusCode, 200);
  await app.close();
});

test('status reports read-only mode from the guard', async () => {
  assert.deepEqual((await call({ guard: () => failedGuard }, '/api/status')).json(), {
    readOnly: true,
    problems: failedGuard.problems,
    user: null,
  });
  assert.deepEqual((await call({ guard: guardOk }, '/api/status')).json(), { readOnly: false, problems: [], user: null });
});

test('check again: allowed while read-only, runs the worker\'s check, answers with the fresh status', async () => {
  const recheck = { method: 'POST', url: '/api/recheck' } as const;
  let guard: GuardResult = failedGuard;
  const worker = { ...fakeWorker(), recheck: async () => ((guard = guardOk()), worker.state()) };
  const res = await call({ guard: () => guard, worker }, recheck);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { readOnly: false, problems: [] });

  const still = fakeWorker();
  const failed = await call({ guard: () => failedGuard, worker: still }, recheck);
  assert.deepEqual(failed.json(), { readOnly: true, problems: failedGuard.problems });
  assert.equal(still.rechecks(), 1);
  assert.equal((await call({}, { ...recheck, headers: { 'csrf-token': 'forged' } })).statusCode, 403);
});

test('a write needs the CSRF token from GET /api/csrf, with its cookie', async () => {
  const app = await buildApp(serverDeps({ guard: guardOk }));
  const body = { method: 'POST', url: '/api/givebacks', payload: { assetIds: [ASSET] } } as const;
  assert.equal((await app.inject(body)).statusCode, 403, 'no token');
  const ok = await withCsrf(app, body);
  assert.equal((await app.inject({ ...ok, headers: { 'csrf-token': 'forged' } })).statusCode, 403, 'wrong token');
  assert.equal((await app.inject({ ...ok, cookies: {} })).statusCode, 403, 'token without its cookie');
  assert.equal((await app.inject(ok)).statusCode, 202);
  assert.equal((await call({}, { method: 'POST', url: '/api/members' })).statusCode, 404, 'with a token: routed normally');
  await app.close();
});

// --- moves ------------------------------------------------------------------------------------
const members = () => fakeImmich({ members: [{ id: ANNA, name: 'Anna', email: 'a@x', hasPhotos: true }], names: { [ASSET]: 'f.jpg' } });
const post = (url: string, payload?: unknown): InjectOptions => ({ method: 'POST', url, payload: payload as object });

test('moves: queues every id (the worker decides what can move), kicks the worker, not twice', async () => {
  const queue = openQueue(':memory:');
  const worker = fakeWorker();
  const other = '00000000-0000-4000-8000-00000000a552';
  const res = await call({ guard: guardOk, immich: members(), queue, worker }, post('/api/moves', { memberId: ANNA, assetIds: [ASSET, other] }));
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json(), { queued: 2, alreadyQueued: 0 });
  assert.equal(worker.kicks(), 1);

  // Same asset again while its move is unfinished → not queued twice.
  const again = await call({ guard: guardOk, immich: members(), queue, worker }, post('/api/moves', { memberId: ANNA, assetIds: [ASSET] }));
  assert.deepEqual(again.json(), { queued: 0, alreadyQueued: 1 });
  assert.equal(worker.kicks(), 1);
});

test('moves: refused while read-only, for the family account, bad body', async () => {
  const body = { memberId: ANNA, assetIds: [ASSET] };
  assert.equal((await call({ guard: () => failedGuard, immich: members() }, post('/api/moves', body))).statusCode, 409);
  assert.equal((await call({ guard: guardOk, immich: members() }, post('/api/moves', { memberId: FAMILY_ID, assetIds: [ASSET] }))).statusCode, 404);
  // (Unknown extra fields are stripped by Fastify's validator, not rejected.)
  for (const bad of [{}, { memberId: ANNA, assetIds: [] }, { memberId: ANNA, assetIds: ['x'] }, { memberId: ANNA, assetIds: [ASSET, ASSET] }]) {
    assert.equal((await call({ guard: guardOk, immich: members() }, post('/api/moves', bad))).statusCode, 400, JSON.stringify(bad));
  }
});

test('give backs: queued as kind giveback, kick, not twice; refused while read-only; bad body', async () => {
  const queue = openQueue(':memory:');
  const worker = fakeWorker();
  const res = await call({ guard: guardOk, queue, worker }, post('/api/givebacks', { assetIds: [ASSET] }));
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json(), { queued: 1, alreadyQueued: 0 });
  assert.equal(worker.kicks(), 1);
  assert.equal(queue.claimNext()!.kind, 'giveback');
  assert.deepEqual((await call({ guard: guardOk, queue, worker }, post('/api/givebacks', { assetIds: [ASSET] }))).json(), { queued: 0, alreadyQueued: 1 });
  assert.equal((await call({ guard: () => failedGuard }, post('/api/givebacks', { assetIds: [ASSET] }))).statusCode, 409);
  assert.equal((await call({ guard: guardOk }, post('/api/givebacks', { assetIds: ['x'] }))).statusCode, 400);
});

test('moves: summary (file names from Immich) and retry', async () => {
  const queue = openQueue(':memory:');
  queue.enqueue('move', [ASSET], { memberId: ANNA });
  const m = queue.claimNext()!;
  queue.fail(m.id, 'asset is in the trash');
  const worker = fakeWorker();
  const summary = (await call({ immich: members(), queue, worker }, '/api/jobs')).json();
  assert.equal(summary.failed[0].fileName, 'f.jpg');
  assert.equal(summary.failed[0].error, 'asset is in the trash');
  assert.equal(summary.failed[0].step, 'queued');
  assert.deepEqual(summary.worker, { running: false, paused: false, pausedReason: [] });

  assert.equal((await call({ guard: guardOk, queue, worker }, post(`/api/jobs/${m.id}/retry`))).statusCode, 202);
  assert.equal(queue.counts().pending, 1);
  assert.equal(worker.kicks(), 1);
  assert.equal((await call({ guard: guardOk, queue, worker }, post(`/api/jobs/${m.id}/retry`))).statusCode, 404, 'not failed any more');
});

test('queue page: sections with each job\'s asset and file name; a job\'s history', async () => {
  const ORIGINAL = '00000000-0000-4000-8000-00000000a552';
  const queue = openQueue(':memory:');
  queue.enqueue('move', [ASSET], { memberId: ANNA, requestedBy: 'curator@x' });
  queue.enqueue('giveback', ['00000000-0000-4000-8000-00000000fa77']);
  const m = queue.claimNext()!;
  queue.retryLater(m.id, 'Immich POST /assets: fetch failed', new Date(Date.now() - 1));
  queue.claimNext();
  queue.advance(m.id, { step: 'copied', outcome: 'unknown' });
  queue.advance(m.id, { step: 'thumbnailed', done: true });
  const g = queue.claimNext()!;
  queue.advance(g.id, { step: 'restored', originals: [ORIGINAL], familyIds: [g.sourceAssetId] });
  const immich = fakeImmich({ names: { [ASSET]: 'f.jpg', [ORIGINAL]: 'o.jpg' } });

  const done = (await call({ immich, queue }, '/api/jobs/list?section=done&onlyFailures=true')).json();
  assert.deepEqual(
    done.jobs.map((j: Record<string, unknown>) => [j.thumbAssetId, j.fileName, j.failures, j.requestedBy]),
    [[ASSET, 'f.jpg', 1, 'curator@x']],
  );
  assert.equal(done.next, null);
  const active = (await call({ immich, queue }, '/api/jobs/list?section=active')).json();
  assert.deepEqual(active.jobs.map((j: Record<string, unknown>) => [j.kind, j.thumbAssetId, j.fileName]), [['giveback', ORIGINAL, 'o.jpg']], 'a give back shows the original');
  assert.equal((await call({ queue }, '/api/jobs/list?section=nope')).statusCode, 400);
  assert.equal((await call({ queue }, '/api/jobs/list')).statusCode, 400);

  const events = (await call({ queue }, `/api/jobs/${m.id}/events`)).json();
  assert.deepEqual(events.map((e: Record<string, unknown>) => [e.type, e.outcome]), [['queued', null], ['retrying', null], ['step', 'unknown'], ['done', null]]);
  assert.equal(events[1].message, 'Immich POST /assets: fetch failed');
  assert.equal((await call({ queue }, '/api/jobs/999/events')).statusCode, 404);
  assert.equal((await call({ queue }, '/api/jobs/x/events')).statusCode, 400);
  assert.equal((await call({ queue }, '/api/jobs')).json().retrying, 0);
});

// --- read side --------------------------------------------------------------------------------
test('members are listed; unlisted fields are dropped', async () => {
  const immich = fakeImmich({ members: [{ id: ANNA, name: 'Anna', email: 'anna@example.test', hasPhotos: false, password: 'leak' } as never] });
  const res = await call({ immich }, '/api/members');
  assert.deepEqual(res.json(), [{ id: ANNA, name: 'Anna', email: 'anna@example.test', hasPhotos: false }]);
});

test('member timeline only for a listed member; never the family account', async () => {
  const immich = () =>
    fakeImmich({
      members: [{ id: ANNA, name: 'Anna', email: 'a@x', hasPhotos: true }],
      timelines: { [ANNA]: [item(ASSET)], [FAMILY_ID]: [item(ASSET)] },
    });
  const ok = await call({ immich: immich() }, `/api/members/${ANNA}/assets`);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json<GridItem[]>(), [item(ASSET)]);
  assert.equal((await call({ immich: immich() }, `/api/members/${FAMILY_ID}/assets`)).statusCode, 404);
  const unknown = '00000000-0000-4000-8000-000000000bad';
  assert.equal((await call({ immich: immich() }, `/api/members/${unknown}/assets`)).statusCode, 404);
  assert.equal((await call({ immich: immich() }, '/api/members/not-a-uuid/assets')).statusCode, 400);
});

test('member timeline filter: album + day range passed on; malformed values → 400', async () => {
  const ALBUM = '00000000-0000-4000-8000-0000000a1b01';
  const immich = fakeImmich({ members: [{ id: ANNA, name: 'Anna', email: 'a@x', hasPhotos: true }] });
  const ok = await call({ immich }, `/api/members/${ANNA}/assets?album=${ALBUM}&from=2026-07-01&to=2026-07-31`);
  assert.equal(ok.statusCode, 200);
  assert.ok(immich.calls.includes(`memberTimeline ${ANNA} {"albumId":"${ALBUM}","from":"2026-07-01","to":"2026-07-31"}`), immich.calls.join());
  for (const q of ['album=x', 'from=2026-13-01', 'to=yesterday']) {
    assert.equal((await call({ immich }, `/api/members/${ANNA}/assets?${q}`)).statusCode, 400, q);
  }
});

test('member albums: only for a listed member', async () => {
  const albums = [{ id: '00000000-0000-4000-8000-0000000a1b01', name: 'Holiday', count: 3, from: '2026-07-01', to: '2026-07-14' }];
  const immich = fakeImmich({ members: [{ id: ANNA, name: 'Anna', email: 'a@x', hasPhotos: true }], albums: { [ANNA]: albums } });
  assert.deepEqual((await call({ immich }, `/api/members/${ANNA}/albums`)).json(), albums);
  assert.equal((await call({ immich }, `/api/members/${FAMILY_ID}/albums`)).statusCode, 404);
});

test('family timeline', async () => {
  const res = await call({ immich: fakeImmich({ timelines: { [FAMILY_ID]: [{ ...item(ASSET), noOrigin: true }] } }) }, '/api/family/assets');
  assert.deepEqual(res.json(), [{ ...item(ASSET), noOrigin: true }]);
});

test('timelines leave out assets with an unfinished job of their kind; back once it is done', async () => {
  const OTHER = '00000000-0000-4000-8000-00000000a552';
  const immich = fakeImmich({
    members: [{ id: ANNA, name: 'Anna', email: 'a@x', hasPhotos: true }],
    timelines: { [ANNA]: [item(ASSET), item(OTHER)], [FAMILY_ID]: [item(ASSET), item(OTHER)] },
  });
  const queue = openQueue(':memory:');
  const ids = async (url: string) => (await call({ immich, queue }, url)).json<GridItem[]>().map((i) => i.id);
  queue.enqueue('move', [ASSET], { memberId: ANNA });
  assert.deepEqual(await ids(`/api/members/${ANNA}/assets`), [OTHER], 'pending move hidden');
  assert.deepEqual(await ids('/api/family/assets'), [ASSET, OTHER], 'a move does not hide family assets');

  const move = queue.claimNext()!;
  queue.fail(move.id, 'boom');
  assert.deepEqual(await ids(`/api/members/${ANNA}/assets`), [OTHER], 'failed move still hidden');

  queue.enqueue('giveback', [OTHER]);
  assert.deepEqual(await ids('/api/family/assets'), [ASSET], 'pending give back hidden');
  queue.retry(move.id);
  queue.claimNext(); // the move, again
  queue.advance(move.id, { step: 'linked', done: true });
  const giveback = queue.claimNext()!;
  queue.advance(giveback.id, { step: 'deleted', done: true });
  assert.deepEqual(await ids(`/api/members/${ANNA}/assets`), [ASSET, OTHER], 'done → shown (if Immich still lists it)');
  assert.deepEqual(await ids('/api/family/assets'), [ASSET, OTHER]);
});

test('Immich down → 500 without internals', async () => {
  const res = await call({ immich: fakeImmich({ down: new Error('connect ECONNREFUSED 127.0.0.1:2283') }) }, '/api/family/assets');
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: 'internal error' });
});

test('media: thumbnail served with content type', async () => {
  const res = await call({ immich: fakeImmich({ media: { [`${ASSET}/thumbnail`]: join(root, 'u1/t.webp') } }) }, `/media/${ASSET}/thumbnail`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.equal(res.body, 'webp');
});

test('media: video supports Range', async () => {
  const over = { immich: fakeImmich({ media: { [`${ASSET}/video`]: join(root, 'u1/v.mp4') } }) };
  const url = `/media/${ASSET}/video`;
  const full = await call(over, url);
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.rawPayload.length, 100);

  const part = await call(over, { url, headers: { range: 'bytes=10-19' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], 'bytes 10-19/100');
  assert.deepEqual([...part.rawPayload], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

  const bad = await call(over, { url, headers: { range: 'bytes=500-' } });
  assert.equal(bad.statusCode, 416);
  assert.equal(bad.headers['content-range'], 'bytes */100');
});

test('media: 404 for no file, dotfile; 400 for unknown kind', async () => {
  const over = { immich: fakeImmich({ media: { [`${ASSET}/thumbnail`]: join(root, 'u1/.picker-x.tmp') } }) };
  assert.equal((await call(over, `/media/${ASSET}/thumbnail`)).statusCode, 404, 'dotfile');
  assert.equal((await call(over, `/media/${ASSET}/preview`)).statusCode, 404, 'no file');
  assert.equal((await call(over, `/media/${ASSET}/original`)).statusCode, 400);
});

test('media: 503 to ask again while Immich is still making the thumbnail', async () => {
  const res = await call({ immich: fakeImmich({ media: { [`${ASSET}/thumbnail`]: 'pending' } }) }, `/media/${ASSET}/thumbnail`);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['retry-after'], '5');
  assert.equal(res.headers['cache-control'], 'no-store');
});
