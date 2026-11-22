// The job queue (moves and give backs), in the picker's own SQLite file
// (PICKER_DATA_DIR/queue.db), never in Immich's database. Only work in flight and its recent
// history live here: losing the file loses nothing that matters, so it needs no backup.
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
  // Failed tries in a row that will be retried on their own (see retryLater); 0 after a step
  // succeeds or a Retry.
  attempts: number;
  // While pending after a transient failure: when to try again (ISO), else null.
  retryAt: string | null;
};

export type FailedJob = Job & { updatedAt: string };

/** A job as the queue page lists it. */
export type ListedJob = Job & {
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
  // Failures in its history (automatic retries included), even if a retry got it done.
  failures: number;
};

/** 1 entry of a job's history, oldest first. */
export type JobEvent = {
  at: string;
  // queued; step (a step done); waiting (for Immich's thumbnails); retrying (a transient failure,
  // tried again later on its own); failed (waits for Retry); retried (the curator's Retry);
  // resumed (after a restart); done.
  type: 'queued' | 'step' | 'waiting' | 'retrying' | 'failed' | 'retried' | 'resumed' | 'done';
  step: Step;
  message: string | null;
  // The curator (queued, retried), when known.
  by: string | null;
  // The 'copied' step when nothing was uploaded: 'existing' = the family account already had the
  // photo; 'unknown' = it had it on a later try, so maybe from this job's own earlier try.
  outcome: CopyOutcome | null;
};
export type CopyOutcome = 'existing' | 'unknown';

// active = pending + running, oldest first; failed, oldest first; done, newest first.
export type Section = 'active' | 'failed' | 'done';

export type Queue = {
  /**
   * Queues 1 job per asset; returns the ids queued (an asset with an unfinished job is skipped).
   * A move names the member it moves from; requestedBy is the curator's email (null with no login).
   */
  enqueue(kind: Kind, assetIds: string[], who?: { memberId?: string | null; requestedBy?: string | null }): string[];
  /** After a restart: jobs that were running go back to pending, keeping their step. */
  resetRunning(): number;
  /** The oldest pending job that isn't waiting (see wait) or due later (see retryLater), now running; null when none. */
  claimNext(): Job | null;
  advance(
    id: number,
    // note: shown with this step in the job history; outcome: see JobEvent.
    patch: {
      step: Step; familyAssetId?: string; originals?: string[]; familyIds?: string[]; done?: boolean; note?: string;
      outcome?: CopyOutcome;
    },
  ): void;
  fail(id: number, error: string): void;
  /** Back to pending after a transient failure, claimed again from `at` on; counts the attempt. */
  retryLater(id: number, error: string, at: Date): void;
  /** retry_at of the next job due (ISO), or null. */
  nextRetryAt(): string | null;
  /** Pending jobs due to try again later. */
  retrying(): number;
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
  /** Failed → pending, attempts afresh; any wait starts afresh. `by`: the curator. */
  retry(id: number, by?: string | null): boolean;
  /** Pending or running jobs at this step. */
  unfinishedAtStep(step: Step): number;
  counts(kind?: Kind): Record<JobStatus, number>;
  failed(): FailedJob[];
  /**
   * 1 page of a section: `limit` jobs after the cursor `after` (a job id from the previous page's
   * `next`). onlyFailures (done only): those whose history has a failure.
   */
  list(section: Section, opts?: { after?: number; limit?: number; onlyFailures?: boolean }): { jobs: ListedJob[]; next: number | null };
  /** A job's history, oldest first; null for an unknown job. */
  events(id: number): JobEvent[] | null;
  /** Deletes done jobs (with their history) last changed before `before`; returns how many. */
  prune(before: Date): number;
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
  // Automatic retries of transient failures, and each job's history (its rows go with the job).
  `ALTER TABLE job ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE job ADD COLUMN retry_at TEXT;
   CREATE TABLE job_event (
     id       INTEGER PRIMARY KEY,
     job_id   INTEGER NOT NULL,
     at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
     type     TEXT    NOT NULL,
     step     TEXT    NOT NULL,
     message  TEXT,
     by       TEXT
   );
   CREATE INDEX job_event_job ON job_event (job_id, id);`,
  // How a step went, where its history line depends on it (see JobEvent.outcome).
  `ALTER TABLE job_event ADD COLUMN outcome TEXT;`,
];

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ')`;
const PAGE = 100;
const FAILURES = `(SELECT count(*) FROM job_event e WHERE e.job_id = job.id AND e.type IN ('failed', 'retrying'))`;

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
    attempts: Number(r.attempts ?? 0),
    retryAt: (r.retry_at as string | null) ?? null,
  };
};

