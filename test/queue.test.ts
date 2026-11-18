// The real SQLite queue (in memory, and on disk for reopening).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openQueue } from '../src/queue.ts';

const M = 'member-1';

test('enqueue: 1 unfinished move per asset; a finished one can be queued again', () => {
  const q = openQueue(':memory:');
  assert.deepEqual(q.enqueue('move', ['a', 'b'], { memberId: M, requestedBy: 'curator@x' }), ['a', 'b']);
  assert.deepEqual(q.enqueue('move', ['a', 'c'], { memberId: M }), ['c'], 'a is pending already');
  const a = q.claimNext()!;
  assert.equal(a.sourceAssetId, 'a');
  q.fail(a.id, 'boom');
  assert.deepEqual(q.enqueue('move', ['a'], { memberId: M }), [], 'failed counts as unfinished (Retry it instead)');
  q.retry(a.id);
  q.claimNext();
  q.advance(a.id, { step: 'archived', done: true });
  assert.deepEqual(q.enqueue('move', ['a'], { memberId: M }), ['a'], 'done → may move again (after a Give back)');
});

test('claimNext: oldest pending first, marks it running; null when empty', () => {
  const q = openQueue(':memory:');
  q.enqueue('move', ['a', 'b'], { memberId: M });
  assert.equal(q.claimNext()!.sourceAssetId, 'a');
  assert.equal(q.claimNext()!.sourceAssetId, 'b');
  assert.equal(q.claimNext(), null);
  assert.deepEqual(q.counts(), { pending: 0, running: 2, done: 0, failed: 0 });
});

test('advance records step and copy; fail/retry; failed list', () => {
  const q = openQueue(':memory:');
  q.enqueue('move', ['a', 'b'], { memberId: M });
  const a = q.claimNext()!;
  q.advance(a.id, { step: 'copied', familyAssetId: 'fam-a', originals: ['a', 'a2'] });
  q.fail(a.id, 'asset is in the trash');
  const [f] = q.failed();
  assert.deepEqual({ ...f, updatedAt: undefined }, {
    id: a.id, kind: 'move', sourceAssetId: 'a', memberId: M, status: 'failed', step: 'copied',
    familyAssetId: 'fam-a', originals: ['a', 'a2'], familyIds: null, error: 'asset is in the trash', waitingSince: null,
    updatedAt: undefined,
  });
  assert.equal(q.retry(a.id), true);
  assert.equal(q.retry(a.id), false, 'only failed moves');
  assert.deepEqual(q.counts(), { pending: 2, running: 0, done: 0, failed: 0 });
  const again = q.claimNext()!;
  assert.equal(again.step, 'copied', 'resumes from the recorded step');
  q.advance(again.id, { step: 'archived', done: true });
  assert.equal(q.counts().done, 1);
  assert.equal(q.failed().length, 0);
});

test('unfinishedAssetIds: per kind, pending/running/failed, with recorded originals and family ids', () => {
  const q = openQueue(':memory:');
  q.enqueue('move', ['a', 'b', 'c'], { memberId: M });
  q.enqueue('giveback', ['f']);
  const a = q.claimNext()!;
  q.advance(a.id, { step: 'copied', familyAssetId: 'fam-a', originals: ['a', 'a2'] });
  q.fail(a.id, 'boom');
  const b = q.claimNext()!;
  q.advance(b.id, { step: 'linked', done: true });
  q.claimNext(); // c: running
  assert.deepEqual([...q.unfinishedAssetIds('move')].sort(), ['a', 'a2', 'c'], 'done b left out; failed a with its stack');
  const f = q.claimNext()!;
  q.advance(f.id, { step: 'restored', originals: ['o1'], familyIds: ['f', 'f2'] });
  assert.deepEqual([...q.unfinishedAssetIds('giveback')].sort(), ['f', 'f2', 'o1']);
});

