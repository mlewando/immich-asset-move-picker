// The move steps and the worker, over the real (in-memory) SQLite queue and a fake Immich.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImmichError } from '../src/immich/api.ts';
import { isTransient, type GiveBackPlan, type GuardResult, type LinkResult, type VisibilityResult } from '../src/immich/index.ts';
import { openQueue, type Queue } from '../src/queue.ts';
import {
  checkThumbnails, createWorker, LINK_MISMATCH, runGiveBack, runMove, THUMBNAIL_STALL_MS, type JobDeps,
} from '../src/worker.ts';

const MEMBER = '00000000-0000-4000-8000-0000000a0001';
const ok: GuardResult = { ok: true, problems: [], checkedAt: new Date() };
const bad: GuardResult = { ok: false, problems: ['Immich version 3.4.2 not supported (supported: 3.4.1)'], checkedAt: new Date() };
const silent = { info: () => {}, error: () => {} };

// Fake Immich: asset id → visibility ('missing' = not there); `units` = a picked id's originals
// (a stack), default just itself. Each original is 1 file. Records calls in order.
function fakeImmich(assets: Record<string, string>, units: Record<string, string[]> = {}) {
  const calls: string[] = [];
  const failNext: { copyToFamily?: Error; archive?: Error; delete?: Error } = {};
  // linkToFamily outcome per original id (default 'linked').
  const links: Record<string, LinkResult> = {};
  // Give back: family asset id → its plan (missing = "no original" refusal). family = existing ids.
  const plans: Record<string, GiveBackPlan> = {};
  const family = new Set<string>();
  // Originals whose family copy has no thumbnails yet (default: all ready).
  const noThumbs = new Set<string>();
  // Album names per asset id (default none). Not in `calls`: it only feeds the history.
  const albums: Record<string, string[]> = {};
  // Originals whose bytes the family account already has: not uploaded.
  const inFamily = new Set<string>();
  // A picked id's files and uploads when not 1 per original (a live photo's video).
  const copies: Record<string, { files: number; uploaded: number }> = {};
  const immich: JobDeps['immich'] = {
    async albumsOf(ids) {
      return [...new Set(ids.flatMap((id) => albums[id] ?? []))].sort();
    },
    async missingThumbnails(ids) {
      calls.push(`thumbs:${ids.join(',')}`);
      return new Set(ids.filter((id) => noThumbs.has(id)));
    },
    async prepareGiveBack(id) {
      calls.push(`plan:${id}`);
      if (!plans[id]) throw new Error('no original of x.jpg in any member\'s account: giving it back would delete its only copy');
      return plans[id];
    },
    async restore(ids) {
      calls.push(`restore:${ids.join(',')}`);
      return ids.map((id): VisibilityResult => {
        if (assets[id] === 'archive') return (assets[id] = 'timeline'), { id, result: 'changed' };
        if (assets[id] === 'timeline') return { id, result: 'unchanged' };
        return { id, result: 'refused', reason: `asset is ${assets[id]}` };
      });
    },
    async deleteFromFamily(ids) {
      if (failNext.delete) {
        const e = failNext.delete;
        delete failNext.delete;
        throw e;
      }
      calls.push(`delete:${ids.join(',')}`);
      for (const id of ids) family.delete(id);
    },
    async linkToFamily(ids) {
      calls.push(`link:${ids.join(',')}`);
      return ids.map((id) => links[id] ?? { id, path: `/data/upload/${id}`, result: 'linked' });
    },
    async copyToFamily(id) {
      calls.push(`copy:${id}`);
      if (failNext.copyToFamily) {
        const e = failNext.copyToFamily;
        delete failNext.copyToFamily;
        throw e;
      }
      if (assets[id] !== 'timeline') throw new Error(`asset is not on the member's timeline (it is ${assets[id]})`);
      const originals = units[id] ?? [id];
      const uploaded = originals.filter((o) => !inFamily.has(o));
      for (const o of uploaded) inFamily.add(o); // a repeat finds them
      return { familyAssetId: `fam-${id}`, originals, files: originals.length, uploaded: uploaded.length, ...copies[id] };
    },
    async archive(ids) {
      calls.push(`archive:${ids.join(',')}`);
      if (failNext.archive) {
        const e = failNext.archive;
        delete failNext.archive;
        throw e;
      }
      return ids.map((id): VisibilityResult => {
        if (assets[id] === 'timeline') return (assets[id] = 'archive'), { id, result: 'changed' };
        if (assets[id] === 'archive') return { id, result: 'unchanged' };
        return { id, result: 'refused', reason: `asset is ${assets[id]}` };
      });
    },
  };
  return { immich, calls, failNext, assets, links, plans, family, noThumbs, albums, inFamily, copies };
}

