// Errors of the Immich REST client: each names the call and why it failed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImmichApi, ImmichError } from '../src/immich/api.ts';
import { isTransient } from '../src/immich/index.ts';

const failing = (err: unknown): typeof fetch => async () => {
  throw err;
};
const answering = (status: number, body = ''): typeof fetch => async () => new Response(body, { status });

const errorOf = async (fetchFn: typeof fetch) => {
  const err = await createImmichApi('http://immich/api', 'key', fetchFn).getMyUserId().catch((e: unknown) => e);
  assert.ok(err instanceof ImmichError);
  return err;
};

test('network error: the call and the cause fetch hides', async () => {
  const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  const err = await errorOf(failing(new TypeError('fetch failed', { cause })));
  assert.equal(err.message, 'Immich GET /users/me: fetch failed (UND_ERR_SOCKET other side closed)');
  assert.equal(err.status, 0);
  assert.equal(isTransient(err), true);
});

test('timeout: the call and how long it waited', async () => {
  const err = await errorOf(failing(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
  assert.equal(err.message, 'Immich GET /users/me: no answer in 5 s');
  assert.equal(isTransient(err), true);
});

test('HTTP errors: Immich restarting is transient, a refusal is not', async () => {
  const restarting = await errorOf(answering(503));
  assert.equal(restarting.message, 'Immich GET /users/me → HTTP 503');
  assert.equal(isTransient(restarting), true);
  const refused = await errorOf(answering(400, '{"message":"bad"}'));
  assert.equal(refused.message, 'Immich GET /users/me → HTTP 400: {"message":"bad"}');
  assert.equal(isTransient(refused), false);
});

test('isTransient: dropped DB connection yes, plain errors no', () => {
  assert.equal(isTransient(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransient(new Error('Connection terminated unexpectedly')), true);
  assert.equal(isTransient(new Error('asset is in the trash')), false);
  assert.equal(isTransient(undefined), false);
});
