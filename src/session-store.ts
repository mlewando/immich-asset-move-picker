// The @fastify/session store: login sessions in SQLite (the http_session table, see sessions.ts).
// It knows nothing about OIDC; the provider's tokens live in their own table (oidc-credentials.ts)
// and are never written by a session save.
//
// @fastify/session hands over a session id that is also in the browser's cookie; the table keeps
// only its SHA-256 (sessionKey), so a copy of the file can't be replayed as a cookie.
import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Session } from 'fastify';
import type { SessionStore } from '@fastify/session';
import type { Row } from './sqlite.ts';

type Callback = (err?: unknown) => void;

/**
 * The table key for a session id. Part of this store's contract: other tables point at a session
 * by it (and go with it, by foreign key).
 */
export const sessionKey = (sessionStoreId: string) => createHash('sha256').update(sessionStoreId).digest('base64url');

// @fastify/session's generation marker: compareAndSet replaces a session only when the stored one
// is still the generation the request loaded (a regenerated or destroyed session stays so).
const generationOf = (session: Session, sessionStoreId: string): string =>
  (session as { __fastifySessionMetadata?: { generation?: string } }).__fastifySessionMetadata?.generation ?? sessionStoreId;

// When the session ends unless a request extends it: its cookie's expiry (maxAge = idle time).
const expiresOf = (session: Session): number => {
  const at = session.cookie.expires ? new Date(session.cookie.expires).getTime() : NaN;
  return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
};

const gone = () => Object.assign(new Error('the session does not exist or has changed'), { code: 'ENOENT' });

export class SqliteSessionStore implements SessionStore {
  readonly #insert: StatementSync;
  readonly #select: StatementSync;
  readonly #update: StatementSync;
  readonly #remove: StatementSync;
  readonly #prune: StatementSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.#now = now;
    this.#insert = db.prepare(
      `INSERT INTO http_session (key, generation, data, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET generation = excluded.generation, data = excluded.data, expires_at = excluded.expires_at`,
    );
    this.#select = db.prepare(`SELECT data, expires_at FROM http_session WHERE key = ?`);
    this.#update = db.prepare(`UPDATE http_session SET generation = ?, data = ?, expires_at = ? WHERE key = ? AND generation = ?`);
    this.#remove = db.prepare(`DELETE FROM http_session WHERE key = ?`);
    this.#prune = db.prepare(`DELETE FROM http_session WHERE expires_at <= ?`);
  }

  set(sessionStoreId: string, session: Session, callback: Callback): void {
    this.#run(callback, () => {
      this.#insert.run(sessionKey(sessionStoreId), generationOf(session, sessionStoreId), JSON.stringify(session), expiresOf(session));
    });
  }

  get(sessionStoreId: string, callback: (err: unknown, result?: Session | null) => void): void {
    let session: Session | null;
    try {
      const key = sessionKey(sessionStoreId);
      const r = this.#select.get(key) as Row | undefined;
      // An expired session is gone, with every row that points at it (foreign keys, ON DELETE CASCADE).
      if (r && Number(r.expires_at) <= this.#now()) this.#remove.run(key);
      session = r && Number(r.expires_at) > this.#now() ? (JSON.parse(r.data as string) as Session) : null;
    } catch (err) {
      callback(err);
      return;
    }
    callback(null, session);
  }

  compareAndSet(sessionStoreId: string, expectedGeneration: string, session: Session, callback: Callback): void {
    this.#run(callback, () => {
      const { changes } = this.#update.run(
        generationOf(session, sessionStoreId),
        JSON.stringify(session),
        expiresOf(session),
        sessionKey(sessionStoreId),
        expectedGeneration,
      );
      if (Number(changes) === 0) throw gone();
    });
  }

  destroy(sessionStoreId: string, callback: Callback): void {
    this.#run(callback, () => void this.#remove.run(sessionKey(sessionStoreId)));
  }

  /** Deletes the sessions past their expiry that no request came back for. */
  prune(): void {
    this.#prune.run(this.#now());
  }

  #run(callback: Callback, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      callback(err);
      return;
    }
    callback();
  }
}
