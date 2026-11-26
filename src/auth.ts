// Login: the picker is an OpenID Connect client of the identity provider (code flow with PKCE,
// state and nonce, all checked by openid-client). After the login, a server-side session
// (@fastify/session, stored by session-store.ts; the provider's tokens apart, in
// oidc-credentials.ts) keeps the user in while they work:
// - it ends after PICKER_SESSION_IDLE without a request (the page pings while the user is active),
//   and in any case PICKER_SESSION_MAX after the login;
// - in the oidc-refresh session mode, every REFRESH_MS a refresh-token grant re-reads the user
//   from the provider, so a disabled user or one removed from the allowed groups is out within
//   that time. A provider that can't be reached is retried for REFRESH_GRACE_MS, then the session
//   ends too. In the local mode the provider is asked only at the login (no offline_access, no
//   refresh token): the user is trusted until the session ends.
// Background requests (/api/, /media/, and anything a browser marks as not a document) without a
// session get 401, never a login redirect: a grid of hundreds of tiles must not start hundreds of
// logins. The page reloads once and that 1 navigation logs in (public/expiry.js).
import { isIP } from 'node:net';
import fastifySession from '@fastify/session';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as client from 'openid-client';
import { APP_NAME } from './app-name.ts';
import type { Credentials, CredentialStore, Identity } from './oidc-credentials.ts';
import { sessionKey } from './session-store.ts';
import type { Sessions } from './sessions.ts';

const SESSION_MODES =['oidc-refresh', 'local'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];
export const isSessionMode = (s: string): s is SessionMode => (SESSION_MODES as readonly string[]).includes(s);

