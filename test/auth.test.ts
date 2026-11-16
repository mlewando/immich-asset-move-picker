import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { OAuth2Server } from 'oauth2-mock-server';
import * as client from 'openid-client';
import {
  createOidc,
  isLoopback,
  MAX_SESSION_MS,
  ProviderRefused,
  RefreshUnfinished,
  REFRESH_GRACE_MS,
  REFRESH_MS,
  safeReturn,
  type AuthConfig,
  type Grant,
  type Oidc,
} from '../src/auth.ts';
import { buildApp } from '../src/server.ts';
import { openSessions } from '../src/sessions.ts';
import { serverDeps } from './fakes.ts';

const MIN = 60_000;
const HOME = 'http://picker.test/';
const ANNA: Grant = {
  who: { sub: 'anna', email: 'anna@example.org', name: 'Anna', groups: ['photos-curators'] },
  refreshToken: 'rt-1',
};

const baseConfig = (over: Partial<AuthConfig> = {}): AuthConfig => ({
  issuer: new URL('http://127.0.0.1:1'),
  clientId: 'picker',
  clientSecret: 'client-secret',
  publicUrl: new URL(HOME),
  allowedGroups: ['photos-curators'],
  idleMs: 30 * MIN,
  ...over,
});

const cookieOf = (res: LightMyRequestResponse, name: string) => {
  const c = res.cookies.find((c) => c.name === name);
  assert.ok(c, `no ${name} cookie`);
  return c;
};

/** The login cookie /oauth2/start set; its name ends with the login's state. */
const loginCookieOf = (start: LightMyRequestResponse, prefix = '') => {
  const c = start.cookies.find((c) => c.name.startsWith(`${prefix}picker_login_`));
  assert.ok(c, 'no login cookie');
  return { ...c, state: c.name.slice(`${prefix}picker_login_`.length) };
};

/**
 * The app with a fake clock, and helpers bound to it (cookie names carry the `__Host-` prefix
 * when its public URL is https):
 * - status(session, { poll }): GET /api/status with that session → status code;
 * - callback(start): the callback for a started login (the provider's part is faked);
 * - login(rd): /oauth2/start then the callback → the callback response and the session cookie.
 */
async function makeApp(oidc: Oidc, config = baseConfig()) {
  let t = Date.parse('2026-11-15T10:00:00Z');
  const app = await buildApp(serverDeps(), { auth: { config, oidc, sessions: openSessions(':memory:'), now: () => t } });
  const prefix = config.publicUrl.protocol === 'https:' ? '__Host-' : '';
  const status = async (session: string, { poll = false } = {}) =>
    (
      await app.inject({
        url: '/api/status',
        cookies: { [`${prefix}picker_session`]: session },
        headers: poll ? { 'x-picker-poll': '1' } : {},
      })
    ).statusCode;
  const callback = (start: LightMyRequestResponse) => {
    const c = loginCookieOf(start, prefix);
    return app.inject({ url: `/oauth2/callback?code=c&state=${c.state}`, cookies: { [c.name]: c.value } });
  };
  const login = async (rd = '/family') => {
    const start = await app.inject(`/oauth2/start?rd=${encodeURIComponent(rd)}`);
    assert.equal(start.statusCode, 302);
    const cb = await callback(start);
    return { cb, session: cb.statusCode === 302 ? cookieOf(cb, `${prefix}picker_session`).value : '' };
  };
  return { app, prefix, status, callback, login, advance: (ms: number) => (t += ms) };
}

/** A provider fake; `refresh` overrides are counted too. */
function fakeOidc(over: Partial<Oidc> = {}) {
  let refreshes = 0;
  const revoked: string[] = [];
  const refresh = over.refresh ?? (async () => ({ ...ANNA, refreshToken: `rt-${refreshes + 1}` }));
  const oidc: Oidc = {
    authorizationUrl: async () => new URL('https://auth.test/authorize'),
    codeGrant: async () => ANNA,
    revoke: async (t) => void revoked.push(t),
    ...over,
    refresh: (...args) => {
      refreshes++;
      return refresh(...args);
    },
  };
  return { oidc, refreshes: () => refreshes, revoked };
}

