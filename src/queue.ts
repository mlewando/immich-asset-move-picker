// The job queue (moves and give backs), in the picker's own SQLite file
// (PICKER_DATA_DIR/queue.db), never in Immich's database. Only work in flight lives here: losing
// the file loses nothing that matters, so it needs no backup. node:sqlite is built into Node 24.
import { DatabaseSync } from 'node:sqlite';

// The last completed step. Each step's Immich call is safe to repeat, so a resume re-runs the next.
//   move:     queued → copied → archived → linked (done)
//   giveback: queued → restored → deleted (done)
export const STEPS = ['queued', 'copied', 'archived', 'linked', 'restored', 'deleted'] as const;
export type Step = (typeof STEPS)[number];
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export type Kind = 'move' | 'giveback';

export type Job = {
  id: number;
  kind: Kind;
  // move: the member's asset; giveback: the family asset.
  sourceAssetId: string;
  memberId: string | null;
  status: JobStatus;
  step: Step;
  familyAssetId: string | null;
  // move: the originals to archive (the asset, or a whole stack), recorded with 'copied';
  // giveback: the originals put back, recorded with 'restored'.
  originals: string[] | null;
  // giveback: the family assets to delete, recorded with 'restored'.
  familyIds: string[] | null;
  error: string | null;
};

export type FailedJob = Job & { updatedAt: string };

export type Queue = {
  /** Queues 1 job per asset; returns the ids queued (an asset with an unfinished job is skipped). */
  enqueue(memberId: string | null, assetIds: string[], requestedBy: string | null, kind?: Kind): string[];
  /** After a restart: jobs that were running go back to pending, keeping their step. */
  resetRunning(): number;
  claimNext(): Job | null;
  advance(
    id: number,
    patch: { step: Step; familyAssetId?: string; originals?: string[]; familyIds?: string[]; done?: boolean },
  ): void;
  fail(id: number, error: string): void;
  retry(id: number): boolean;
  counts(kind?: Kind): Record<JobStatus, number>;
  failed(): FailedJob[];
  /** created_at of the oldest pending or running job (ISO), or null. */
  oldestPendingAt(): string | null;
  // Counters kept across restarts (metrics).
  counter(name: string): number;
  bump(name: string, by: number): void;
  close(): void;
};

// Versioned schema (PRAGMA user_version). Never edit a released migration: add a new one.
export const MIGRATIONS = [
  `CREATE TABLE job (
     id                 INTEGER PRIMARY KEY,
     kind               TEXT    NOT NULL CHECK (kind IN ('move', 'giveback')),
     source_asset_id    TEXT    NOT NULL,
     member_id          TEXT,
     status             TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'done', 'failed')),
     step               TEXT    NOT NULL DEFAULT 'queued', -- checked in code (STEPS)
     family_asset_id    TEXT,
     original_ids       TEXT,   -- JSON array
     family_ids         TEXT,   -- JSON array
     error              TEXT,
     requested_by       TEXT,
     created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
     updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
   );
   -- At most 1 unfinished job per asset.
   CREATE UNIQUE INDEX job_source_unfinished ON job (source_asset_id)
     WHERE status IN ('pending', 'running', 'failed');
   CREATE INDEX job_status ON job (status, id);
   CREATE TABLE counter (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`,
];

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ')`;

type Row = Record<string, unknown>;
const ids = (v: unknown) => (v ? (JSON.parse(v as string) as string[]) : null);
const toJob = (r: Row): Job => {
  const step = r.step as Step;
  if (!STEPS.includes(step)) throw new Error(`job ${String(r.id)}: unknown step ${String(r.step)}`);
  return {
    id: Number(r.id),
    kind: r.kind as Kind,
    sourceAssetId: r.source_asset_id as string,
    memberId: (r.member_id as string | null) ?? null,
    status: r.status as JobStatus,
    step,
    familyAssetId: (r.family_asset_id as string | null) ?? null,
    originals: ids(r.original_ids),
    familyIds: ids(r.family_ids),
    error: (r.error as string | null) ?? null,
  };
};

/** Opens (creating if needed) the queue at `path`; ':memory:' for tests. */
export function openQueue(path: string): Queue {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const version = Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
  if (version > MIGRATIONS.length) throw new Error(`${path}: schema version ${version} is newer than this picker knows`);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const insert = db.prepare(`INSERT OR IGNORE INTO job (kind, source_asset_id, member_id, requested_by) VALUES (?, ?, ?, ?)`);
  const claim = db.prepare(
    `UPDATE job SET status = 'running', updated_at = ${NOW}
      WHERE id = (SELECT id FROM job WHERE status = 'pending' ORDER BY id LIMIT 1)
      RETURNING *`,
  );
  const advance = db.prepare(
    `UPDATE job
        SET step = ?,
            family_asset_id = COALESCE(?, family_asset_id),
            original_ids = COALESCE(?, original_ids),
            family_ids = COALESCE(?, family_ids),
            status = CASE WHEN ? THEN 'done' ELSE status END,
            error = NULL,
            updated_at = ${NOW}
      WHERE id = ?`,
  );

  return {
    enqueue(memberId, assetIds, requestedBy, kind = 'move') {
      const queued: string[] = [];
      db.exec('BEGIN');
      try {
        for (const id of assetIds) {
          if (Number(insert.run(kind, id, memberId, requestedBy).changes) > 0) queued.push(id);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return queued;
    },
    resetRunning() {
      return Number(db.prepare(`UPDATE job SET status = 'pending', updated_at = ${NOW} WHERE status = 'running'`).run().changes);
    },
    claimNext() {
      const r = claim.get() as Row | undefined;
      return r ? toJob(r) : null;
    },
    advance(id, { step, familyAssetId, originals, familyIds, done }) {
      const json = (v?: string[]) => (v ? JSON.stringify(v) : null);
      advance.run(step, familyAssetId ?? null, json(originals), json(familyIds), done ? 1 : 0, id);
    },
    fail(id, error) {
      db.prepare(`UPDATE job SET status = 'failed', error = ?, updated_at = ${NOW} WHERE id = ?`).run(error, id);
    },
    retry(id) {
      return Number(db.prepare(`UPDATE job SET status = 'pending', updated_at = ${NOW} WHERE id = ? AND status = 'failed'`).run(id).changes) > 0;
    },
    counts(kind) {
      const out: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
      const rows = db.prepare(`SELECT status, count(*) AS n FROM job WHERE ? IS NULL OR kind = ? GROUP BY status`).all(kind ?? null, kind ?? null);
      for (const r of rows as Row[]) out[r.status as JobStatus] = Number(r.n);
      return out;
    },
    failed() {
      return (db.prepare(`SELECT * FROM job WHERE status = 'failed' ORDER BY id`).all() as Row[]).map((r) => ({
        ...toJob(r),
        updatedAt: r.updated_at as string,
      }));
    },
    oldestPendingAt() {
      const r = db.prepare(`SELECT min(created_at) AS t FROM job WHERE status IN ('pending', 'running')`).get() as Row;
      return (r.t as string | null) ?? null;
    },
    counter(name) {
      const r = db.prepare(`SELECT value FROM counter WHERE name = ?`).get(name) as Row | undefined;
      return r ? Number(r.value) : 0;
    },
    bump(name, by) {
      db.prepare(`INSERT INTO counter (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = value + excluded.value`).run(name, by);
    },
    close: () => db.close(),
  };
}
