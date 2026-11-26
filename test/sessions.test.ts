import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { Session } from 'fastify';
import { sessionKey } from '../src/session-store.ts';
import { openSessions } from '../src/sessions.ts';

const dir = mkdtempSync(join(tmpdir(), 'picker-sessions-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const ANNA = { sub: 'anna', email: 'anna@example.org', name: 'Anna', groups: ['photos-curators'] };
const HOUR = 3_600_000;

// What @fastify/session hands the store: its data, the cookie, and its generation marker.
const session = (generation: string, data: Record<string, unknown> = {}, expires = Date.now() + HOUR) =>
  ({ ...data, cookie: { expires: new Date(expires), originalMaxAge: HOUR }, __fastifySessionMetadata: { generation } }) as unknown as Session;

// The callback API as promises.
const call = <T>(fn: (cb: (err?: unknown, v?: T) => void) => void) =>
  new Promise<T | undefined>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

test('store: set, get, compare-and-set by generation, destroy', async () => {
  const { store } = openSessions(':memory:');
  await call((cb) => store.set('id-1', session('g1', { sub: 'anna' }), cb));
  assert.equal(((await call<Session | null>((cb) => store.get('id-1', cb))) as { sub?: string }).sub, 'anna');

  await call((cb) => store.compareAndSet('id-1', 'g1', session('g2', { sub: 'anna', lastSeen: 1 }), cb));
  await assert.rejects(
    call((cb) => store.compareAndSet('id-1', 'g1', session('g3'), cb)),
    { code: 'ENOENT' },
    'a request holding an older generation does not overwrite a regenerated session',
  );
  await assert.rejects(call((cb) => store.compareAndSet('missing', 'g1', session('g1'), cb)), { code: 'ENOENT' });

  await call((cb) => store.destroy('id-1', cb));
  assert.equal(await call((cb) => store.get('id-1', cb)), null);
  await assert.rejects(
    call((cb) => store.compareAndSet('id-1', 'g2', session('g2', { sub: 'anna' }), cb)),
    { code: 'ENOENT' },
    'a request that loaded the session before it ended does not bring it back',
  );
});

test('store: an expired session is gone, with its credentials', async () => {
  const { store, credentials } = openSessions(':memory:');
  await call((cb) => store.set('id-1', session('g1', { sub: 'anna' }, Date.now() - 1), cb));
  credentials.save(sessionKey('id-1'), ANNA, 'rt-1', Date.now());
  assert.equal(await call((cb) => store.get('id-1', cb)), null);
  assert.equal(credentials.get(sessionKey('id-1')), null);
});

test('saving a session never touches its refresh token', async () => {
  const { store, credentials } = openSessions(':memory:');
  const key = sessionKey('id-1');
  await call((cb) => store.set('id-1', session('g1', { sub: 'anna' }), cb));
  credentials.save(key, ANNA, 'rt-1', 0);
  // A request loaded the session, a refresh rotated the token, then that request saves its copy.
  credentials.refreshed(key, 'rt-1', ANNA, 'rt-2', 1);
  await call((cb) => store.compareAndSet('id-1', 'g1', session('g1', { sub: 'anna', lastSeen: 2 }), cb));
  assert.equal(credentials.get(key)?.refreshToken, 'rt-2');
});

test('the file keeps a hash of the session id, and the same cookie secret after a reopen', async () => {
  const path = join(dir, 'sessions.db');
  const first = openSessions(path);
  await call((cb) => first.store.set('the-cookie-id', session('g1', { sub: 'anna' }), cb));
  const secret = first.cookieSecret;
  first.close();
  assert.ok(!readFileSync(path).includes('the-cookie-id'));
  const again = openSessions(path);
  assert.equal(again.cookieSecret, secret);
  assert.ok(await call((cb) => again.store.get('the-cookie-id', cb)));
  again.close();
});

test('migration 2: a file from before keeps its sessions and tokens, and takes a login without a token', async () => {
  const path = join(dir, 'v1.db');
  // The schema as migration 1 left it, with 1 logged-in session.
  const v1 = new DatabaseSync(path);
  v1.exec(`CREATE TABLE http_session (key TEXT PRIMARY KEY, generation TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX http_session_expires ON http_session (expires_at);
    CREATE TABLE oidc_credentials (
      session_key TEXT PRIMARY KEY REFERENCES http_session (key) ON DELETE CASCADE,
      sub TEXT NOT NULL, email TEXT NOT NULL, name TEXT, groups TEXT NOT NULL,
      refresh_token TEXT NOT NULL, refreshed_at INTEGER NOT NULL);
    CREATE TABLE secret (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = 1;`);
  const old = sessionKey('id-old');
  v1.prepare(`INSERT INTO http_session VALUES (?, 'g1', ?, ?)`).run(old, JSON.stringify(session('g1', { sub: 'anna' })), Date.now() + HOUR);
  v1.prepare(`INSERT INTO oidc_credentials VALUES (?, 'anna', 'anna@example.org', 'Anna', '["photos-curators"]', 'rt-old', 5)`).run(old);
  v1.close();

  const { store, credentials, close } = openSessions(path);
  assert.equal(credentials.get(old)?.refreshToken, 'rt-old');
  await call((cb) => store.set('id-new', session('g1', { sub: 'anna' }), cb));
  credentials.save(sessionKey('id-new'), ANNA, null, 6);
  assert.equal(credentials.get(sessionKey('id-new'))?.refreshToken, null);
  // The foreign key survived the rebuild: the row still goes with its session.
  await call((cb) => store.destroy('id-old', cb));
  assert.equal(credentials.get(old), null);
  close();
});

test('a refresh that finishes after a newer login does not overwrite it', async () => {
  const { store, credentials } = openSessions(':memory:');
  const key = sessionKey('id-1');
  await call((cb) => store.set('id-1', session('g1', { sub: 'anna' }), cb));
  credentials.save(key, ANNA, 'rt-anna', 0);
  credentials.save(key, { ...ANNA, sub: 'bob', email: 'bob@example.org' }, 'rt-bob', 1); // the newer login
  const now = credentials.refreshed(key, 'rt-anna', ANNA, 'rt-anna-2', 2); // Anna's late refresh
  assert.equal(now?.sub, 'bob');
  assert.equal(now?.refreshToken, 'rt-bob');
});
