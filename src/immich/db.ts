import pg from 'pg';
import type { Config } from '../config.ts';

// Immich's Postgres, as the picker's own role (read grants + archive ⇄ timeline, see
// dev/picker-db.sql). Only src/immich/ uses it; the narrow surface lets unit tests pass a fake.
export type Db = {
  query<R extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
  close(): Promise<void>;
};

export function createDb(cfg: Config['db']): Db {
  const pool = new pg.Pool({
    ...cfg,
    max: 4,
    connectionTimeoutMillis: 5000,
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
