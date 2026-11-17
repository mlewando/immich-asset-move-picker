// The picker's own SQLite files (job queue, login sessions). node:sqlite is built into Node 24.
import { DatabaseSync } from 'node:sqlite';

export type Row = Record<string, unknown>;

/** Runs `fn` in 1 transaction: all of its writes, or none if it throws. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Opens (creating if needed) the file at `path` (':memory:' for tests) and brings its schema up to
 * date. The schema is versioned by PRAGMA user_version: never edit a released migration, add one.
 */
export function openSqlite(path: string, migrations: readonly string[]): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const version = Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
  if (version > migrations.length) throw new Error(`${path}: schema version ${version} is newer than this picker knows`);
  for (let v = version; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}