test('without a session: the page redirects to the login, background requests get 401', async () => {
  const { app } = await makeApp(fakeOidc().oidc);
  const page = await app.inject('/members/00000000-0000-4000-8000-0000000a0001?asset=x');
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, `/oauth2/start?rd=${encodeURIComponent('/members/00000000-0000-4000-8000-0000000a0001?asset=x')}`);
  for (const url of ['/api/status', '/media/00000000-0000-4000-8000-00000000a551/thumbnail']) {
    assert.equal((await app.inject(url)).statusCode, 401, url);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/givebacks', headers: { 'x-picker': '1' } })).statusCode, 401);
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  await app.close();
});

test('login: back to where the user was, with an HttpOnly, SameSite=Lax session cookie', async () => {
  const { app, status, login } = await makeApp(fakeOidc().oidc);
  const { cb, session } = await login();
  assert.equal(cb.headers.location, `${HOME}family`);
  const c = cookieOf(cb, 'picker_session');
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'Lax');
  assert.equal(await status(session), 200);
  await app.close();
});

test('login: only a path on this site is a return address', async () => {
  const { app, login } = await makeApp(fakeOidc().oidc);
  const offSite = ['//evil.test/x', 'https://evil.test/', '/\\evil.test', '/\t/evil.test', '/\n/evil.test', '/\r\n/evil.test', '/a/..//evil.test/x'];
  for (const rd of offSite) {
    const location = String((await login(rd)).cb.headers.location);
    assert.equal(new URL(location).origin, 'http://picker.test', JSON.stringify(rd));
  }
  assert.equal((await login('/members/x?asset=y')).cb.headers.location, `${HOME}members/x?asset=y`);
  await app.close();
});

test('safeReturn: an absolute URL on this origin; anything a browser would resolve elsewhere → home', () => {
  const pub = new URL('https://picker.test');
  assert.equal(safeReturn('/a/..//evil.test/x', pub), 'https://picker.test//evil.test/x');
  for (const rd of ['/\t/evil.test', '//evil.test', '/\\evil.test', undefined, 'family']) {
    assert.equal(safeReturn(rd, pub), 'https://picker.test/', JSON.stringify(rd));
  }
});

test("login: a flood of started logins does not break a curator's login in progress", async () => {
  const { app, callback } = await makeApp(fakeOidc().oidc);
  const start = await app.inject('/oauth2/start?rd=/family');
  for (let i = 0; i < 500; i++) await app.inject('/oauth2/start');
  const cb = await callback(start);
  assert.equal(cb.headers.location, `${HOME}family`);
  await app.close();
});

test('login: 2 tabs logging in at once both succeed, in either order', async () => {
  const { app, callback } = await makeApp(fakeOidc().oidc);
  const a = await app.inject('/oauth2/start?rd=/a');
  const b = await app.inject('/oauth2/start?rd=/b');
  assert.notEqual(loginCookieOf(a).name, loginCookieOf(b).name);
  assert.equal((await callback(b)).headers.location, `${HOME}b`);
  assert.equal((await callback(a)).headers.location, `${HOME}a`);
  await app.close();
});

test('login: a forged or tampered login cookie is refused', async () => {
  const { app } = await makeApp(fakeOidc().oidc);
  const { name, value: v, state } = loginCookieOf(await app.inject('/oauth2/start'));
  const tampered = v.replace(/"returnTo":"[^"]*"/, '"returnTo":"https://evil.test/"');
  assert.notEqual(tampered, v);
  for (const c of [tampered, 'x', '']) {
    assert.equal((await app.inject({ url: `/oauth2/callback?code=c&state=${state}`, cookies: { [name]: c } })).statusCode, 400);
  }
  // A valid cookie under another login's name (state) is refused too.
  const other = loginCookieOf(await app.inject('/oauth2/start'));
  assert.equal((await app.inject({ url: `/oauth2/callback?code=c&state=${other.state}`, cookies: { [other.name]: v } })).statusCode, 400);
  await app.close();
});

test('login: refused when the provider sends no refresh token', async () => {
  const { app, login } = await makeApp(fakeOidc({ codeGrant: async () => ({ ...ANNA, refreshToken: null }) }).oidc);
  assert.equal((await login()).cb.statusCode, 502);
  await app.close();
});

test('login: a callback without its login cookie, or outside the allowed groups, is refused', async () => {
  const { app, login } = await makeApp(fakeOidc({ codeGrant: async () => ({ ...ANNA, who: { ...ANNA.who, groups: ['family'] } }) }).oidc);
  assert.equal((await app.inject('/oauth2/callback?code=c&state=s')).statusCode, 400);
  const { cb } = await login();
  assert.equal(cb.statusCode, 403);
  assert.ok(!cb.cookies.some((c) => c.name === 'picker_session' && c.value));
  await app.close();
});