/** Opens (creating if needed) the queue at `path`; ':memory:' for tests. */
export function openQueue(path: string): Queue {
  const db = openSqlite(path, MIGRATIONS);

  const sql = {
    insert: db.prepare(
      `INSERT OR IGNORE INTO job (kind, source_asset_id, member_id, requested_by) VALUES (?, ?, ?, ?) RETURNING id`,
    ),
    // 1 history entry, at the job's current step.
    event: db.prepare(
      `INSERT INTO job_event (job_id, type, step, message, by, outcome) SELECT id, ?, step, ?, ?, ? FROM job WHERE id = ?`,
    ),
    resumedEvents: db.prepare(
      `INSERT INTO job_event (job_id, type, step, message) SELECT id, 'resumed', step, 'picker restarted' FROM job WHERE status = 'running'`,
    ),
    resetRunning: db.prepare(`UPDATE job SET status = 'pending', updated_at = ${NOW} WHERE status = 'running'`),
    claim: db.prepare(
      `UPDATE job SET status = 'running', retry_at = NULL, updated_at = ${NOW}
        WHERE id = (SELECT id FROM job
                     WHERE status = 'pending' AND waiting_since IS NULL
                       AND (retry_at IS NULL OR retry_at <= ${NOW})
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
              attempts = 0,
              updated_at = ${NOW}
        WHERE id = ?`,
    ),
    fail: db.prepare(`UPDATE job SET status = 'failed', error = ?, updated_at = ${NOW} WHERE id = ?`),
    retryLater: db.prepare(
      `UPDATE job SET status = 'pending', error = ?, attempts = attempts + 1, retry_at = ?, updated_at = ${NOW}
        WHERE id = ?`,
    ),
    nextRetryAt: db.prepare(`SELECT min(retry_at) AS t FROM job WHERE status = 'pending' AND retry_at IS NOT NULL`),
    retrying: db.prepare(`SELECT count(*) AS n FROM job WHERE status = 'pending' AND retry_at IS NOT NULL`),
    isWaiting: db.prepare(`SELECT waiting_since FROM job WHERE id = ?`),
    wait: db.prepare(
      `UPDATE job SET status = 'pending', waiting_since = COALESCE(waiting_since, ${NOW}), updated_at = ${NOW}
        WHERE id = ?`,
    ),
    waiting: db.prepare(`SELECT * FROM job WHERE status = 'pending' AND waiting_since IS NOT NULL ORDER BY id`),
    lastDoneAt: db.prepare(`SELECT max(updated_at) AS t FROM job WHERE step = ? AND status = 'done'`),
    retry: db.prepare(
      `UPDATE job SET status = 'pending', waiting_since = NULL, attempts = 0, retry_at = NULL, updated_at = ${NOW}
        WHERE id = ? AND status = 'failed'`,
    ),
    atStep: db.prepare(`SELECT count(*) AS n FROM job WHERE step = ? AND status IN ('pending', 'running')`),
    counts: db.prepare(`SELECT status, count(*) AS n FROM job WHERE ? IS NULL OR kind = ? GROUP BY status`),
    failed: db.prepare(`SELECT * FROM job WHERE status = 'failed' ORDER BY id`),
    listActive: db.prepare(
      `SELECT *, ${FAILURES} AS failures FROM job
        WHERE status IN ('pending', 'running') AND id > ? ORDER BY id LIMIT ?`,
    ),
    listFailed: db.prepare(
      `SELECT *, ${FAILURES} AS failures FROM job WHERE status = 'failed' AND id > ? ORDER BY id LIMIT ?`,
    ),
    listDone: db.prepare(
      `SELECT *, ${FAILURES} AS failures FROM job
        WHERE status = 'done' AND id < ? AND (NOT ? OR ${FAILURES} > 0) ORDER BY id DESC LIMIT ?`,
    ),
    exists: db.prepare(`SELECT 1 FROM job WHERE id = ?`),
    events: db.prepare(`SELECT at, type, step, message, by, outcome FROM job_event WHERE job_id = ? ORDER BY id`),
    pruneEvents: db.prepare(
      `DELETE FROM job_event WHERE job_id IN (SELECT id FROM job WHERE status = 'done' AND updated_at < ?)`,
    ),
    pruneJobs: db.prepare(`DELETE FROM job WHERE status = 'done' AND updated_at < ?`),
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

  const event = (
    id: number,
    type: JobEvent['type'],
    message: string | null = null,
    by: string | null = null,
    outcome: CopyOutcome | null = null,
  ) => void sql.event.run(type, message, by, outcome, id);

  const toListed = (r: Row): ListedJob => ({
    ...toJob(r),
    requestedBy: (r.requested_by as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    failures: Number(r.failures),
  });

  return {
    enqueue(kind, assetIds, { memberId = null, requestedBy = null } = {}) {
      return transaction(db, () =>
        assetIds.filter((assetId) => {
          const r = sql.insert.get(kind, assetId, memberId, requestedBy) as Row | undefined;
          if (r) event(Number(r.id), 'queued', null, requestedBy);
          return r !== undefined;
        }),
      );
    },
    resetRunning: () =>
      transaction(db, () => {
        sql.resumedEvents.run();
        return Number(sql.resetRunning.run().changes);
      }),
    claimNext() {
      const r = sql.claim.get() as Row | undefined;
      return r ? toJob(r) : null;
    },
    advance(id, { step, familyAssetId, originals, familyIds, done, note, outcome }) {
      const json = (v?: string[]) => (v ? JSON.stringify(v) : null);
      transaction(db, () => {
        sql.advance.run(step, familyAssetId ?? null, json(originals), json(familyIds), done ? 1 : 0, id);
        event(id, done ? 'done' : 'step', note ?? null, null, outcome);
      });
    },
    fail: (id, error) =>
      transaction(db, () => {
        sql.fail.run(error, id);
        event(id, 'failed', error);
      }),
    retryLater: (id, error, at) =>
      transaction(db, () => {
        sql.retryLater.run(error, at.toISOString(), id);
        event(id, 'retrying', error);
      }),
    nextRetryAt: () => ((sql.nextRetryAt.get() as Row).t as string | null) ?? null,
    retrying: () => Number((sql.retrying.get() as Row).n),
    wait: (id) =>
      transaction(db, () => {
        const r = sql.isWaiting.get(id) as Row | undefined;
        if (r && r.waiting_since === null) event(id, 'waiting');
        sql.wait.run(id);
      }),
    waiting: () => (sql.waiting.all() as Row[]).map(toJob),
    lastDoneAt: (step) => ((sql.lastDoneAt.get(step) as Row).t as string | null) ?? null,
    retry: (id, by = null) =>
      transaction(db, () => {
        const ok = Number(sql.retry.run(id).changes) > 0;
        if (ok) event(id, 'retried', null, by);
        return ok;
      }),
    unfinishedAtStep: (step) => Number((sql.atStep.get(step) as Row).n),
    counts(kind) {
      const out: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
      for (const r of sql.counts.all(kind ?? null, kind ?? null) as Row[]) out[r.status as JobStatus] = Number(r.n);
      return out;
    },
    failed: () => (sql.failed.all() as Row[]).map((r) => ({ ...toJob(r), updatedAt: r.updated_at as string })),
    list(section, { after, limit = PAGE, onlyFailures = false } = {}) {
      // 1 row more than asked tells whether there is a next page.
      const rows = (
        section === 'done'
          ? sql.listDone.all(after ?? Number.MAX_SAFE_INTEGER, onlyFailures ? 1 : 0, limit + 1)
          : (section === 'active' ? sql.listActive : sql.listFailed).all(after ?? 0, limit + 1)
      ) as Row[];
      const jobs = rows.slice(0, limit).map(toListed);
      return { jobs, next: rows.length > limit ? jobs[jobs.length - 1]!.id : null };
    },
    events(id) {
      if (!sql.exists.get(id)) return null;
      return (sql.events.all(id) as Row[]).map((r) => ({
        at: r.at as string,
        type: r.type as JobEvent['type'],
        step: r.step as Step,
        message: (r.message as string | null) ?? null,
        by: (r.by as string | null) ?? null,
        outcome: (r.outcome as CopyOutcome | null) ?? null,
      }));
    },
    prune: (before) =>
      transaction(db, () => {
        const t = before.toISOString();
        sql.pruneEvents.run(t);
        return Number(sql.pruneJobs.run(t).changes);
      }),
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
