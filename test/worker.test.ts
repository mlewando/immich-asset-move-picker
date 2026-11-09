// The move steps and the worker, over the real (in-memory) SQLite queue and a fake Immich.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GiveBackPlan, GuardResult, LinkResult, VisibilityResult } from '../src/immich/index.ts';
import { openQueue, type Queue } from '../src/queue.ts';
import { createWorker, LINK_MISMATCH, runGiveBack, runMove, type JobDeps } from '../src/worker.ts';

const MEMBER = '00000000-0000-4000-8000-0000000a0001';
const ok: GuardResult = { ok: true, problems: [], checkedAt: new Date() };
const bad: GuardResult = { ok: false, problems: ['Immich version 3.4.0, picker tested with 3.3.5'], checkedAt: new Date() };
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
  const immich: JobDeps['immich'] = {
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
      return { familyAssetId: `fam-${id}`, originals: units[id] ?? [id] };
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
  return { immich, calls, failNext, assets, links, plans, family };
}

function setup(assets: Record<string, string>, units: Record<string, string[]> = {}) {
  const queue = openQueue(':memory:');
  const im = fakeImmich(assets, units);
  return { queue, ...im, deps: { queue, immich: im.immich } };
}
const claim = (q: Queue, id: string) => {
  q.enqueue(MEMBER, [id], null);
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
  assert.deepEqual(s.calls, ['copy:a', 'archive:a', 'link:a']);
  assert.equal(s.assets.a, 'archive');
  assert.deepEqual(s.queue.counts(), { pending: 0, running: 0, done: 1, failed: 0 });
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
  assert.deepEqual(s.calls, ['copy:p', 'archive:p,b', 'archive:p,b', 'link:p,b']);
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
  assert.deepEqual(s.calls, ['archive:a', 'link:a']);
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
  assert.deepEqual(s.calls, ['link:a']);
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
  s.queue.enqueue(MEMBER, ['a', 'b', 'c'], null);
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
  s.queue.enqueue(MEMBER, ['a'], null);
  const wk = createWorker({ ...s.deps, guard: async () => bad, log: silent });
  wk.kick();
  await wk.idle();
  assert.equal(s.queue.counts().pending, 1);
  assert.deepEqual(wk.state(), { running: false, paused: true, pausedReason: bad.problems });
});

test('worker: a kick during a drain is not lost', async () => {
  const s = setup({ a: 'timeline', b: 'timeline' });
  s.queue.enqueue(MEMBER, ['a'], null);
  const wk = createWorker({ ...s.deps, guard: async () => ok, log: silent });
  wk.kick();
  s.queue.enqueue(MEMBER, ['b'], null); // while the 1st drain runs
  wk.kick();
  await wk.idle();
  assert.equal(s.queue.counts().done, 2);
});

test('worker: retry puts a failed move back and it completes', async () => {
  const s = setup({ a: 'timeline' });
  s.queue.enqueue(MEMBER, ['a'], null);
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

// --- give back -----------------------------------------------------------------------------------
const claimGiveBack = (q: Queue, id: string) => {
  q.enqueue(null, [id], null, 'giveback');
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
  s.queue.enqueue(MEMBER, ['a'], null);
  s.queue.enqueue(null, ['f'], null, 'giveback');
  const wk = createWorker({ ...s.deps, guard: async () => ok, log: silent });
  wk.kick();
  await wk.idle();
  assert.deepEqual([s.queue.counts('move').done, s.queue.counts('giveback').done], [1, 1]);
});
