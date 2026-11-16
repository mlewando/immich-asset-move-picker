// Login sessions, in the picker's own SQLite file (PICKER_DATA_DIR/sessions.db). They live on the
// server, not in a cookie: the identity provider rotates refresh tokens, and a grid's hundreds of
// parallel requests each writing back their own copy of a cookie session would race on it. Here
// the token is updated in 1 place. The cookie holds only a random id; the file keeps its SHA-256,
// so a copy of the file can't be replayed as a cookie. The refresh tokens in it are plain, though:
// with the client secret they'd extend a session, so the file stays in the 0700 data dir. Losing
// the file only logs everyone out.
import { createHash, randomBytes } from 'node:crypto';
import { openSqlite, type Row } from './sqlite.ts';

export type Identity = { sub: string; email: string; name: string | null; groups: string[] };

export type Session = Identity & {
  key: string; // SHA-256 of the cookie value
  refreshToken: string;
  createdAt: number; // ms since epoch
  refreshedAt: number;
  lastSeen: number;
};

export type Sessions = {
  /** Stores a new session; returns the cookie value. */
  create(who: Identity, refreshToken: string, now: number): string;
  get(cookie: string): Session | null;
  touch(key: string, now: number): void;
  /**
   * After a refresh: the identity as the provider now sees it, and the rotated token (if any).
   * Returns the session as stored now (null if it was deleted meanwhile).
   */
  refreshed(key: string, who: Identity, refreshToken: string | null, now: number): Session | null;
  delete(key: string): void;
  /** Deletes sessions last seen before `before`. */
  prune(before: number): void;
  close(): void;
};

// Versioned schema (see openSqlite). Never edit a released migration: add a new one.
const MIGRATIONS = [
  `CREATE TABLE session (
     key            TEXT    PRIMARY KEY,
     sub            TEXT    NOT NULL,
     email          TEXT    NOT NULL,
     name           TEXT,
     groups         TEXT    NOT NULL, -- JSON array
     refresh_token  TEXT    NOT NULL,
     created_at     INTEGER NOT NULL,
     refreshed_at   INTEGER NOT NULL,
     last_seen      INTEGER NOT NULL
   )`,
];

const sessionKey = (cookie: string) => createHash('sha256').update(cookie).digest('base64url');

/** Opens (creating if needed) the session store at `path`; ':memory:' for tests. */
export function openSessions(path: string): Sessions {
  const db = openSqlite(path, MIGRATIONS);

  const toSession = (r: Row): Session => ({
    key: r.key as string,
    sub: r.sub as string,
    email: r.email as string,
    name: (r.name as string | null) ?? null,
    groups: JSON.parse(r.groups as string) as string[],
    refreshToken: r.refresh_token as string,
    createdAt: Number(r.created_at),
    refreshedAt: Number(r.refreshed_at),
    lastSeen: Number(r.last_seen),
  });

  const insert = db.prepare(
    `INSERT INTO session (key, sub, email, name, groups, refresh_token, created_at, refreshed_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const select = db.prepare(`SELECT * FROM session WHERE key = ?`);
  const touch = db.prepare(`UPDATE session SET last_seen = ? WHERE key = ?`);
  const refreshed = db.prepare(
    `UPDATE session
        SET sub = ?, email = ?, name = ?, groups = ?, refresh_token = COALESCE(?, refresh_token), refreshed_at = ?
      WHERE key = ?
      RETURNING *`,
  );
  const remove = db.prepare(`DELETE FROM session WHERE key = ?`);
  const prune = db.prepare(`DELETE FROM session WHERE last_seen < ?`);

  return {
    create(who, refreshToken, now) {
      const cookie = randomBytes(32).toString('base64url');
      insert.run(sessionKey(cookie), who.sub, who.email, who.name, JSON.stringify(who.groups), refreshToken, now, now, now);
      return cookie;
    },
    get(cookie) {
      const r = select.get(sessionKey(cookie)) as Row | undefined;
      return r ? toSession(r) : null;
    },
    touch: (key, now) => void touch.run(now, key),
    refreshed(key, who, refreshToken, now) {
      const r = refreshed.get(who.sub, who.email, who.name, JSON.stringify(who.groups), refreshToken, now, key) as Row | undefined;
      return r ? toSession(r) : null;
    },
    delete: (key) => void remove.run(key),
    prune: (before) => void prune.run(before),
    close: () => db.close(),
  };
}