export type AuthConfig = {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  // Where browsers reach the picker; the redirect URI is <publicUrl>/oauth2/callback.
  publicUrl: URL;
  allowedGroups: string[];
  sessionMode: SessionMode;
  idleMs: number;
  // However active the user is, they log in again after this (the provider re-checks everything).
  maxMs: number;
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
/** The provider knows the account but sends no email for it, and the picker names users by email. */
export class NoEmail extends ProviderRefused {}

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
// lastSeen is written at most this often (a grid fires hundreds of requests a second).
const TOUCH_MS = 15_000;
const LOGIN_TTL_MS = 10 * 60_000;
// Logins in progress kept per browser (a few tabs at once).
const MAX_PENDING_LOGINS = 5;
// offline_access asks for the refresh token; the local mode has no use for one.
const scope = (mode: SessionMode) => (mode === 'oidc-refresh' ? 'openid profile email groups offline_access' : 'openid profile email groups');

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
    if (typeof info.email !== 'string' || !info.email) throw new NoEmail('the provider sent no email');
    const groups = Array.isArray(info.groups) ? info.groups.filter((g): g is string => typeof g === 'string') : [];
    const name = typeof info.name === 'string' ? info.name : null;
    return { who: { sub, email: info.email, name, groups }, refreshToken: tokens.refresh_token ?? null };
  };

  return {
    async authorizationUrl(redirectUri, { state, nonce, codeChallenge }) {
      return client.buildAuthorizationUrl(await config(), {
        redirect_uri: redirectUri,
        scope: scope(cfg.sessionMode),
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
};

declare module 'fastify' {
  // The session data @fastify/session keeps (session-store.ts). Who the user is and the tokens are
  // the OIDC credentials (oidc-credentials.ts), found by the session's key.
  interface Session {
    sub?: string; // set at the login: a session without it is no login
    createdAt?: number; // ms since epoch
    lastSeen?: number; // the user's last activity, written at most every TOUCH_MS
  }
  interface FastifyRequest {
    // Decorated by buildApp (null with the login off); set by the auth hook.
    user: Identity | null;
  }
  interface FastifyContextConfig {
    // Reachable without a login session (the login routes themselves, /healthz).
    public?: boolean;
  }
}

/**
 * The picker's cookies over https: Secure, and named with the __Host- prefix (only this exact host
 * can set them, no planting from a sibling subdomain). Browsers accept the prefix only on Secure
 * cookies, so plain http (tests, dev) keeps the bare names.
 */
export function cookieNaming(publicUrl: URL | undefined) {
  const secure = publicUrl?.protocol === 'https:';
  return { secure, prefix: secure ? '__Host-' : '' };
}

/** GET and HEAD change nothing; every other method is a write (and needs a CSRF token, server.ts). */
export const isSafeMethod = (method: string) => method === 'GET' || method === 'HEAD';

// An OAuth error with a 5xx (server_error, temporarily_unavailable) or 429 (throttled) means
// "try later", not no.
const refused = (err: unknown) =>
  err instanceof ProviderRefused ||
  (err instanceof client.ResponseBodyError && err.status < 500 && err.status !== 429) ||
  err instanceof client.AuthorizationResponseError ||
  err instanceof client.WWWAuthenticateChallengeError;

const PRUNE_MS = 60 * 60_000;

type Refreshable = Credentials & { refreshToken: string };
const isRefreshable = (c: Credentials): c is Refreshable => c.refreshToken !== null;

/**
 * The OIDC side of the sessions: when a session's credentials are refreshed at the provider, and
 * when the provider's answer ends the session.
 */
function credentialKeeper({ config, oidc, credentials, log }: { config: AuthConfig; oidc: Oidc; credentials: CredentialStore; log: FastifyInstance['log'] }) {
  const allowed = (groups: string[]) => groups.some((g) => config.allowedGroups.includes(g));
  // 1 refresh per session at a time: the provider rotates the refresh token, and using the old
  // one twice would make it revoke the whole session.
  const inFlight = new Map<string, Promise<Credentials | null>>();
  // After a failed attempt (provider unreachable): not before this time again. refreshedAt can't
  // say this: it moves only on success, and the grace time is measured from it.
  const retryAt = new Map<string, number>();

  const end = (c: Credentials, why: string): null => {
    credentials.delete(c.key);
    retryAt.delete(c.key);
    log.info({ user: c.email }, `session ended: ${why}`);
    return null;
  };

  const attemptRefresh = async (c: Refreshable): Promise<Credentials | null> => {
    try {
      const { who, refreshToken } = await oidc.refresh(c.refreshToken, c.sub);
      retryAt.delete(c.key);
      if (!allowed(who.groups)) return end(c, 'no longer in an allowed group');
      return credentials.refreshed(c.key, c.refreshToken, who, refreshToken, Date.now());
    } catch (err) {
      if (refused(err)) return end(c, `refresh refused (${(err as Error).message})`);
      // Keep a rotated token; refreshedAt stays, so the grace time still counts.
      const kept = err instanceof RefreshUnfinished && err.refreshToken ? credentials.refreshed(c.key, c.refreshToken, c, err.refreshToken, c.refreshedAt) : c;
      if (!kept) return null;
      const t = Date.now();
      if (t - c.refreshedAt >= REFRESH_MS + REFRESH_GRACE_MS) return end(kept, 'the provider was unreachable for too long');
      log.warn({ user: c.email, err: (err as Error).message }, 'session refresh failed; trying again later');
      retryAt.set(c.key, t + RETRY_MS);
      return kept;
    }
  };
  const refresh = (c: Refreshable): Promise<Credentials | null> => {
    let p = inFlight.get(c.key);
    if (!p) {
      p = attemptRefresh(c).finally(() => inFlight.delete(c.key));
      inFlight.set(c.key, p);
    }
    return p;
  };

  return {
    allowed,
    /** A session's credentials, refreshed first when due; null when the session must end. */
    async current(key: string): Promise<Credentials | null> {
      const c = credentials.get(key);
      if (!c) return null;
      // The local mode never asks the provider again, whether the session holds a token or not.
      if (config.sessionMode === 'local') return c;
      // A login under the local mode: nothing to re-check the user with.
      if (!isRefreshable(c)) return end(c, 'no refresh token (logged in under the local session mode)');
      const t = Date.now();
      return t - c.refreshedAt >= REFRESH_MS && (retryAt.get(key) ?? 0) <= t ? refresh(c) : c;
    },
    forget: (key: string) => retryAt.delete(key),
    prune() {
      const before = Date.now() - REFRESH_GRACE_MS;
      for (const [key, at] of retryAt) if (at < before) retryAt.delete(key);
    },
  };
}

// Served without a session, because the pages shown without one (signed out, login refused) load
// them: the icon and the stylesheet, which hold nothing private. The static file server has no
// per-file setting for this, hence the list. The other 3 are icons browsers ask for on their own;
// they don't exist (404), and must not start a login either.
const OPEN_PATHS = new Set(['/favicon.svg', '/app.css', '/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']);

// openid-client's random state: base64url. Checked before it becomes part of a cookie name.
const STATE = /^[A-Za-z0-9_-]{1,128}$/;

type Login = { state: string; nonce: string; verifier: string; returnTo: string; at: number };

export async function registerAuth(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { config, oidc, sessions } = deps;
  const keeper = credentialKeeper({ config, oidc, credentials: sessions.credentials, log: app.log });
  const redirectUri = new URL('/oauth2/callback', config.publicUrl).href;
  const { secure, prefix } = cookieNaming(config.publicUrl);
  const sessionCookie = `${prefix}picker_session`;
  // 1 cookie per login in progress, named by its state: 2 tabs logging in at once (both reloaded
  // when the session ended) must not overwrite each other's.
  const loginCookie = (state: string) => `${prefix}picker_login_${state}`;
  const cookieOpts = { path: '/', httpOnly: true, secure, sameSite: 'lax' } as const;

  // The session itself: @fastify/session with our SQLite store. Its cookie lives PICKER_SESSION_IDLE
  // and is renewed only when the session is saved, i.e. when the user does something (lastSeen,
  // below), never by a timed poll; an expired session is gone from the store too.
  await app.register(fastifySession, {
    secret: sessions.cookieSecret,
    cookieName: sessionCookie,
    store: sessions.store,
    saveUninitialized: false,
    rolling: false,
    cookie: { ...cookieOpts, maxAge: config.idleMs },
  });

  // A login in progress lives in its own cookie, signed (@fastify/cookie, registered in server.ts):
  // nothing kept on the server that a flood of /oauth2/start could fill, and nothing the browser
  // can alter (state, nonce and PKCE verifier are this browser's own; HttpOnly keeps them from
  // scripts).
  const openLogin = (signed: string): Login | null => {
    const { valid, value } = app.unsignCookie(signed);
    if (!valid || !value) return null;
    try {
      return JSON.parse(value) as Login;
    } catch {
      return null;
    }
  };

  // Best effort, not awaited: the session is gone here either way. The local mode never calls the
  // provider after the login, so it leaves even a token from an earlier oidc-refresh login alone.
  const revokeQuietly = (refreshToken: string | null, req: FastifyRequest) => {
    if (config.sessionMode !== 'oidc-refresh' || !refreshToken) return;
    void oidc.revoke(refreshToken).catch((err: Error) => req.log.warn({ err: err.message }, 'token revocation failed'));
  };

  const endSession = async (req: FastifyRequest, reply: FastifyReply) => {
    const key = sessionKey(req.session.sessionStoreId);
    keeper.forget(key);
    await req.session.destroy(); // its credentials go with it (ON DELETE CASCADE)
    reply.clearCookie(sessionCookie, cookieOpts);
  };

  /** Who is logged in on this request, after the session rules; null: no (more) login. */
  const loggedIn = async (req: FastifyRequest, reply: FastifyReply): Promise<Identity | null> => {
    const s = req.session;
    if (!s?.sub) return null; // never logged in, or idle past PICKER_SESSION_IDLE (the store dropped it)
    const t = Date.now();
    if (t - (s.createdAt ?? 0) > config.maxMs) {
      req.log.info({ sub: s.sub }, 'session ended: maximum age');
      await endSession(req, reply);
      return null;
    }
    const c = await keeper.current(sessionKey(s.sessionStoreId));
    if (!c || c.sub !== s.sub) {
      await endSession(req, reply);
      return null;
    }
    // X-Picker-Poll: 1 marks the page's timed polls (status, jobs), which aren't the user's doing.
    // The change makes @fastify/session save the session, which renews its expiry.
    if (req.headers['x-picker-poll'] !== '1' && t - (s.lastSeen ?? 0) >= TOUCH_MS) s.lastSeen = t;
    return { sub: c.sub, email: c.email, name: c.name, groups: c.groups };
  };

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (req.routeOptions.config.public || OPEN_PATHS.has(path)) return;
    req.user = await loggedIn(req, reply);
    if (req.user) return;
    // Only a page load goes to the login. Background requests (fetch, <img>, <video>) and writes
    // get 401: a grid of hundreds of tiles must not start hundreds of logins, and a write can't
    // be replayed after one anyway. The page reloads once instead (public/expiry.js).
    // Browsers say what a request is for (Sec-Fetch-Dest): anything but a document is a
    // background request whatever its path. Without the header (old browsers, curl) the path decides.
    const dest = req.headers['sec-fetch-dest'];
    const pageLoad =
      isSafeMethod(req.method) && !path.startsWith('/api/') && !path.startsWith('/media/') && (dest === undefined || dest === 'document');
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
      at: Date.now(),
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

  app.get<{ Querystring: { state?: string; error?: string } }>('/oauth2/callback', { config: { public: true } }, async (req, reply) => {
    const state = req.query.state ?? '';
    const signed = STATE.test(state) ? req.cookies[loginCookie(state)] : undefined;
    const login = signed ? openLogin(signed) : null;
    if (signed) reply.clearCookie(loginCookie(state), cookieOpts);
    if (!login || login.state !== state || Date.now() - login.at > LOGIN_TTL_MS) return sendNotice(reply, notices.stale());

    // The provider itself refused the account (e.g. Authelia's policy for this client). Read from
    // the answer's own parameter, not from what openid-client throws: it checks other parameters
    // first and would then report a refusal as a plain failure. The state above ties this answer
    // to a login this browser started.
    if (req.query.error === 'access_denied') {
      req.log.info('login refused by the provider');
      return sendNotice(reply, notices.refused(null, config.logoutUrl));
    }

    let grant: Grant;
    try {
      grant = await oidc.codeGrant(new URL(req.url, config.publicUrl), login);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'login failed');
      if (err instanceof NoEmail) return sendNotice(reply, notices.noEmail(config.logoutUrl));
      return sendNotice(reply, notices.failed(refused(err) ? 403 : 502));
    }
    if (!keeper.allowed(grant.who.groups)) {
      req.log.info({ user: grant.who.email }, 'login refused: not in an allowed group');
      return sendNotice(reply, notices.refused(grant.who.email, config.logoutUrl));
    }
    // In the oidc-refresh mode a session without a refresh token could never re-check the user:
    // refuse rather than trust them until they go idle. The local mode keeps no token at all.
    const refreshToken = config.sessionMode === 'oidc-refresh' ? grant.refreshToken : null;
    if (config.sessionMode === 'oidc-refresh' && !refreshToken) {
      req.log.error('login refused: the provider sent no refresh token (is offline_access granted?)');
      return sendNotice(reply, notices.failed(502));
    }
    // A login over a live one in the same browser: that login's token is revoked and its refresh
    // state dropped (regenerate keeps the session's store key, so its credentials row is reused).
    if (req.session?.sub) {
      const key = sessionKey(req.session.sessionStoreId);
      const old = sessions.credentials.get(key);
      keeper.forget(key);
      if (old) revokeQuietly(old.refreshToken, req);
    }
    // A new generation at every login: a cookie planted before it (session fixation) no longer
    // matches the stored session.
    await req.session.regenerate();
    const t = Date.now();
    req.session.sub = grant.who.sub;
    req.session.createdAt = t;
    req.session.lastSeen = t;
    await req.session.save();
    sessions.credentials.save(sessionKey(req.session.sessionStoreId), grant.who, refreshToken, t);
    req.log.info({ user: grant.who.email }, 'logged in');
    return reply.redirect(login.returnTo);
  });

  app.post('/oauth2/sign_out', { config: { public: true } }, async (req, reply) => {
    const c = req.session?.sub ? sessions.credentials.get(sessionKey(req.session.sessionStoreId)) : null;
    if (req.session?.sub) await endSession(req, reply);
    else reply.clearCookie(sessionCookie, cookieOpts);
    if (c) {
      req.log.info({ user: c.email }, 'session ended: signed out');
      revokeQuietly(c.refreshToken, req);
    }
    return { next: config.logoutUrl?.href ?? '/signed-out' };
  });

  // A page, not a redirect to the login: going back to / would log straight back in.
  app.get('/signed-out', { config: { public: true } }, async (_req, reply) => sendNotice(reply, notices.signedOut()));

  const prune = setInterval(() => {
    sessions.store.prune();
    keeper.prune();
  }, PRUNE_MS);
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

/** A page shown instead of the app: what happened, and the 1 way on from here. */
export type Notice = { status: number; message: string; hint?: string; link: { href: string; text: string } };

/** Every page the login shows outside the app (the dev UI previews the same ones). */
export const notices = {
  signedOut: (): Notice => ({ status: 200, message: 'You are signed out.', link: { href: '/', text: 'Log in again' } }),
  stale: (): Notice => ({ status: 400, message: 'The login took too long or was started elsewhere.', link: { href: '/', text: 'Try again' } }),
  failed: (status: 403 | 502): Notice => ({ status, message: 'The login did not succeed.', link: { href: '/', text: 'Try again' } }),
  refused: (email: string | null, logoutUrl: URL | null): Notice => ({
    status: 403,
    message: `${email ?? 'This account'} may not use the picker.`,
    ...anotherAccount(logoutUrl),
  }),
  noEmail: (logoutUrl: URL | null): Notice => ({
    status: 403,
    message: 'This account has no email address; the picker needs one.',
    ...anotherAccount(logoutUrl),
  }),
};

/**
 * The way on from an account that is not let in. No "Try again": the provider still knows the
 * account, so a new login would be refused the same way. The way on is the provider's logout page;
 * without one the page can only say so.
 */
const anotherAccount = (logoutUrl: URL | null): Pick<Notice, 'hint' | 'link'> =>
  logoutUrl
    ? { link: { href: logoutUrl.href, text: 'Log in with another account' } }
    : { hint: 'Sign out at your login provider to use another account.', link: { href: '/', text: 'Then log in again' } };

/**
 * The page loads only what needs no session (OPEN_PATHS, the fonts): anything else would be sent
 * to the login, and start one behind the back of someone who just signed out. Its look comes from
 * the .notice classes in styles/app.css.
 */
export function sendNotice(reply: FastifyReply, { status, message, hint, link }: Notice) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>' + APP_NAME + '</title>' +
        '<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/app.css"></head>' +
        '<body><main class="notice"><img class="notice-icon" src="/favicon.svg" alt="">' +
        '<h1 class="notice-title">' + APP_NAME + '</h1>' +
        `<p class="notice-text">${escapeHtml(message)}</p>` +
        (hint ? `<p class="notice-hint">${escapeHtml(hint)}</p>` : '') +
        `<a class="notice-link" href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></main></body></html>`,
    );
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Only a literal loopback address or `localhost`; never a name that merely starts with 127. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  return isIP(h) === 4 && h.startsWith('127.');
}
