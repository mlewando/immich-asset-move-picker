// Login: the picker is an OpenID Connect client of the identity provider (code flow with PKCE,
// state and nonce, all checked by openid-client). After the login, a server-side session (see
// sessions.ts) keeps the user in while they work:
// - it ends after PICKER_SESSION_IDLE without a request (the page pings while the user is active),
//   and in any case MAX_SESSION_MS after the login;
// - every REFRESH_MS a refresh-token grant re-reads the user from the provider, so a disabled
//   user or one removed from the allowed groups is out within that time. A provider that can't be
//   reached is retried for REFRESH_GRACE_MS, then the session ends too.
// Background requests (/api/, /media/) without a session get 401, never a login redirect: a grid
// of hundreds of tiles must not start hundreds of logins. The page reloads once and that 1
// navigation logs in (public/expiry.js).
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as client from 'openid-client';
import type { Identity, Session, Sessions } from './sessions.ts';

export type AuthConfig = {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  // Where browsers reach the picker; the redirect URI is <publicUrl>/oauth2/callback.
  publicUrl: URL;
  allowedGroups: string[];
  idleMs: number;
  // Where the browser goes after signing out of the picker: the provider's logout page, so its own
  // session ends too (else the next visit logs straight back in). null: the picker's own page.
  logoutUrl: URL | null;
};

export type Grant = { who: Identity; refreshToken: string | null };

// The provider, behind a small interface so tests can count and fail refreshes.
export type Oidc = {
  authorizationUrl(redirectUri: string, checks: { state: string; nonce: string; codeChallenge: string }): Promise<URL>;
  codeGrant(currentUrl: URL, checks: { state: string; nonce: string; verifier: string }): Promise<Grant>;
  refresh(refreshToken: string, sub: string): Promise<Grant>;
  revoke(refreshToken: string): Promise<void>;
};

/** The provider answered, and the answer means no (as opposed to not answering at all). */
export class ProviderRefused extends Error {}

/**
 * The refresh grant went through but reading the user didn't. The provider has already rotated
 * the refresh token: the new one must be kept, since retrying with the spent one would make the
 * provider revoke the whole session.
 */
export class RefreshUnfinished extends Error {
  readonly refreshToken: string | null;
  constructor(refreshToken: string | null, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.refreshToken = refreshToken;
  }
}

export const REFRESH_MS = 5 * 60_000;
// A provider that can't be reached isn't a logout at once: retry every RETRY_MS, for at most
// REFRESH_GRACE_MS past the due refresh; after that a session can't be vouched for any more.
const RETRY_MS = 60_000;
export const REFRESH_GRACE_MS = 30 * 60_000;
// However active the user is, they log in again after this (the provider re-checks everything).
export const MAX_SESSION_MS = 12 * 3_600_000;
// lastSeen is written at most this often (a grid fires hundreds of requests a second).
const TOUCH_MS = 15_000;
const LOGIN_TTL_MS = 10 * 60_000;
// Logins in progress kept per browser (a few tabs at once).
const MAX_PENDING_LOGINS = 5;
const SCOPE = 'openid profile email groups offline_access';

