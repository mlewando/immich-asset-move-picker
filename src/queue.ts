// The job queue (moves and give backs), in the picker's own SQLite file
// (PICKER_DATA_DIR/queue.db), never in Immich's database. Only work in flight lives here: losing
// the file loses nothing that matters, so it needs no backup.
import { openSqlite, transaction, type Row } from './sqlite.ts';

// The last completed step. Each step's Immich call is safe to repeat, so a resume re-runs the next.
//   move:     queued → copied → archived → linked → thumbnailed (done)
//   giveback: queued → restored → deleted (done)
export const STEPS = ['queued', 'copied', 'archived', 'linked', 'thumbnailed', 'restored', 'deleted'] as const;
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
  // When the job started waiting for Immich (see wait), or null.
  waitingSince: string | null;
};

export type FailedJob = Job & { updatedAt: string };

export type Queue = {
  /**
   * Queues 1 job per asset; returns the ids queued (an asset with an unfinished job is skipped).
   * A move names the member it moves from; requestedBy is the curator's email (null with no login).
   */
  enqueue(kind: Kind, assetIds: string[], who?: { memberId?: string | null; requestedBy?: string | null }): string[];
  /** After a restart: jobs that were running go back to pending, keeping their step. */
  resetRunning(): number;
  /** The oldest pending job that isn't waiting (see wait), now running; null when none. */
  claimNext(): Job | null;
  advance(
    id: number,
    patch: { step: Step; familyAssetId?: string; originals?: string[]; familyIds?: string[]; done?: boolean },
  ): void;
  fail(id: number, error: string): void;
  /**
   * Back to pending at the same step, waiting for something Immich does on its own: no longer
   * claimed 1 by 1, but listed by waiting() to be checked all together. The 1st wait records
   * waitingSince.
   */
  wait(id: number): void;
  /** The waiting jobs, oldest first. */
  waiting(): Job[];
  /** updated_at of the latest job done at this step (ISO), or null. */
  lastDoneAt(step: Step): string | null;
  /** Failed → pending; any wait starts afresh. */
  retry(id: number): boolean;
  /** Pending or running jobs at this step. */
  unfinishedAtStep(step: Step): number;
  counts(kind?: Kind): Record<JobStatus, number>;
  failed(): FailedJob[];
  /**
   * Asset ids an unfinished (pending, running or failed) job of this kind works on: each job's
   * asset plus the originals and family assets recorded so far (a whole stack once known).
   */
  unfinishedAssetIds(kind: Kind): Set<string>;
  /** created_at of the oldest pending or running job (ISO), or null. */
  oldestPendingAt(): string | null;
  // Counters kept across restarts (metrics).
  counter(name: string): number;
  bump(name: string, by: number): void;
  close(): void;
};

// Versioned schema (see openSqlite). Never edit a released migration: add a new one.
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
  // Set while a pending job waits for Immich (thumbnails).
  `ALTER TABLE job ADD COLUMN waiting_since TEXT;`,
];

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ')`;

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
    waitingSince: (r.waiting_since as string | null) ?? null,
  };
};

