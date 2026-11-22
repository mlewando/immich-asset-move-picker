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
// (a stack), default just itself. Records calls in order.
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
      return { familyAssetId: `fam-${id}`, originals, uploaded: uploaded.length };
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
  return { immich, calls, failNext, assets, links, plans, family, noThumbs, albums, inFamily };
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
  assert.equal(copied?.message, 'In albums: Garden, Holidays');

  const n = claim(s.queue, 'c');
  await runMove(s.deps, n);
  const plain = s.queue.events(n.id)!.find((e) => e.type === 'step' && e.step === 'copied');
  assert.equal(plain?.message, null, 'no albums, no note');
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

test('stack: copied when any of it was uploaded; the 1st try notes the photos already there', async () => {
  const s = setup({ p: 'timeline', b: 'timeline', c: 'timeline' }, { p: ['p', 'b', 'c'] });
  s.inFamily.add('b');
  s.albums.p = ['Holidays'];
  const m = claim(s.queue, 'p');
  await runMove(s.deps, m);
  assert.deepEqual(copiedEvent(s.queue, m.id), [null, '1 of 3 photos already there, not copied • In album: Holidays']);

  // A later try can't tell them from its own earlier uploads: no count.
  const t = setup({ p: 'timeline', b: 'timeline', c: 'timeline' }, { p: ['p', 'b', 'c'] });
  t.inFamily.add('b');
  const n = claim(t.queue, 'p');
  t.queue.retryLater(n.id, 'boom', new Date(Date.now() - 1));
  await runMove(t.deps, t.queue.claimNext()!);
  assert.deepEqual(copiedEvent(t.queue, n.id), [null, null]);

  // None uploaded: already there, as for 1 photo.
  const u = setup({ p: 'timeline', b: 'timeline' }, { p: ['p', 'b'] });
  u.inFamily.add('p').add('b');
  const o = claim(u.queue, 'p');
  await runMove(u.deps, o);
  assert.deepEqual(copiedEvent(u.queue, o.id), ['existing', null]);
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

test('worker: paused, it checks again on its own and goes on once the guard passes', async () => {
  const s = setup({ a: 'timeline' });
  s.queue.enqueue('move', ['a'], { memberId: MEMBER });
  let guard = bad;
  const logged: string[] = [];
  const log = { info: (m: string) => void logged.push(m), error: (m: string) => void logged.push(m) };
  const wk = createWorker({ ...s.deps, guard: async () => guard, log, recheckMs: 20 });
  wk.kick();
  await wk.idle();
  assert.equal(wk.state().paused, true);
  await sleep(70); // a few checks while still paused
  assert.deepEqual(logged, [`worker paused: ${bad.problems[0]}`], 'logged once, not at every check');
  guard = ok;
  for (let i = 0; i < 50 && s.queue.counts().done === 0; i++) await sleep(10);
  await wk.idle();
  assert.equal(s.queue.counts().done, 1, 'no outside kick needed');
  assert.equal(wk.state().paused, false);
  assert.deepEqual(logged.slice(1), ['worker resumed', 'move 1 done: a']);
});

test('worker: a stopped drain (DB gone) is checked again on its own', async () => {
  const s = setup({ a: 'timeline' });
  s.queue.enqueue('move', ['a'], { memberId: MEMBER });
  let down = true;
  const guard = async () => {
    if (down) throw new Error('Connection terminated unexpectedly');
    return ok;
  };
  const wk = createWorker({ ...s.deps, guard, log: silent, recheckMs: 20 });
  wk.kick();
  await wk.idle();
  down = false;
  for (let i = 0; i < 50 && s.queue.counts().done === 0; i++) await sleep(10);
  await wk.idle();
  assert.equal(s.queue.counts().done, 1);
});

test('worker: on resume, jobs waiting for an automatic retry are tried at once, attempts kept', async () => {
  const s = setup({ a: 'timeline' });
  s.queue.enqueue('move', ['a'], { memberId: MEMBER });
  s.failNext.copyToFamily = dropped();
  let guard = ok;
  const wk = createWorker({ ...s.deps, guard: async () => guard, log: silent, retryDelaysMs: [60_000], recheckMs: 60_000 });
  wk.kick();
  await wk.idle();
  assert.equal(s.queue.retrying(), 1, 'Immich dropped the upload: tried again in 1 min');

  // Still up: a check that passes changes nothing.
  await wk.recheck();
  await wk.idle();
  assert.equal(s.queue.retrying(), 1, 'not due early without a pause');

  guard = bad;
  await wk.recheck();
  assert.equal(s.queue.retrying(), 1, 'not while paused');
  guard = ok;
  const state = await wk.recheck();
  assert.equal(state.paused, false);
  await wk.idle();
  const [job] = s.queue.list('done').jobs;
  assert.ok(job, 'done right after the resume');
  assert.equal(job.failures, 1);
});

test('worker: Check again on an idle worker that finds it paused keeps checking on its own', async () => {
  const s = setup({ a: 'timeline' });
  let guard = bad;
  const wk = createWorker({ ...s.deps, guard: async () => guard, log: silent, recheckMs: 20 });
  assert.equal((await wk.recheck()).paused, true);
  s.queue.enqueue('move', ['a'], { memberId: MEMBER }); // queued earlier, kick lost while paused
  guard = ok;
  for (let i = 0; i < 50 && s.queue.counts().done === 0; i++) await sleep(10);
  await wk.idle();
  assert.equal(s.queue.counts().done, 1, 'no outside kick needed');
});

test('worker: guard runs never overlap, so an older failing check cannot undo a newer pass', async () => {
  const s = setup({});
  const results = [bad, ok];
  const delays = [40, 0]; // the 1st (failing) check is the slow one
  let active = 0;
  let overlapped = false;
  const guard = async () => {
    const i = 2 - results.length;
    active++;
    if (active > 1) overlapped = true;
    await sleep(delays[i]!);
    active--;
    return results.shift() ?? ok;
  };
  const wk = createWorker({ ...s.deps, guard, log: silent, recheckMs: 60_000 });
  wk.kick(); // drain's check: slow, fails
  await sleep(5);
  const state = await wk.recheck(); // Check again meanwhile: passes
  await wk.idle();
  assert.equal(overlapped, false);
  assert.equal(state.paused, false);
  assert.equal(wk.state().paused, false, 'the slow failure did not land last');
});

test('worker: recheck calls made together share 1 guard run', async () => {
  const s = setup({});
  let calls = 0;
  const wk = createWorker({
    ...s.deps,
    guard: async () => (calls++, await sleep(10), bad),
    log: silent,
    recheckMs: 60_000,
  });
  const [a, b] = await Promise.all([wk.recheck(), wk.recheck()]);
  assert.equal(calls, 1);
  assert.deepEqual([a.paused, b.paused], [true, true]);
  await wk.recheck();
  assert.equal(calls, 2, 'a later call runs its own');
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

test('thumbnails: time before `since` (a pause, the picker not running) is not counted as a stall', async () => {
  const s = setup({ a: 'timeline' });
  await waitingMoves(s, ['a']);
  const now = Date.now() + THUMBNAIL_STALL_MS + 60_000; // waited 31 min, but Immich was down for 30 of them
  await checkThumbnails(s.deps, { now, since: now - 60_000 });
  assert.equal(row(s.queue), null);
  assert.deepEqual(s.queue.waiting().map((j) => j.sourceAssetId), ['a']);
  await checkThumbnails(s.deps, { now, since: now - THUMBNAIL_STALL_MS - 1000 });
  assert.match(row(s.queue)!.error!, /no thumbnails for 30 min/, 'a stall after the resume still fails');
});

test('worker: its start counts as a resume for the stall clock', async () => {
  const s = setup({ a: 'timeline' });
  await waitingMoves(s, ['a']);
  const realNow = Date.now;
  Date.now = () => realNow() + THUMBNAIL_STALL_MS + 1000; // the picker was off past the stall time
  try {
    const wk = createWorker({ ...s.deps, guard: async () => ok, log: silent, waitCheckMs: 0 });
    wk.kick();
    await wk.idle();
  } finally {
    Date.now = realNow;
  }
  assert.equal(row(s.queue), null, 'still waiting, not failed');
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