test('cookies: __Host- names when the picker is reached over https', async () => {
  const { app, prefix, status, callback } = await makeApp(fakeOidc().oidc, baseConfig({ publicUrl: new URL('https://picker.test') }));
  assert.equal(prefix, '__Host-');
  const start = await app.inject('/oauth2/start');
  const lc = loginCookieOf(start, '__Host-');
  assert.ok(lc.secure && lc.path === '/');
  const cb = await callback(start);
  const sc = cookieOf(cb, '__Host-picker_session');
  assert.ok(sc.secure && sc.path === '/' && sc.httpOnly);
  assert.equal((await app.inject({ url: '/api/status', cookies: { picker_session: sc.value } })).statusCode, 401, 'the bare name is ignored');
  assert.equal(await status(sc.value), 200);
  await app.close();
});

test('isLoopback: literal addresses only', () => {
  assert.ok(isLoopback('127.0.0.1') && isLoopback('localhost') && isLoopback('[::1]'));
  assert.ok(!isLoopback('127.evil.example') && !isLoopback('10.0.0.1'));
});

test('session: slides while the user is active, ends after the idle time', async () => {
  const f = fakeOidc();
  const { app, advance, status, login } = await makeApp(f.oidc);
  const { session } = await login();
  for (let i = 0; i < 12; i++) {
    advance(10 * MIN); // 2h of work, a request every 10m
    assert.equal(await status(session), 200, `after ${(i + 1) * 10}m`);
  }
  assert.equal(f.refreshes(), 12);
  advance(31 * MIN);
  assert.equal(await status(session), 401);
  advance(1);
  assert.equal(await status(session), 401, 'the idle session is gone, not just refused once');
  await app.close();
});

test('session: ends at the maximum age however active the user is', async () => {
  const { app, advance, status, login } = await makeApp(fakeOidc().oidc);
  const { session } = await login();
  for (let t = 10 * MIN; t <= MAX_SESSION_MS; t += 10 * MIN) {
    advance(10 * MIN);
    assert.equal(await status(session), 200);
  }
  advance(10 * MIN);
  assert.equal(await status(session), 401);
  await app.close();
});

test('session: 300 parallel requests after the refresh time share 1 refresh', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = fakeOidc({ refresh: async () => (await gate, ANNA) });
  const { app, advance, status, login } = await makeApp(f.oidc);
  const { session } = await login();
  advance(REFRESH_MS + 1);
  const all = Array.from({ length: 300 }, () => status(session));
  await new Promise((r) => setTimeout(r, 20));
  release();
  assert.ok((await Promise.all(all)).every((c) => c === 200));
  assert.equal(f.refreshes(), 1);
  await app.close();
});

test('session: a refused refresh (invalid grant, no email) or a lost group ends it', async () => {
  const refusals: Array<() => Promise<Grant>> = [
    async () => {
      throw new client.ResponseBodyError('invalid_grant', { cause: { error: 'invalid_grant' }, response: new Response('{}', { status: 400 }) });
    },
    async () => {
      throw new ProviderRefused('the provider sent no email');
    },
    async () => ({ ...ANNA, who: { ...ANNA.who, groups: [] } }),
  ];
  for (const refresh of refusals) {
    const { app, advance, status, login } = await makeApp(fakeOidc({ refresh }).oidc);
    const { session } = await login();
    advance(REFRESH_MS);
    assert.equal(await status(session), 401);
    await app.close();
  }
});

test('session: a provider error with a 5xx is retried, not a refusal', async () => {
  const f = fakeOidc({
    refresh: async () => {
      throw new client.ResponseBodyError('server_error', { cause: { error: 'server_error' }, response: new Response('{}', { status: 503 }) });
    },
  });
  const { app, advance, status, login } = await makeApp(f.oidc);
  const { session } = await login();
  advance(REFRESH_MS);
  assert.equal(await status(session), 200);
  await app.close();
});

test('session: a token rotated by a refresh that failed later is the one retried', async () => {
  const used: string[] = [];
  const f = fakeOidc({
    refresh: async (token) => {
      used.push(token);
      if (used.length === 1) throw new RefreshUnfinished('rt-2', new TypeError('fetch failed'));
      return { ...ANNA, refreshToken: 'rt-3' };
    },
  });
  const { app, advance, status, login } = await makeApp(f.oidc);
  const { session } = await login();
  advance(REFRESH_MS);
  assert.equal(await status(session), 200);
  advance(MIN);
  assert.equal(await status(session), 200);
  assert.deepEqual(used, ['rt-1', 'rt-2']);
  await app.close();
});

