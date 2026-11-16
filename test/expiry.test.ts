import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeExpiry, PING_MS } from '../public/expiry.js';

function setup(status: number, clock = { t: 0 }) {
  let fetches = 0;
  let reloads = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const e = makeExpiry({
    now: () => clock.t,
    fetch: async () => {
      fetches++;
      await gate;
      return { status };
    },
    reload: () => reloads++,
  });
  return { e, release, counts: () => ({ fetches, reloads }) };
}

test('a burst of media errors shares 1 probe and reloads once', async () => {
  const { e, release, counts } = setup(401);
  const probes = Array.from({ length: 300 }, () => e.check());
  release();
  await Promise.all(probes);
  assert.deepEqual(counts(), { fetches: 1, reloads: 1 });
  await e.check();
  assert.deepEqual(counts(), { fetches: 1, reloads: 1 });
});

test('a live session does not reload; a later error probes again', async () => {
  const { e, release, counts } = setup(200);
  release();
  await e.check();
  await e.check();
  assert.deepEqual(counts(), { fetches: 2, reloads: 0 });
});

test('expired() reloads at most once', () => {
  const { e, counts } = setup(200);
  e.expired();
  e.expired();
  assert.equal(counts().reloads, 1);
});

test('activity pings at most once per PING_MS', async () => {
  const clock = { t: 0 };
  const { e, release, counts } = setup(200, clock);
  release();
  for (let i = 0; i < 100; i++) e.active();
  await e.check(); // the probe the first activity started, now finished
  assert.equal(counts().fetches, 1);
  clock.t = PING_MS - 1;
  e.active();
  assert.equal(counts().fetches, 1);
  clock.t = PING_MS;
  e.active();
  await Promise.resolve();
  assert.equal(counts().fetches, 2);
});