function setup(assets: Record<string, string>, units: Record<string, string[]> = {}) {
  const queue = openQueue(':memory:');
  const im = fakeImmich(assets, units);
  return { queue, ...im, deps: { queue, immich: im.immich } };
}
const claim = (q: Queue, id: string) => {
  q.enqueue('move', [id], { memberId: MEMBER });
  return q.claimNext()!;
};
const row = (q: Queue) => {
  const [f] = q.failed();
  return f ?? null;
};

test('move: copy, archive, hard link, each step recorded', async () => {
  const s = setup({ a: 'timeline' });
  const m = claim(s.queue, 'a');
  await runMove(s.deps, m);
  assert.deepEqual(s.calls, ['copy:a', 'archive:a', 'link:a', 'thumbs:a']);
  assert.equal(s.assets.a, 'archive');
  assert.deepEqual(s.queue.counts(), { pending: 0, running: 0, done: 1, failed: 0 });
});

test("move: the history names the originals' albums with the copy step", async () => {
  const s = setup({ p: 'timeline', b: 'timeline', c: 'timeline' }, { p: ['p', 'b'] });
  s.albums.p = ['Holidays'];
  s.albums.b = ['Garden', 'Holidays'];
  const m = claim(s.queue, 'p');
  await runMove(s.deps, m);
  const copied = s.queue.events(m.id)!.find((e) => e.type === 'step' && e.step === 'copied');
  assert.equal(copied?.message, '2 files copied • In albums: Garden, Holidays');

  const n = claim(s.queue, 'c');
  await runMove(s.deps, n);
  const plain = s.queue.events(n.id)!.find((e) => e.type === 'step' && e.step === 'copied');
  assert.equal(plain?.message, null, '1 file, no albums: no note');
});

const copiedEvent = (q: Queue, jobId: number) => {
  const e = q.events(jobId)!.find((x) => x.step === 'copied' && x.type === 'step')!;
  return [e.outcome, e.message];
};

test('move: the history tells a copy from a photo the family account already had', async () => {
  const s = setup({ a: 'timeline', b: 'timeline' });
  s.inFamily.add('b');
  const a = claim(s.queue, 'a');
  await runMove(s.deps, a);
  assert.deepEqual(copiedEvent(s.queue, a.id), [null, null], 'uploaded: copied');
  const b = claim(s.queue, 'b');
  await runMove(s.deps, b);
  assert.deepEqual(copiedEvent(s.queue, b.id), ['existing', null]);
});

test('move: nothing uploaded on a later try → the history does not say who made the copy', async () => {
  // After a failure tried again on its own, a Retry, and a restart.
  const later: ((q: Queue, id: number) => void)[] = [
    (q, id) => q.retryLater(id, 'Immich PUT /assets → HTTP 502', new Date(Date.now() - 1)),
    (q, id) => (q.fail(id, 'boom'), void q.retry(id)),
    (q) => void q.resetRunning(),
  ];
  for (const earlierTry of later) {
    const s = setup({ a: 'timeline' });
    s.inFamily.add('a'); // uploaded by the earlier try, or there before: the same to this one
    const m = claim(s.queue, 'a');
    earlierTry(s.queue, m.id);
    await runMove(s.deps, s.queue.claimNext()!);
    assert.deepEqual(copiedEvent(s.queue, m.id), ['unknown', null]);
  }

  // Queued before the picker kept a history: no 'queued' entry, so not known to be the 1st try.
  for (const kept of [[], [{ at: '2026-01-01T00:00:00.000Z', type: 'retried', step: 'queued', message: null, by: null, outcome: null }]] as const) {
    const old = setup({ a: 'timeline' });
    old.inFamily.add('a');
    const m = claim(old.queue, 'a');
    await runMove({ ...old.deps, queue: { ...old.queue, events: () => [...kept] } }, m);
    assert.deepEqual(copiedEvent(old.queue, m.id), ['unknown', null]);
  }

  // A later try that uploads: copied.
  const s = setup({ a: 'timeline' });
  const m = claim(s.queue, 'a');
  s.queue.retryLater(m.id, 'boom', new Date(Date.now() - 1));
  await runMove(s.deps, s.queue.claimNext()!);
  assert.deepEqual(copiedEvent(s.queue, m.id), [null, null]);
});