test('counters and the oldest pending move persist across a reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'picker-queue-'));
  try {
    const path = join(dir, 'queue.db');
    let q = openQueue(path);
    assert.equal(q.counter('link_mismatch'), 0);
    assert.equal(q.oldestPendingAt(), null);
    q.bump('link_mismatch', 2);
    q.enqueue('move', ['a', 'b'], { memberId: M });
    const oldest = q.oldestPendingAt();
    assert.match(oldest!, /^\d{4}-\d{2}-\d{2}T/);
    q.close();
    q = openQueue(path);
    q.bump('link_mismatch', 1);
    assert.equal(q.counter('link_mismatch'), 3);
    assert.equal(q.oldestPendingAt(), oldest);
    q.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a queue file from a newer picker is refused, not changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'picker-queue-'));
  try {
    const path = join(dir, 'queue.db');
    const newer = new DatabaseSync(path);
    newer.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    newer.close();
    assert.throws(() => openQueue(path), /newer than this picker knows/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kinds are counted apart', () => {
  const q = openQueue(':memory:');
  q.enqueue('move', ['a'], { memberId: M });
  q.enqueue('giveback', ['f']);
  assert.equal(q.counts().pending, 2);
  assert.equal(q.counts('move').pending, 1);
  const first = q.claimNext()!;
  const second = q.claimNext()!;
  assert.deepEqual([first.kind, second.kind, second.memberId], ['move', 'giveback', null]);
});

test('survives a restart: running moves go back to pending with their step', () => {
  const dir = mkdtempSync(join(tmpdir(), 'picker-queue-'));
  try {
    const path = join(dir, 'queue.db');
    let q = openQueue(path);
    q.enqueue('move', ['a'], { memberId: M });
    const a = q.claimNext()!;
    q.advance(a.id, { step: 'copied', familyAssetId: 'fam-a' });
    q.close(); // "crash" mid-move

    q = openQueue(path); // migrations are not re-applied
    assert.equal(q.resetRunning(), 1);
    const resumed = q.claimNext()!;
    assert.deepEqual([resumed.id, resumed.step, resumed.familyAssetId], [a.id, 'copied', 'fam-a']);
    q.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wait: pending at the same step, listed by waiting() instead of claimed; retry clears the wait', () => {
  const q = openQueue(':memory:');
  q.enqueue('move', ['a', 'b'], { memberId: M });
  const a = q.claimNext()!;
  q.advance(a.id, { step: 'linked' });
  q.wait(a.id);
  assert.deepEqual(q.counts(), { pending: 2, running: 0, done: 0, failed: 0 });
  assert.equal(q.unfinishedAtStep('linked'), 1);
  assert.equal(q.claimNext()!.sourceAssetId, 'b', 'a waits');
  assert.equal(q.claimNext(), null);
  const [w] = q.waiting();
  assert.deepEqual([w!.id, w!.step], [a.id, 'linked']);
  const since = w!.waitingSince;
  assert.match(since!, /^\d{4}-\d{2}-\d{2}T/);
  q.wait(a.id);
  assert.equal(q.waiting()[0]!.waitingSince, since, 'recorded by the 1st wait only');

  assert.equal(q.lastDoneAt('thumbnailed'), null);
  q.fail(a.id, 'no thumbnails');
  assert.deepEqual(q.waiting(), [], 'failed is not waiting');
  q.retry(a.id);
  const again = q.claimNext()!;
  assert.deepEqual([again.id, again.step, again.waitingSince], [a.id, 'linked', null]);
  q.advance(a.id, { step: 'thumbnailed', done: true });
  assert.match(q.lastDoneAt('thumbnailed')!, /^\d{4}-\d{2}-\d{2}T/);
});

test('a queue file from the previous version is migrated with its jobs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'picker-queue-'));
  try {
    const path = join(dir, 'queue.db');
    const old = new DatabaseSync(path);
    old.exec(MIGRATIONS[0]!);
    old.exec(`PRAGMA user_version = 1`);
    old.exec(`INSERT INTO job (kind, source_asset_id, member_id, step) VALUES ('move', 'a', 'm', 'archived')`);
    old.close();
    const q = openQueue(path);
    const a = q.claimNext()!;
    assert.deepEqual([a.sourceAssetId, a.step, a.waitingSince], ['a', 'archived', null]);
    q.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
