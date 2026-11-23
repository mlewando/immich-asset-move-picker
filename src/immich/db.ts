import pg from 'pg';
import type { Config } from '../config.ts';

// Immich's Postgres, as the picker's own role (read grants + archive ⇄ timeline, see
// dev/picker-db.sql). Only src/immich/ uses it; the narrow surface lets unit tests pass a fake.
export type Db = {
  query<R extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
  close(): Promise<void>;
};

/**
 * `max` connections (default 4). `queryTimeoutMs` fails a query that has no answer by then and
 * drops its connection; without it a query waits as long as it takes.
 */
export function createDb(cfg: Config['db'], { max = 4, queryTimeoutMs }: { max?: number; queryTimeoutMs?: number } = {}): Db {
  const pool = new pg.Pool({
    ...cfg,
    max,
    connectionTimeoutMillis: 5000,
    query_timeout: queryTimeoutMs,
    application_name: 'immich-asset-move-picker',
  });
  // An idle client losing its connection (Postgres restart) must not crash the process.
  pool.on('error', (err) => console.error(`db pool error: ${err.message}`));
  return {
    async query<R extends Record<string, unknown>>(sql: string, params?: unknown[]) {
      const res = await pool.query<R>(sql, params);
      return res.rows;
    },
    close: () => pool.end(),
  };
}