test('session: timed polls keep it checked but not alive', async () => {
  const f = fakeOidc();
  const { app, advance, status, login } = await makeApp(f.oidc);
  const { session } = await login();
  for (let t = 10 * MIN; t <= 30 * MIN; t += 10 * MIN) {
    advance(10 * MIN);
    assert.equal(await status(session, { poll: true }), 200, `poll after ${t / MIN}m`);
  }
  assert.ok(f.refreshes() > 0, 'polls still refresh (and re-check) the session');
  advance(1);
  assert.equal(await status(session, { poll: true }), 401, 'idle: only polls since the login');
  await app.close();
});

test('session: an unreachable provider is retried each minute, and ends it after the grace time', async () => {
  const f = fakeOidc({ refresh: async () => Promise.reject(new TypeError('fetch failed')) });
  const { app, advance, status, login } = await makeApp(f.oidc);
  const { session } = await login();
  advance(REFRESH_MS);
  assert.equal(await status(session), 200, 'provider down: keep working');
  assert.equal(await status(session), 200);
  assert.equal(f.refreshes(), 1, 'no new attempt before the retry delay');
  advance(MIN);
  assert.equal(await status(session), 200);
  assert.equal(f.refreshes(), 2, 'a minute later: the next attempt');
  for (let t = 2 * MIN; t < REFRESH_GRACE_MS; t += MIN) {
    advance(MIN);
    assert.equal(await status(session), 200);
  }
  advance(MIN);
  assert.equal(await status(session), 401);
  await app.close();
});

test('sign out ends the session and revokes its refresh token', async () => {
  const f = fakeOidc();
  const { app, status, login } = await makeApp(f.oidc);
  const { session } = await login();
  const out = await app.inject({ method: 'POST', url: '/oauth2/sign_out', headers: { 'x-picker': '1' }, cookies: { picker_session: session } });
  assert.equal(out.statusCode, 204);
  assert.equal(await status(session), 401);
  assert.deepEqual(f.revoked, ['rt-1']);
  await app.close();
});

// The real openid-client against a mock provider: discovery, PKCE, state, nonce, ID token
// checks, UserInfo and refresh.
const provider = new OAuth2Server();
let groups = ['photos-curators'];
before(async () => {
  await provider.issuer.keys.generate('RS256');
  await provider.start(0, '127.0.0.1');
  provider.service.on('beforeUserinfo', (res: { body: Record<string, unknown> }) => {
    res.body = { sub: 'johndoe', email: 'anna@example.org', name: 'Anna', groups };
  });
});
after(() => provider.stop());

async function realApp() {
  const config = baseConfig({ issuer: new URL(provider.issuer.url!) });
  return makeApp(createOidc(config), config);
}

async function realLogin(app: FastifyInstance) {
  const start = await app.inject('/oauth2/start?rd=/family');
  const authorize = new URL(start.headers.location as string);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('redirect_uri'), `${HOME}oauth2/callback`);
  assert.match(authorize.searchParams.get('scope')!, /offline_access/);
  const back = new URL((await fetch(authorize, { redirect: 'manual' })).headers.get('location')!);
  const c = loginCookieOf(start);
  return app.inject({ url: back.pathname + back.search, cookies: { [c.name]: c.value } });
}

test('real OIDC flow: login, then a refresh re-reads the groups', async () => {
  groups = ['photos-curators'];
  const { app, advance, status } = await realApp();
  const cb = await realLogin(app);
  assert.equal(cb.statusCode, 302, cb.body);
  assert.equal(cb.headers.location, `${HOME}family`);
  const session = cookieOf(cb, 'picker_session').value;
  assert.equal(await status(session), 200);

  advance(REFRESH_MS + 1);
  assert.equal(await status(session), 200, 'refreshed');
  groups = [];
  advance(REFRESH_MS + 1);
  assert.equal(await status(session), 401, 'removed from the group');
  await app.close();
});

test('real OIDC flow: a user outside the allowed groups gets 403', async () => {
  groups = ['family'];
  const { app } = await realApp();
  assert.equal((await realLogin(app)).statusCode, 403);
  await app.close();
});
