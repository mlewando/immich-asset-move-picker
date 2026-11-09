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
  assert.deepEqual(q.enqueue(M, ['a', 'b'], 'curator@x'), ['a', 'b']);
  assert.deepEqual(q.enqueue(M, ['a', 'c'], null), ['c'], 'a is pending already');
  const a = q.claimNext()!;
  assert.equal(a.sourceAssetId, 'a');
  q.fail(a.id, 'boom');
  assert.deepEqual(q.enqueue(M, ['a'], null), [], 'failed counts as unfinished (Retry it instead)');
  q.retry(a.id);
  q.claimNext();
  q.advance(a.id, { step: 'archived', done: true });
  assert.deepEqual(q.enqueue(M, ['a'], null), ['a'], 'done → may move again (after a Give back)');
});

test('claimNext: oldest pending first, marks it running; null when empty', () => {
  const q = openQueue(':memory:');
  q.enqueue(M, ['a', 'b'], null);
  assert.equal(q.claimNext()!.sourceAssetId, 'a');
  assert.equal(q.claimNext()!.sourceAssetId, 'b');
  assert.equal(q.claimNext(), null);
  assert.deepEqual(q.counts(), { pending: 0, running: 2, done: 0, failed: 0 });
});

test('advance records step and copy; fail/retry; failed list', () => {
  const q = openQueue(':memory:');
  q.enqueue(M, ['a', 'b'], null);
  const a = q.claimNext()!;
  q.advance(a.id, { step: 'copied', familyAssetId: 'fam-a', originals: ['a', 'a2'] });
  q.fail(a.id, 'asset is in the trash');
  const [f] = q.failed();
  assert.deepEqual({ ...f, updatedAt: undefined }, {
    id: a.id, kind: 'move', sourceAssetId: 'a', memberId: M, status: 'failed', step: 'copied',
    familyAssetId: 'fam-a', originals: ['a', 'a2'], familyIds: null, error: 'asset is in the trash', updatedAt: undefined,
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

test('counters and the oldest pending move persist across a reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'picker-queue-'));
  try {
    const path = join(dir, 'queue.db');
    let q = openQueue(path);
    assert.equal(q.counter('link_mismatch'), 0);
    assert.equal(q.oldestPendingAt(), null);
    q.bump('link_mismatch', 2);
    q.enqueue(M, ['a', 'b'], null);
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
  q.enqueue(M, ['a'], null);
  q.enqueue(null, ['f'], null, 'giveback');
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
    q.enqueue(M, ['a'], null);
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
