// The login sessions' file (PICKER_DATA_DIR/sessions.db): the @fastify/session store's table
// (session-store.ts), the OIDC credentials per session (oidc-credentials.ts), and the key that
// signs the session cookie. Losing the file only logs everyone out.
import { randomBytes } from 'node:crypto';
import { credentialStore, type CredentialStore } from './oidc-credentials.ts';
import { SqliteSessionStore } from './session-store.ts';
import { openSqlite, transaction, type Row } from './sqlite.ts';

export type Sessions = {
  store: SqliteSessionStore;
  credentials: CredentialStore;
  /** Signs the session cookie; kept here so sessions survive a restart. */
  cookieSecret: string;
  close(): void;
};

// Versioned schema (see openSqlite). Never edit a released migration: add a new one.
const MIGRATIONS = [
  `CREATE TABLE http_session (
     key         TEXT    PRIMARY KEY, -- SHA-256 of @fastify/session's session id
     generation  TEXT    NOT NULL,    -- @fastify/session's compare-and-set marker
     data        TEXT    NOT NULL,    -- the session as @fastify/session saves it (JSON)
     expires_at  INTEGER NOT NULL     -- ms since epoch
   );
   CREATE INDEX http_session_expires ON http_session (expires_at);
   CREATE TABLE oidc_credentials (
     session_key    TEXT    PRIMARY KEY REFERENCES http_session (key) ON DELETE CASCADE,
     sub            TEXT    NOT NULL,
     email          TEXT    NOT NULL,
     name           TEXT,
     groups         TEXT    NOT NULL, -- JSON array
     refresh_token  TEXT    NOT NULL,
     refreshed_at   INTEGER NOT NULL
   );
   CREATE TABLE secret (name TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // A login under the local session mode keeps no refresh token. SQLite can't drop NOT NULL from a
  // column: copy the rows into a new table, drop the old one and give the new one its name.
  `CREATE TABLE oidc_credentials_new (
     session_key    TEXT    PRIMARY KEY REFERENCES http_session (key) ON DELETE CASCADE,
     sub            TEXT    NOT NULL,
     email          TEXT    NOT NULL,
     name           TEXT,
     groups         TEXT    NOT NULL, -- JSON array
     refresh_token  TEXT,             -- null: a login under the local session mode
     refreshed_at   INTEGER NOT NULL
   );
   INSERT INTO oidc_credentials_new SELECT session_key, sub, email, name, groups, refresh_token, refreshed_at FROM oidc_credentials;
   DROP TABLE oidc_credentials;
   ALTER TABLE oidc_credentials_new RENAME TO oidc_credentials;`,
];

/** Opens (creating if needed) the session file at `path`; ':memory:' for tests. */
export function openSessions(path: string, now: () => number = Date.now): Sessions {
  const db = openSqlite(path, MIGRATIONS);
  db.exec('PRAGMA foreign_keys = ON');
  const cookieSecret = transaction(db, () => {
    const r = db.prepare(`SELECT value FROM secret WHERE name = 'session_cookie'`).get() as Row | undefined;
    if (r) return r.value as string;
    const value = randomBytes(32).toString('base64url');
    db.prepare(`INSERT INTO secret (name, value) VALUES ('session_cookie', ?)`).run(value);
    return value;
  });
  return { store: new SqliteSessionStore(db, now), credentials: credentialStore(db), cookieSecret, close: () => db.close() };
}
