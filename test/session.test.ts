import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSession } from '../public/session.js';

type Res = { status: number; type: string };

function setup(res: Res) {
  let fetches = 0;
  let reloads = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = makeSession({
    fetch: async () => {
      fetches++;
      await gate;
      return res;
    },
    reload: () => reloads++,
  });
  return { s, release, counts: () => ({ fetches, reloads }) };
}

test('a burst of media errors shares 1 probe and reloads once', async () => {
  const { s, release, counts } = setup({ status: 401, type: 'basic' });
  const probes = Array.from({ length: 300 }, () => s.check());
  release();
  await Promise.all(probes);
  assert.deepEqual(counts(), { fetches: 1, reloads: 1 });
  await s.check();
  assert.deepEqual(counts(), { fetches: 1, reloads: 1 });
});

test('a login redirect counts as expired', async () => {
  const { s, release, counts } = setup({ status: 0, type: 'opaqueredirect' });
  release();
  await s.check();
  assert.deepEqual(counts(), { fetches: 1, reloads: 1 });
});

test('a live session does not reload; a later error probes again', async () => {
  const { s, release, counts } = setup({ status: 200, type: 'basic' });
  release();
  await s.check();
  await s.check();
  assert.deepEqual(counts(), { fetches: 2, reloads: 0 });
});

test('expired() reloads at most once', () => {
  const { s, counts } = setup({ status: 200, type: 'basic' });
  s.expired();
  s.expired();
  assert.equal(counts().reloads, 1);
});