test('stack: the history states its files, and how many were copied where the 1st try knows', async () => {
  const stack = () => setup({ p: 'timeline', b: 'timeline', c: 'timeline' }, { p: ['p', 'b', 'c'] });

  // All uploaded.
  const a = stack();
  const all = claim(a.queue, 'p');
  await runMove(a.deps, all);
  assert.deepEqual(copiedEvent(a.queue, all.id), [null, '3 files copied']);

  // Some already there: copied, with the count of both.
  const s = stack();
  s.inFamily.add('b');
  s.albums.p = ['Holidays'];
  const m = claim(s.queue, 'p');
  await runMove(s.deps, m);
  assert.deepEqual(copiedEvent(s.queue, m.id), [null, '2 of 3 files copied, 1 already there • In album: Holidays']);

  // A later try can't tell them from its own earlier uploads: the files, not how many it copied.
  const t = stack();
  t.inFamily.add('b');
  const n = claim(t.queue, 'p');
  t.queue.retryLater(n.id, 'boom', new Date(Date.now() - 1));
  await runMove(t.deps, t.queue.claimNext()!);
  assert.deepEqual(copiedEvent(t.queue, n.id), [null, '3 files']);

  // None uploaded: already there, as for 1 photo.
  const u = stack();
  u.inFamily.add('p').add('b').add('c');
  const o = claim(u.queue, 'p');
  await runMove(u.deps, o);
  assert.deepEqual(copiedEvent(u.queue, o.id), ['existing', '3 files']);

  // None uploaded on a later try.
  const v = stack();
  v.inFamily.add('p').add('b').add('c');
  const l = claim(v.queue, 'p');
  v.queue.retryLater(l.id, 'boom', new Date(Date.now() - 1));
  await runMove(v.deps, v.queue.claimNext()!);
  assert.deepEqual(copiedEvent(v.queue, l.id), ['unknown', '3 files']);
});

test('live photo: 2 files for 1 original; its video uploaded while the still was there → copied, 1 of 2', async () => {
  const s = setup({ live: 'timeline', other: 'timeline' });
  s.copies.live = { files: 2, uploaded: 1 };
  const m = claim(s.queue, 'live');
  await runMove(s.deps, m);
  assert.deepEqual(copiedEvent(s.queue, m.id), [null, '1 of 2 files copied, 1 already there']);

  s.copies.other = { files: 2, uploaded: 2 };
  const n = claim(s.queue, 'other');
  await runMove(s.deps, n);
  assert.deepEqual(copiedEvent(s.queue, n.id), [null, '2 files copied']);
});

test('stack: every original archived; the list survives a resume', async () => {
  const s = setup({ p: 'timeline', b: 'timeline' }, { p: ['p', 'b'] });
  const m = claim(s.queue, 'p');
  s.failNext.archive = new Error('connect ECONNREFUSED');
  await assert.rejects(runMove(s.deps, m), /ECONNREFUSED/);
  s.queue.fail(m.id, 'x');
  s.queue.retry(m.id);
  const resumed = s.queue.claimNext()!;
  assert.deepEqual(resumed.originals, ['p', 'b']);
  await runMove(s.deps, resumed);
  assert.deepEqual(s.calls, ['copy:p', 'archive:p,b', 'archive:p,b', 'link:p,b', 'thumbs:p,b']);
  assert.deepEqual([s.assets.p, s.assets.b], ['archive', 'archive']);
});

