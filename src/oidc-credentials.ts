// What the identity provider said about a login session: who the user is and the refresh token
// (the oidc_credentials table, see sessions.ts). Kept apart from the session data @fastify/session
// saves: it saves a whole copy of a session after each request, and a grid's hundreds of parallel
// requests writing back copies loaded before a refresh would put a spent refresh token back. Here
// the token is only ever written by a refresh, column by column.
//
// A session logged in under the local session mode has no refresh token (null).
//
// The refresh tokens are plain: with the client secret they'd extend a session, so the file stays
// in the 0700 data dir. A row goes when its session goes (foreign key, ON DELETE CASCADE).
import type { DatabaseSync } from 'node:sqlite';
import type { Row } from './sqlite.ts';

export type Identity = { sub: string; email: string; name: string | null; groups: string[] };

export type Credentials = Identity & {
  key: string; // the session's key (sessionKey in session-store.ts)
  refreshToken: string | null; // null: a login under the local session mode
  refreshedAt: number; // ms since epoch: the last refresh that went through (or the login)
};

export type CredentialStore = {
  /** After a login: the session's identity and refresh token (replacing any earlier ones). */
  save(key: string, who: Identity, refreshToken: string | null, now: number): void;
  get(key: string): Credentials | null;
  /**
   * After a refresh with `spent`: the identity as the provider now sees it, the rotated token (if
   * any), and when. Written only while `spent` is still the stored token, so a refresh that
   * finishes after a newer login in the same session can't overwrite it. Returns the credentials
   * as stored now (that newer login's, if so; null if the session went meanwhile).
   */
  refreshed(key: string, spent: string, who: Identity, refreshToken: string | null, at: number): Credentials | null;
  delete(key: string): void;
};

export function credentialStore(db: DatabaseSync): CredentialStore {
  const toCredentials = (r: Row): Credentials => ({
    key: r.session_key as string,
    sub: r.sub as string,
    email: r.email as string,
    name: (r.name as string | null) ?? null,
    groups: JSON.parse(r.groups as string) as string[],
    refreshToken: (r.refresh_token as string | null) ?? null,
    refreshedAt: Number(r.refreshed_at),
  });

  const save = db.prepare(
    `INSERT OR REPLACE INTO oidc_credentials (session_key, sub, email, name, groups, refresh_token, refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const select = db.prepare(`SELECT * FROM oidc_credentials WHERE session_key = ?`);
  const refreshed = db.prepare(
    `UPDATE oidc_credentials
        SET sub = ?, email = ?, name = ?, groups = ?, refresh_token = COALESCE(?, refresh_token), refreshed_at = ?
      WHERE session_key = ? AND refresh_token = ?
      RETURNING *`,
  );
  const remove = db.prepare(`DELETE FROM oidc_credentials WHERE session_key = ?`);

  const get = (key: string): Credentials | null => {
    const r = select.get(key) as Row | undefined;
    return r ? toCredentials(r) : null;
  };

  return {
    save: (key, who, refreshToken, now) =>
      void save.run(key, who.sub, who.email, who.name, JSON.stringify(who.groups), refreshToken, now),
    get,
    refreshed(key, spent, who, refreshToken, at) {
      const r = refreshed.get(who.sub, who.email, who.name, JSON.stringify(who.groups), refreshToken, at, key, spent) as Row | undefined;
      return r ? toCredentials(r) : get(key);
    },
    delete: (key) => void remove.run(key),
  };
}