/** openid-client against the real provider. Discovery runs on first use and again after a failure. */
export function createOidc(cfg: AuthConfig): Oidc {
  let discovered: Promise<client.Configuration> | null = null;
  const config = () => {
    discovered ??= client
      .discovery(cfg.issuer, cfg.clientId, undefined, client.ClientSecretBasic(cfg.clientSecret), {
        // Plain http only for a provider on this machine (tests).
        execute: isLoopback(cfg.issuer.hostname) ? [client.allowInsecureRequests] : [],
      })
      .catch((err: unknown) => {
        discovered = null;
        throw err;
      });
    return discovered;
  };

  // Authelia puts email and groups in UserInfo, not in the ID token.
  const identity = async (c: client.Configuration, tokens: client.TokenEndpointResponse, sub: string): Promise<Grant> => {
    const info = await client.fetchUserInfo(c, tokens.access_token, sub);
    if (typeof info.email !== 'string' || !info.email) throw new ProviderRefused('the provider sent no email');
    const groups = Array.isArray(info.groups) ? info.groups.filter((g): g is string => typeof g === 'string') : [];
    const name = typeof info.name === 'string' ? info.name : null;
    return { who: { sub, email: info.email, name, groups }, refreshToken: tokens.refresh_token ?? null };
  };

  return {
    async authorizationUrl(redirectUri, { state, nonce, codeChallenge }) {
      return client.buildAuthorizationUrl(await config(), {
        redirect_uri: redirectUri,
        scope: SCOPE,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
    },
    async codeGrant(currentUrl, { state, nonce, verifier }) {
      const c = await config();
      const tokens = await client.authorizationCodeGrant(c, currentUrl, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      return identity(c, tokens, tokens.claims()!.sub);
    },
    async refresh(refreshToken, sub) {
      const c = await config();
      const tokens = await client.refreshTokenGrant(c, refreshToken);
      try {
        return await identity(c, tokens, sub);
      } catch (err) {
        if (refused(err)) throw err;
        throw new RefreshUnfinished(tokens.refresh_token ?? null, err);
      }
    },
    async revoke(refreshToken) {
      await client.tokenRevocation(await config(), refreshToken, { token_type_hint: 'refresh_token' });
    },
  };
}

export type AuthDeps = {
  config: AuthConfig;
  oidc: Oidc;
  sessions: Sessions;
  now?: () => number;
};

declare module 'fastify' {
  interface FastifyRequest {
    // Decorated by buildApp (null with the login off); set by the auth hook.
    user: Identity | null;
  }
  interface FastifyContextConfig {
    // Reachable without a login session (the login routes themselves, /healthz).
    public?: boolean;
  }
}

/** GET and HEAD change nothing; every other method is a write (and needs X-Picker, server.ts). */
export const isSafeMethod = (method: string) => method === 'GET' || method === 'HEAD';

// An OAuth error with a 5xx (server_error, temporarily_unavailable) or 429 (throttled) means
// "try later", not no.
const refused = (err: unknown) =>
  err instanceof ProviderRefused ||
  (err instanceof client.ResponseBodyError && err.status < 500 && err.status !== 429) ||
  err instanceof client.AuthorizationResponseError ||
  err instanceof client.WWWAuthenticateChallengeError;

const PRUNE_MS = 60 * 60_000;

/**
 * The session rules, apart from cookies and routes: when a session is still good, when it is
 * refreshed at the provider, and when it ends.
 */
function sessionKeeper({ config, oidc, sessions, now, log }: Required<AuthDeps> & { log: FastifyInstance['log'] }) {
  const allowed = (groups: string[]) => groups.some((g) => config.allowedGroups.includes(g));
  // 1 refresh per session at a time: the provider rotates the refresh token, and using the old
  // one twice would make it revoke the whole session.
  const inFlight = new Map<string, Promise<Session | null>>();
  // After a failed attempt (provider unreachable): not before this time again. refreshedAt can't
  // say this: it moves only on success, and the grace time is measured from it.
  const retryAt = new Map<string, number>();

  const end = (s: Session, why: string): null => {
    sessions.delete(s.key);
    retryAt.delete(s.key);
    log.info({ user: s.email }, `session ended: ${why}`);
    return null;
  };

  const attemptRefresh = async (s: Session): Promise<Session | null> => {
    try {
      const { who, refreshToken } = await oidc.refresh(s.refreshToken, s.sub);
      retryAt.delete(s.key);
      if (!allowed(who.groups)) return end(s, 'no longer in an allowed group');
      return sessions.refreshed(s.key, who, refreshToken, now());
    } catch (err) {
      if (refused(err)) return end(s, `refresh refused (${(err as Error).message})`);
      // Keep a rotated token; refreshedAt stays, so the grace time still counts.
      const kept = err instanceof RefreshUnfinished && err.refreshToken ? sessions.refreshed(s.key, s, err.refreshToken, s.refreshedAt) : s;
      if (!kept) return null;
      const t = now();
      if (t - s.refreshedAt >= REFRESH_MS + REFRESH_GRACE_MS) return end(kept, 'the provider was unreachable for too long');
      log.warn({ user: s.email, err: (err as Error).message }, 'session refresh failed; trying again later');
      retryAt.set(s.key, t + RETRY_MS);
      return kept;
    }
  };
  const refresh = (s: Session): Promise<Session | null> => {
    let p = inFlight.get(s.key);
    if (!p) {
      p = attemptRefresh(s).finally(() => inFlight.delete(s.key));
      inFlight.set(s.key, p);
    }
    return p;
  };

  return {
    allowed,
    end,
    /**
     * The session behind a cookie, if it is still good. `active` = the user did something; a
     * background poll is not active, so an open but unused tab still goes idle.
     */
    async current(cookie: string, active: boolean): Promise<Session | null> {
      let s = sessions.get(cookie);
      if (!s) return null;
      const t = now();
      if (t - s.lastSeen > config.idleMs) return end(s, 'idle');
      if (t - s.createdAt > MAX_SESSION_MS) return end(s, 'maximum age');
      if (t - s.refreshedAt >= REFRESH_MS && (retryAt.get(s.key) ?? 0) <= t) s = await refresh(s);
      if (s && active && t - s.lastSeen >= TOUCH_MS) {
        sessions.touch(s.key, t);
        // The requests that waited on the same refresh share this object: they skip the write.
        s.lastSeen = t;
      }
      return s;
    },
    /** Idle sessions are deleted on use; this removes the ones never used again. */
    prune() {
      const before = now() - config.idleMs;
      sessions.prune(before);
      for (const [key, at] of retryAt) if (at < before) retryAt.delete(key);
    },
  };
}

// openid-client's random state: base64url. Checked before it becomes part of a cookie name.
const STATE = /^[A-Za-z0-9_-]{1,128}$/;

type Login = { state: string; nonce: string; verifier: string; returnTo: string; at: number };

export async function registerAuth(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { config, oidc, sessions } = deps;
  const now = deps.now ?? Date.now;
  const keeper = sessionKeeper({ config, oidc, sessions, now, log: app.log });
  const redirectUri = new URL('/oauth2/callback', config.publicUrl).href;
  const secure = config.publicUrl.protocol === 'https:';
  // __Host-: only this exact host can set it (no planting from a sibling subdomain). Browsers
  // accept the prefix only on Secure cookies, so plain http (tests, dev) keeps the bare name.
  const prefix = secure ? '__Host-' : '';
  const sessionCookie = `${prefix}picker_session`;
  // 1 cookie per login in progress, named by its state: 2 tabs logging in at once (both reloaded
  // when the session ended) must not overwrite each other's.
  const loginCookie = (state: string) => `${prefix}picker_login_${state}`;
  const cookieOpts = { path: '/', httpOnly: true, secure, sameSite: 'lax' } as const;

  // A login in progress lives in its own cookie, signed with a key that never leaves this process:
  // nothing kept on the server that a flood of /oauth2/start could fill, and nothing the browser
  // can alter (state, nonce and PKCE verifier are this browser's own; HttpOnly keeps them from
  // scripts). A restart only fails the logins in progress at that moment.
  await app.register(fastifyCookie, { secret: randomBytes(32) });
  const openLogin = (signed: string): Login | null => {
    const { valid, value } = app.unsignCookie(signed);
    if (!valid || !value) return null;
    try {
      return JSON.parse(value) as Login;
    } catch {
      return null;
    }
  };

  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.config.public) return;
    const cookie = req.cookies[sessionCookie];
    // X-Picker-Poll: 1 marks the page's timed polls (status, jobs), which aren't the user's doing.
    const s = cookie ? await keeper.current(cookie, req.headers['x-picker-poll'] !== '1') : null;
    if (s) {
      req.user = { sub: s.sub, email: s.email, name: s.name, groups: s.groups };
      return;
    }
    // Only a page load goes to the login. Background requests (fetch, <img>, <video>) and writes
    // get 401: a grid of hundreds of tiles must not start hundreds of logins, and a write can't
    // be replayed after one anyway. The page reloads once instead (public/expiry.js).
    const path = req.url.split('?')[0]!;
    const pageLoad = isSafeMethod(req.method) && !path.startsWith('/api/') && !path.startsWith('/media/');
    if (!pageLoad) return reply.code(401).send({ error: 'not logged in' });
    return reply.redirect(`/oauth2/start?rd=${encodeURIComponent(req.url)}`);
  });

  // ?rd= (return address) is the parameter name oauth2-proxy used; kept for old links.
  app.get<{ Querystring: { rd?: string } }>('/oauth2/start', { config: { public: true } }, async (req, reply) => {
    const login: Login = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      verifier: client.randomPKCECodeVerifier(),
      returnTo: safeReturn(req.query.rd, config.publicUrl),
      at: now(),
    };
    const url = await oidc.authorizationUrl(redirectUri, {
      state: login.state,
      nonce: login.nonce,
      codeChallenge: await client.calculatePKCECodeChallenge(login.verifier),
    });
    // Logins started and abandoned (reloads, tabs) leave cookies for LOGIN_TTL_MS; enough of them
    // would push this browser's request headers past the server's limit. Keep the newest few.
    const pending = Object.keys(req.cookies)
      .filter((name) => name.startsWith(loginCookie('')))
      .map((name) => ({ name, at: openLogin(req.cookies[name]!)?.at ?? 0 }))
      .sort((a, b) => b.at - a.at);
    for (const { name } of pending.slice(MAX_PENDING_LOGINS - 1)) reply.clearCookie(name, cookieOpts);
    reply.setCookie(loginCookie(login.state), JSON.stringify(login), { ...cookieOpts, signed: true, maxAge: LOGIN_TTL_MS / 1000 });
    return reply.redirect(url.href);
  });

  app.get<{ Querystring: { state?: string } }>('/oauth2/callback', { config: { public: true } }, async (req, reply) => {
    const state = req.query.state ?? '';
    const signed = STATE.test(state) ? req.cookies[loginCookie(state)] : undefined;
    const login = signed ? openLogin(signed) : null;
    if (signed) reply.clearCookie(loginCookie(state), cookieOpts);
    if (!login || login.state !== state || now() - login.at > LOGIN_TTL_MS) return errorPage(reply, 400, 'The login took too long or was started elsewhere.');

    let grant: Grant;
    try {
      grant = await oidc.codeGrant(new URL(req.url, config.publicUrl), login);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'login failed');
      return errorPage(reply, refused(err) ? 403 : 502, 'The login did not succeed.');
    }
    if (!keeper.allowed(grant.who.groups)) {
      req.log.info({ user: grant.who.email }, 'login refused: not in an allowed group');
      return errorPage(reply, 403, `${grant.who.email} may not use the picker.`);
    }
    // Without a refresh token the session could never re-check the user: refuse rather than
    // trust them until they go idle.
    if (!grant.refreshToken) {
      req.log.error('login refused: the provider sent no refresh token (is offline_access granted?)');
      return errorPage(reply, 502, 'The login did not succeed.');
    }
    const cookie = sessions.create(grant.who, grant.refreshToken, now());
    req.log.info({ user: grant.who.email }, 'logged in');
    reply.setCookie(sessionCookie, cookie, cookieOpts);
    return reply.redirect(login.returnTo);
  });

  app.post('/oauth2/sign_out', { config: { public: true } }, async (req, reply) => {
    const cookie = req.cookies[sessionCookie];
    const s = cookie ? sessions.get(cookie) : null;
    if (s) {
      keeper.end(s, 'signed out');
      // Best effort, not awaited: the session is gone here either way.
      void oidc.revoke(s.refreshToken).catch((err: Error) => req.log.warn({ err: err.message }, 'token revocation failed'));
    }
    reply.clearCookie(sessionCookie, cookieOpts);
    return { next: config.logoutUrl?.href ?? '/signed-out' };
  });

  // A page, not a redirect to the login: going back to / would log straight back in.
  app.get('/signed-out', { config: { public: true } }, async (_req, reply) =>
    page(reply, 200, 'You are signed out.', 'Log in again'),
  );

  const prune = setInterval(keeper.prune, PRUNE_MS);
  prune.unref();
  app.addHook('onClose', async () => clearInterval(prune));
}

/**
 * Where to go after the login: a path on this site, as an absolute URL. It is parsed the way a
 * browser parses it (control characters stripped, `\` as `/`), and only a result on this origin
 * is kept. The redirect is that parsed URL, never the string: a path like `/a/..//host` stays on
 * this origin but would read as `//host` if sent back relative.
 */
export function safeReturn(returnTo: string | undefined, publicUrl: URL): string {
  const home = new URL('/', publicUrl).href;
  if (!returnTo?.startsWith('/')) return home;
  const u = URL.parse(returnTo, publicUrl);
  return u && u.origin === publicUrl.origin ? u.href : home;
}

function page(reply: FastifyReply, status: number, message: string, link: string) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .send(`<!doctype html><title>Photo picker</title><p>${escapeHtml(message)} <a href="/">${link}</a></p>`);
}
const errorPage = (reply: FastifyReply, status: number, message: string) => page(reply, status, message, 'Try again');

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Only a literal loopback address or `localhost`; never a name that merely starts with 127. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  return isIP(h) === 4 && h.startsWith('127.');
}