test('a failure before archiving leaves the original on the timeline; resume skips the copy', async () => {
  const s = setup({ a: 'timeline' });
  const m = claim(s.queue, 'a');
  s.failNext.archive = new Error('connect ECONNREFUSED');
  await assert.rejects(runMove(s.deps, m), /ECONNREFUSED/);
  assert.equal(s.assets.a, 'timeline');

  s.queue.fail(m.id, 'x');
  s.queue.retry(m.id);
  const resumed = s.queue.claimNext()!;
  assert.deepEqual([resumed.step, resumed.familyAssetId], ['copied', 'fam-a']);
  s.calls.length = 0;
  await runMove(s.deps, resumed);
  assert.deepEqual(s.calls, ['archive:a', 'link:a', 'thumbs:a']);
  assert.equal(s.queue.counts().done, 1);
});

test('link: a mismatch fails the move (archived, files kept twice), counts it; retry links again', async () => {
  const s = setup({ a: 'timeline' });
  const m = claim(s.queue, 'a');
  s.links.a = { id: 'a', path: '/data/upload/a', result: 'mismatch', reason: 'size differs (original 10, family 11 bytes)' };
  await assert.rejects(runMove(s.deps, m), /not linked: size differs/);
  assert.equal(s.assets.a, 'archive');
  assert.equal(s.queue.counter(LINK_MISMATCH), 1);

  s.queue.fail(m.id, 'x');
  s.queue.retry(m.id);
  const resumed = s.queue.claimNext()!;
  assert.equal(resumed.step, 'archived');
  delete s.links.a;
  s.calls.length = 0;
  await runMove(s.deps, resumed);
  assert.deepEqual(s.calls, ['link:a', 'thumbs:a']);
  assert.equal(s.queue.counts().done, 1);
});

test('link: a missing file fails without counting a mismatch', async () => {
  const s = setup({ a: 'timeline' });
  const m = claim(s.queue, 'a');
  s.links.a = { id: 'a', path: '/data/upload/a', result: 'failed', reason: 'file not found' };
  await assert.rejects(runMove(s.deps, m), /not linked: file not found/);
  assert.equal(s.queue.counter(LINK_MISMATCH), 0);
});

test('resume after archive but before "archived" was recorded: unchanged is fine, move completes', async () => {
  const s = setup({ a: 'archive' });
  const m = claim(s.queue, 'a');
  s.queue.advance(m.id, { step: 'copied', familyAssetId: 'fam-a' });
  await runMove(s.deps, { ...m, step: 'copied' });
  assert.equal(s.queue.counts().done, 1);
});

test("archive refused (member trashed it meanwhile) → Immich's reason", async () => {
  const s = setup({ a: 'timeline' });
  const m = claim(s.queue, 'a');
  s.queue.advance(m.id, { step: 'copied', familyAssetId: 'fam-a' });
  s.assets.a = 'locked';
  await assert.rejects(runMove(s.deps, { ...m, step: 'copied' }), /asset is locked/);
});