/** Opens (creating if needed) the queue at `path`; ':memory:' for tests. */
export function openQueue(path: string): Queue {
  const db = openSqlite(path, MIGRATIONS);

  const sql = {
    insert: db.prepare(`INSERT OR IGNORE INTO job (kind, source_asset_id, member_id, requested_by) VALUES (?, ?, ?, ?)`),
    resetRunning: db.prepare(`UPDATE job SET status = 'pending', updated_at = ${NOW} WHERE status = 'running'`),
    claim: db.prepare(
      `UPDATE job SET status = 'running', updated_at = ${NOW}
        WHERE id = (SELECT id FROM job
                     WHERE status = 'pending' AND waiting_since IS NULL
                     ORDER BY id LIMIT 1)
        RETURNING *`,
    ),
    advance: db.prepare(
      `UPDATE job
          SET step = ?,
              family_asset_id = COALESCE(?, family_asset_id),
              original_ids = COALESCE(?, original_ids),
              family_ids = COALESCE(?, family_ids),
              status = CASE WHEN ? THEN 'done' ELSE status END,
              error = NULL,
              updated_at = ${NOW}
        WHERE id = ?`,
    ),
    fail: db.prepare(`UPDATE job SET status = 'failed', error = ?, updated_at = ${NOW} WHERE id = ?`),
    wait: db.prepare(
      `UPDATE job SET status = 'pending', waiting_since = COALESCE(waiting_since, ${NOW}), updated_at = ${NOW}
        WHERE id = ?`,
    ),
    waiting: db.prepare(`SELECT * FROM job WHERE status = 'pending' AND waiting_since IS NOT NULL ORDER BY id`),
    lastDoneAt: db.prepare(`SELECT max(updated_at) AS t FROM job WHERE step = ? AND status = 'done'`),
    retry: db.prepare(
      `UPDATE job SET status = 'pending', waiting_since = NULL, updated_at = ${NOW} WHERE id = ? AND status = 'failed'`,
    ),
    atStep: db.prepare(`SELECT count(*) AS n FROM job WHERE step = ? AND status IN ('pending', 'running')`),
    counts: db.prepare(`SELECT status, count(*) AS n FROM job WHERE ? IS NULL OR kind = ? GROUP BY status`),
    failed: db.prepare(`SELECT * FROM job WHERE status = 'failed' ORDER BY id`),
    unfinished: db.prepare(
      `SELECT source_asset_id, original_ids, family_ids FROM job
        WHERE kind = ? AND status IN ('pending', 'running', 'failed')`,
    ),
    oldestPendingAt: db.prepare(`SELECT min(created_at) AS t FROM job WHERE status IN ('pending', 'running')`),
    counter: db.prepare(`SELECT value FROM counter WHERE name = ?`),
    bump: db.prepare(
      `INSERT INTO counter (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = value + excluded.value`,
    ),
  };

  return {
    enqueue(kind, assetIds, { memberId = null, requestedBy = null } = {}) {
      return transaction(db, () =>
        assetIds.filter((id) => Number(sql.insert.run(kind, id, memberId, requestedBy).changes) > 0),
      );
    },
    resetRunning: () => Number(sql.resetRunning.run().changes),
    claimNext() {
      const r = sql.claim.get() as Row | undefined;
      return r ? toJob(r) : null;
    },
    advance(id, { step, familyAssetId, originals, familyIds, done }) {
      const json = (v?: string[]) => (v ? JSON.stringify(v) : null);
      sql.advance.run(step, familyAssetId ?? null, json(originals), json(familyIds), done ? 1 : 0, id);
    },
    fail: (id, error) => void sql.fail.run(error, id),
    wait: (id) => void sql.wait.run(id),
    waiting: () => (sql.waiting.all() as Row[]).map(toJob),
    lastDoneAt: (step) => ((sql.lastDoneAt.get(step) as Row).t as string | null) ?? null,
    retry: (id) => Number(sql.retry.run(id).changes) > 0,
    unfinishedAtStep: (step) => Number((sql.atStep.get(step) as Row).n),
    counts(kind) {
      const out: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
      for (const r of sql.counts.all(kind ?? null, kind ?? null) as Row[]) out[r.status as JobStatus] = Number(r.n);
      return out;
    },
    failed: () => (sql.failed.all() as Row[]).map((r) => ({ ...toJob(r), updatedAt: r.updated_at as string })),
    unfinishedAssetIds(kind) {
      const out = new Set<string>();
      for (const r of sql.unfinished.all(kind) as Row[]) {
        out.add(r.source_asset_id as string);
        for (const id of [...(ids(r.original_ids) ?? []), ...(ids(r.family_ids) ?? [])]) out.add(id);
      }
      return out;
    },
    oldestPendingAt: () => ((sql.oldestPendingAt.get() as Row).t as string | null) ?? null,
    counter(name) {
      const r = sql.counter.get(name) as Row | undefined;
      return r ? Number(r.value) : 0;
    },
    bump: (name, by) => void sql.bump.run(name, by),
    close: () => db.close(),
  };
}