test('worker: drains in order; a refused move is recorded failed, the rest continue', async () => {
  const s = setup({ a: 'timeline', b: 'archive', c: 'timeline' });
  s.queue.enqueue('move', ['a', 'b', 'c'], { memberId: MEMBER });
  let guardCalls = 0;
  const wk = createWorker({ ...s.deps, guard: async () => (guardCalls++, ok), log: silent });
  wk.kick();
  await wk.idle();
  assert.deepEqual(s.queue.counts(), { pending: 0, running: 0, done: 2, failed: 1 });
  assert.equal(row(s.queue)!.sourceAssetId, 'b');
  assert.match(row(s.queue)!.error!, /not on the member's timeline \(it is archive\)/);
  assert.equal(guardCalls, 4, 'guard before each move + the final empty check');
});

test('worker: a failed guard pauses it, nothing is claimed', async () => {
  const s = setup({ a: 'timeline' });
  s.queue.enqueue('move', ['a'], { memberId: MEMBER });
  const wk = createWorker({ ...s.deps, guard: async () => bad, log: silent });
  wk.kick();
  await wk.idle();
  assert.equal(s.queue.counts().pending, 1);
  assert.deepEqual(wk.state(), { running: false, paused: true, pausedReason: bad.problems });
});

test('worker: a kick during a drain is not lost', async () => {
  const s = setup({ a: 'timeline', b: 'timeline' });
  s.queue.enqueue('move', ['a'], { memberId: MEMBER });
  const wk = createWorker({ ...s.deps, guard: async () => ok, log: silent });
  wk.kick();
  s.queue.enqueue('move', ['b'], { memberId: MEMBER }); // while the 1st drain runs
  wk.kick();
  await wk.idle();
  assert.equal(s.queue.counts().done, 2);
});

test('worker: retry puts a failed move back and it completes', async () => {
  const s = setup({ a: 'timeline' });
  s.queue.enqueue('move', ['a'], { memberId: MEMBER });
  s.failNext.copyToFamily = new Error('Immich POST /assets → HTTP 502');
  const wk = createWorker({ ...s.deps, guard: async () => ok, log: silent });
  wk.kick();
  await wk.idle();
  const failed = row(s.queue)!;
  assert.equal(failed.error, 'Immich POST /assets → HTTP 502');
  assert.equal(s.queue.retry(failed.id), true);
  wk.kick();
  await wk.idle();
  assert.equal(s.queue.counts().done, 1);
});

// --- waiting for Immich's thumbnails ------------------------------------------------------------
// Moves a, b, … up to 'linked' with no thumbnails yet: all waiting.
const waitingMoves = async (s: ReturnType<typeof setup>, ids: string[]) => {
  for (const id of ids) {
    s.noThumbs.add(id);
    const m = claim(s.queue, id);
    assert.equal(await runMove(s.deps, m), 'waiting');
    s.queue.wait(m.id);
  }
  s.calls.length = 0;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('thumbnails not ready: the move waits at "linked", not claimed again; once ready it is done', async () => {
  const s = setup({ a: 'timeline' });
  await waitingMoves(s, ['a']);
  assert.equal(s.queue.claimNext(), null);
  assert.equal(s.queue.unfinishedAtStep('linked'), 1);
  assert.equal((await checkThumbnails(s.deps)).done.length, 0);
  assert.deepEqual(s.queue.counts(), { pending: 1, running: 0, done: 0, failed: 0 });

  s.noThumbs.delete('a');
  s.calls.length = 0;
  assert.equal((await checkThumbnails(s.deps)).done.length, 1);
  assert.deepEqual(s.calls, ['thumbs:a'], 'no copy, archive or link again');
  assert.deepEqual(s.queue.counts(), { pending: 0, running: 0, done: 1, failed: 0 });
  assert.equal(s.queue.unfinishedAtStep('linked'), 0);
});

test('thumbnails: all waiting moves checked in 1 Immich call; each done on its own', async () => {
  const s = setup({ a: 'timeline', p: 'timeline', b2: 'timeline' }, { p: ['p', 'b2'] });
  await waitingMoves(s, ['a', 'p']);
  s.noThumbs.add('b2');
  s.noThumbs.delete('a');
  s.noThumbs.delete('p');
  assert.equal((await checkThumbnails(s.deps)).done.length, 1);
  assert.deepEqual(s.calls, ['thumbs:a,p,b2']);
  assert.deepEqual(s.queue.waiting().map((j) => j.sourceAssetId), ['p'], 'the stack waits for all its copies');
});

test('thumbnails: a long wait is fine while other moves get theirs; no progress at all → failed', async () => {
  const s = setup({ a: 'timeline', b: 'timeline' });
  await waitingMoves(s, ['a', 'b']);
  await sleep(100);
  s.noThumbs.delete('b');
  // a has waited ~150 ms > 120, but b got its thumbnails just now: Immich is busy, not stuck.
  assert.equal((await checkThumbnails(s.deps, { now: Date.now() + 50, stallMs: 120 })).done.length, 1);
  assert.deepEqual(s.queue.waiting().map((j) => j.sourceAssetId), ['a']);

  await checkThumbnails(s.deps, { now: Date.now() + THUMBNAIL_STALL_MS + 1000 });
  assert.match(row(s.queue)!.error!, /no thumbnails for 30 min/);
  assert.equal(row(s.queue)!.step, 'linked');
});

test('thumbnails: Retry after a stall checks again without redoing the move', async () => {
  const s = setup({ a: 'timeline' });
  await waitingMoves(s, ['a']);
  await checkThumbnails(s.deps, { now: Date.now() + THUMBNAIL_STALL_MS + 1000 });
  const failed = row(s.queue)!;
  assert.equal(s.queue.retry(failed.id), true);
  const resumed = s.queue.claimNext()!;
  assert.deepEqual([resumed.step, resumed.waitingSince], ['linked', null], 'the wait starts afresh');
  s.noThumbs.delete('a');
  s.calls.length = 0;
  assert.equal(await runMove(s.deps, resumed), 'done');
  assert.deepEqual(s.calls, ['thumbs:a']);
});

test('worker: moves waiting for thumbnails do not hold up the next job; a later check finishes them', async () => {
  const s = setup({ a: 'timeline', b: 'timeline' });
  s.noThumbs.add('a');
  s.queue.enqueue('move', ['a', 'b'], { memberId: MEMBER });
  const logged: string[] = [];
  const log = { info: (m: string) => void logged.push(m), error: (m: string) => void logged.push(m) };
  const wk = createWorker({ ...s.deps, guard: async () => ok, log, waitCheckMs: 0 });
  wk.kick();
  await wk.idle();
  assert.deepEqual(s.queue.counts(), { pending: 1, running: 0, done: 1, failed: 0 });
  assert.deepEqual(logged, ['move 2 done: b']);
  s.noThumbs.delete('a');
  wk.kick();
  await wk.idle();
  assert.deepEqual(s.queue.counts(), { pending: 0, running: 0, done: 2, failed: 0 });
  assert.deepEqual(logged, ['move 2 done: b', 'move 1 done: a'], 'a move finished by the check is logged too');
});

test('worker: a move failed by the thumbnail check is logged', async () => {
  const s = setup({ a: 'timeline' });
  await waitingMoves(s, ['a']);
  const logged: string[] = [];
  const log = { info: (m: string) => void logged.push(m), error: (m: string) => void logged.push(m) };
  const wk = createWorker({ ...s.deps, guard: async () => ok, log, waitCheckMs: 0 });
  const realNow = Date.now;
  Date.now = () => realNow() + THUMBNAIL_STALL_MS + 1000;
  try {
    wk.kick();
    await wk.idle();
  } finally {
    Date.now = realNow;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /^move 1 failed: Immich made no thumbnails for 30 min/);
});

// --- give back -----------------------------------------------------------------------------------
const claimGiveBack = (q: Queue, id: string) => {
  q.enqueue('giveback', [id]);
  return q.claimNext()!;
};

test('give back: originals restored first, then the family files deleted', async () => {
  const s = setup({ o1: 'archive', o2: 'timeline' });
  s.plans.f = { familyIds: ['f', 'fv'], originals: ['o1', 'o2'] };
  const m = claimGiveBack(s.queue, 'f');
  assert.equal(m.kind, 'giveback');
  await runGiveBack(s.deps, m);
  assert.deepEqual(s.calls, ['plan:f', 'restore:o1,o2', 'delete:f,fv']);
  assert.deepEqual([s.assets.o1, s.assets.o2], ['timeline', 'timeline']);
  assert.deepEqual(s.queue.counts('giveback'), { pending: 0, running: 0, done: 1, failed: 0 });
});

test('give back: no original → refused before anything is written', async () => {
  const s = setup({});
  const m = claimGiveBack(s.queue, 'f');
  await assert.rejects(runGiveBack(s.deps, m), /would delete its only copy/);
  assert.deepEqual(s.calls, ['plan:f']);
});

test('give back: a failed delete resumes with the recorded family files (no new plan)', async () => {
  const s = setup({ o1: 'archive' });
  s.plans.f = { familyIds: ['f'], originals: ['o1'] };
  const m = claimGiveBack(s.queue, 'f');
  s.failNext.delete = new Error('Immich DELETE /assets → HTTP 500');
  await assert.rejects(runGiveBack(s.deps, m), /HTTP 500/);
  assert.equal(s.assets.o1, 'timeline', 'original already back');

  s.queue.fail(m.id, 'x');
  s.queue.retry(m.id);
  const resumed = s.queue.claimNext()!;
  assert.deepEqual([resumed.step, resumed.familyIds, resumed.originals], ['restored', ['f'], ['o1']]);
  s.calls.length = 0;
  await runGiveBack(s.deps, resumed);
  assert.deepEqual(s.calls, ['delete:f']);
});

test('worker: runs moves and give backs from the same queue', async () => {
  const s = setup({ a: 'timeline', o: 'archive' });
  s.plans.f = { familyIds: ['f'], originals: ['o'] };
  s.queue.enqueue('move', ['a'], { memberId: MEMBER });
  s.queue.enqueue('giveback', ['f']);
  const wk = createWorker({ ...s.deps, guard: async () => ok, log: silent });
  wk.kick();
  await wk.idle();
  assert.deepEqual([s.queue.counts('move').done, s.queue.counts('giveback').done], [1, 1]);
});

// --- transient failures ---------------------------------------------------------------------------
const dropped = () => new ImmichError('Immich POST /assets: fetch failed (UND_ERR_SOCKET other side closed)', 0);

test('worker: a transient failure is tried again on its own; the history keeps it', async () => {
  const s = setup({ a: 'timeline' });
  s.queue.enqueue('move', ['a'], { memberId: MEMBER });
  s.failNext.copyToFamily = dropped();
  const wk = createWorker({ ...s.deps, guard: async () => ok, log: silent, retryDelaysMs: [0] });
  wk.kick();
  await wk.idle();
  assert.equal(s.queue.counts().done, 1);
  const [job] = s.queue.list('done').jobs;
  assert.equal(job!.failures, 1);
  assert.deepEqual(
    s.queue.events(job!.id)!.filter((e) => e.type === 'retrying').map((e) => e.message),
    ['Immich POST /assets: fetch failed (UND_ERR_SOCKET other side closed)'],
  );
});

test('worker: a transient failure waits for its delay; after the last one the job fails', async () => {
  const s = setup({ a: 'timeline' });
  s.queue.enqueue('move', ['a'], { memberId: MEMBER });
  s.immich.copyToFamily = async () => {
    throw dropped();
  };
  const wk = createWorker({ ...s.deps, guard: async () => ok, log: silent, retryDelaysMs: [0, 0] });
  wk.kick();
  await wk.idle();
  const failed = row(s.queue)!;
  assert.match(failed.error!, /fetch failed/);
  assert.equal(failed.attempts, 2, '1st try + 2 retries');

  // A delay in the future: pending, not claimed until then.
  s.queue.retry(failed.id);
  const later = createWorker({ ...s.deps, guard: async () => ok, log: silent, retryDelaysMs: [60_000] });
  later.kick();
  await later.idle();
  assert.deepEqual([s.queue.counts().pending, s.queue.retrying()], [1, 1]);
});

test('worker: a refusal is not retried', async () => {
  const s = setup({ a: 'trash' });
  s.queue.enqueue('move', ['a'], { memberId: MEMBER });
  const wk = createWorker({ ...s.deps, guard: async () => ok, log: silent, retryDelaysMs: [0] });
  wk.kick();
  await wk.idle();
  assert.equal(row(s.queue)!.attempts, 0);
});

test('link: a file moved meanwhile is transient, a mismatch is not', async () => {
  const s = setup({ a: 'timeline' });
  const m = claim(s.queue, 'a');
  s.links.a = { id: 'a', path: '/data/upload/a', result: 'failed', reason: 'file not found', transient: true };
  const moved = await runMove(s.deps, m).catch((e: unknown) => e);
  assert.equal(isTransient(moved), true);

  s.links.a = { id: 'a', path: '/data/upload/a', result: 'mismatch', reason: 'size differs' };
  const differs = await runMove(s.deps, { ...m, step: 'archived' }).catch((e: unknown) => e);
  assert.equal(isTransient(differs), false);
});
