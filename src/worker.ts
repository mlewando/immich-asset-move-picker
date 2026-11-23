// The in-process worker: runs queued jobs (moves and give backs) 1 at a time. Before each job it
// re-runs the upgrade guard; a failed guard pauses the worker, which then checks again every
// PAUSED_RECHECK_MS until the guard passes.
import { isTransient, transient, type GuardResult, type Immich } from './immich/index.ts';
import type { Job, Queue } from './queue.ts';

/**
 * A transient failure (see isTransient: Immich not answering or restarting, a file moved by
 * Storage Template Migration) is tried again on its own after these delays; once they run out the
 * job fails and waits for Retry. Every step is safe to repeat.
 */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

/** A paused worker runs the guard again this often, so jobs go on soon after Immich is back. */
export const PAUSED_RECHECK_MS = 10_000;

export type JobDeps = {
  queue: Queue;
  immich: Pick<
    Immich,
    'copyToFamily' | 'albumsOf' | 'archive' | 'linkToFamily' | 'missingThumbnails' | 'prepareGiveBack' | 'restore' | 'deleteFromFamily'
  >;
};

/**
 * A waiting move fails once Immich got no move's thumbnails done for this long (and it waited at
 * least as long): Immich looks stuck, not just busy with a big batch. Retry waits again.
 */
export const THUMBNAIL_STALL_MS = 30 * 60_000;

const originalsOf = (job: Job): string[] => job.originals ?? [job.sourceAssetId];

/**
 * Move to family: runs the steps after the last recorded one. Each Immich call is safe to repeat,
 * so a crash or a failure resumes cleanly.
 *
 *   queued ──copyToFamily──▶ copied ──archive──▶ archived ──linkToFamily──▶ linked
 *          ──missingThumbnails──▶ thumbnailed (done)
 *
 * The original is archived only once its family copy fully exists, so a failure before that
 * leaves the member's timeline untouched. A live photo moves with its video, a stack whole
 * (copyToFamily returns the originals, recorded with 'copied').
 *
 * Immich makes the family copy's thumbnail and preview in its own time (hours behind for a big
 * batch): until then this returns 'waiting', and checkThumbnails finishes the move later.
 *
 * Throws on failure (Immich's refusal reason or the error); the caller records it.
 */
export async function runMove(deps: JobDeps, job: Job): Promise<'done' | 'waiting'> {
  let { step, originals } = job;
  if (step === 'queued') {
    const copy = await deps.immich.copyToFamily(job.sourceAssetId);
    step = 'copied';
    originals = copy.originals;
    // For the history: was the photo copied, or already there? Only the 1st try can tell: a
    // failure, a Retry or a restart each leave an entry, and a try after one finds what the
    // earlier try uploaded just like a photo that was there all along. (A job queued before the
    // picker kept a history has no 'queued' entry: not known to be at its 1st try.)
    const history = deps.queue.events(job.id) ?? [];
    const firstTry = history.length === 1 && history[0]!.type === 'queued';
    const outcome = copy.uploaded > 0 ? undefined : firstTry ? 'existing' : 'unknown';
    const notes: string[] = [];
    if (firstTry && copy.uploaded > 0 && copy.uploaded < originals.length) {
      notes.push(`${originals.length - copy.uploaded} of ${originals.length} photos already there, not copied`);
    }
    // Only for the history: the family copy is not put into the member's albums.
    const albums = await deps.immich.albumsOf(originals);
    if (albums.length) notes.push(`In album${albums.length > 1 ? 's' : ''}: ${albums.join(', ')}`);
    deps.queue.advance(job.id, {
      step, familyAssetId: copy.familyAssetId, originals, note: notes.length ? notes.join(' • ') : undefined, outcome,
    });
  }
  // `originals` is recorded together with 'copied', so it is set from here on. The fallback (just
  // the asset itself) only covers a row advanced without it, as the resume tests do.
  if (step === 'copied') {
    // 'unchanged' is fine: archived by an earlier run whose step wasn't recorded.
    const results = await deps.immich.archive(originals ?? [job.sourceAssetId]);
    const refused = results.flatMap((r) => (r.result === 'refused' ? [r.reason] : []));
    if (refused.length) throw new Error([...new Set(refused)].join('; '));
    step = 'archived';
    deps.queue.advance(job.id, { step });
  }
  if (step === 'archived') {
    // Store each photo once. A failure here is safe: both files still exist, just twice.
    const results = await deps.immich.linkToFamily(originals ?? [job.sourceAssetId]);
    const mismatches = results.filter((r) => r.result === 'mismatch').length;
    if (mismatches) deps.queue.bump(LINK_MISMATCH, mismatches);
    const problems = results.flatMap((r) => (r.result === 'mismatch' || r.result === 'failed' ? [r] : []));
    if (problems.length) {
      const err = new Error([...new Set(problems.map((r) => `not linked: ${r.reason}`))].join('; '));
      throw problems.every((r) => r.result === 'failed' && r.transient) ? transient(err) : err;
    }
    step = 'linked';
    deps.queue.advance(job.id, { step });
  }
  if (step === 'linked') {
    // Usually not ready yet; a family copy that already existed (same bytes) is.
    if ((await deps.immich.missingThumbnails(originals ?? [job.sourceAssetId])).size) return 'waiting';
    step = 'thumbnailed';
    deps.queue.advance(job.id, { step, done: true });
  }
  return 'done';
}

/**
 * All waiting moves at once, 1 Immich query: those whose family copies have their thumbnails
 * are done. Immich works through its queue in its own order and pace, so a move doesn't fail for
 * waiting long, only when no move got its thumbnails for THUMBNAIL_STALL_MS (Immich stuck or a
 * file it can't read). Time before `since` (ms) doesn't count: the worker was paused or not
 * running then, so nobody saw whether Immich made any. Returns the jobs it finished and those it
 * failed (with the error).
 */
export async function checkThumbnails(
  deps: JobDeps,
  { now = Date.now(), stallMs = THUMBNAIL_STALL_MS, since = 0 } = {},
): Promise<{ done: Job[]; failed: { job: Job; error: string }[] }> {
  const out: { done: Job[]; failed: { job: Job; error: string }[] } = { done: [], failed: [] };
  const waiting = deps.queue.waiting();
  if (!waiting.length) return out;
  const missing = await deps.immich.missingThumbnails(waiting.flatMap(originalsOf));
  const still: Job[] = [];
  for (const job of waiting) {
    if (originalsOf(job).some((id) => missing.has(id))) {
      still.push(job);
    } else {
      deps.queue.advance(job.id, { step: 'thumbnailed', done: true });
      out.done.push(job);
    }
  }
  const last = deps.queue.lastDoneAt('thumbnailed');
  for (const job of still) {
    const from = Math.max(Date.parse(job.waitingSince!), last ? Date.parse(last) : 0, since);
    if (now - from > stallMs) {
      const error = `Immich made no thumbnails for ${Math.round(stallMs / 60_000)} min: check Immich's Generate Thumbnails job, then Retry`;
      deps.queue.fail(job.id, error);
      out.failed.push({ job, error });
    }
  }
  return out;
}

/**
 * Give back: a family asset returns to the member(s) it came from.
 *
 *   queued ──prepareGiveBack + restore──▶ restored ──deleteFromFamily──▶ deleted (done)
 *
 * Originals first: a failure after that leaves the photo in both places, never in neither. The
 * family files to delete are recorded with 'restored', so a resume deletes exactly those.
 */
export async function runGiveBack(deps: JobDeps, job: Job): Promise<'done'> {
  let { step, familyIds } = job;
  if (step === 'queued') {
    const plan = await deps.immich.prepareGiveBack(job.sourceAssetId);
    const refused = (await deps.immich.restore(plan.originals)).flatMap((r) => (r.result === 'refused' ? [r.reason] : []));
    if (refused.length) throw new Error(`original not restored: ${[...new Set(refused)].join('; ')}`);
    step = 'restored';
    familyIds = plan.familyIds;
    deps.queue.advance(job.id, { step, originals: plan.originals, familyIds });
  }
  if (step === 'restored') {
    // `familyIds` is recorded together with 'restored'; without it, only the family asset itself.
    await deps.immich.deleteFromFamily(familyIds ?? [job.sourceAssetId]);
    step = 'deleted';
    deps.queue.advance(job.id, { step, done: true });
  }
  return 'done';
}

/** Counter: files not hard-linked because they differ (the link_mismatch_total metric). */
export const LINK_MISMATCH = 'link_mismatch';

export type WorkerState = { running: boolean; paused: boolean; pausedReason: string[] };

export type Worker = {
  /** Start working if idle. Safe to call any time (enqueue, retry, startup). */
  kick(): void;
  state(): WorkerState;
  /**
   * Runs the guard now, without waiting for the next check, and starts working if it passes
   * (the curator's "Check again"). Calls made while 1 runs share it. Returns the state as the
   * check found it: `running` means a run was still going (e.g. a slow step), so work goes on only
   * once that step ends.
   */
  recheck(): Promise<WorkerState>;
  /** Resolves once the current run (if any) has finished. */
  idle(): Promise<void>;
};

export function createWorker(
  deps: JobDeps & {
    // quick: the paused worker's own timed check, which only wants to know whether it can go on
    // (see Immich.check).
    guard: (opts: { quick: boolean }) => Promise<GuardResult>;
    log: { info(msg: string): void; error(msg: string): void };
    onChange?: () => void;
    /** How often waiting moves are checked against Immich (default 30 s). */
    waitCheckMs?: number;
    /** Delays before trying a transient failure again (default RETRY_DELAYS_MS). */
    retryDelaysMs?: number[];
    /** How often a paused worker runs the guard again (default PAUSED_RECHECK_MS). */
    recheckMs?: number;
  },
): Worker {
  const waitCheckMs = deps.waitCheckMs ?? 30_000;
  const retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const recheckMs = deps.recheckMs ?? PAUSED_RECHECK_MS;
  let running: Promise<void> | null = null;
  let again = false;
  let paused = false;
  let pausedReason: string[] = [];
  let checking: Promise<WorkerState> | null = null;
  let wakeTimer: NodeJS.Timeout | undefined;
  let lastCheck = 0;
  // When the latest guard run started: a paused worker checks again recheckMs after that.
  let guardStartedAt = 0;
  // Since when the worker has been watching Immich: its own start, or the end of the last pause.
  let resumedAt = Date.now();

  const state = (): WorkerState => ({ running: running !== null, paused, pausedReason });

  // 1 guard run at a time, each after the one before: a slow check that fails (begun before
  // Immich came back) never lands after a newer one that passed and pauses the worker again.
  let guardChain: Promise<unknown> = Promise.resolve();
  // quick only for the paused worker's own timed check. Any other (Check again, the periodic
  // kick) gives a slow Immich its full time, so a busy one doesn't keep the worker paused.
  const runGuard = (quick = false): Promise<GuardResult> => {
    const run = guardChain.then(() => {
      guardStartedAt = Date.now();
      return deps.guard({ quick: quick && paused });
    });
    guardChain = run.catch(() => {});
    return run;
  };

  /** Takes a guard result: pauses, stays paused or resumes. Returns whether the worker may work. */
  const applyGuard = (guard: GuardResult): boolean => {
    const reason = guard.problems.join('; ');
    if (!guard.ok) {
      // Once per outage, not at every check during it.
      if (!paused || reason !== pausedReason.join('; ')) deps.log.error(`worker paused: ${reason}`);
    } else if (paused) {
      resumedAt = Date.now();
      // What made these jobs fail is likely what paused the worker, and that has passed.
      const due = deps.queue.retryNow();
      deps.log.info(`worker resumed${due ? `, ${due} retrying job(s) tried again now` : ''}`);
    }
    paused = !guard.ok;
    pausedReason = guard.problems;
    return guard.ok;
  };

  const drain = async (quick: boolean): Promise<void> => {
    for (let first = true; ; first = false) {
      if (!applyGuard(await runGuard(quick && first))) return;
      // Also between jobs: a long batch of copies doesn't hold back the moves already copied.
      if (Date.now() - lastCheck >= waitCheckMs) {
        lastCheck = Date.now();
        const checked = await checkThumbnails(deps, { since: resumedAt });
        for (const job of checked.done) deps.log.info(`${job.kind} ${job.id} done: ${job.sourceAssetId}`);
        for (const { job, error } of checked.failed) deps.log.error(`${job.kind} ${job.id} failed: ${error}`);
        if (checked.done.length || checked.failed.length) deps.onChange?.();
      }
      const job = deps.queue.claimNext();
      if (!job) return;
      try {
        const outcome = await (job.kind === 'giveback' ? runGiveBack : runMove)(deps, job);
        if (outcome === 'waiting') deps.queue.wait(job.id);
        else deps.log.info(`${job.kind} ${job.id} done: ${job.sourceAssetId}`);
      } catch (err) {
        const message = (err as Error).message;
        const delay = isTransient(err) ? retryDelays[job.attempts] : undefined;
        if (delay !== undefined) {
          const at = new Date(Date.now() + delay);
          deps.log.error(
            `${job.kind} ${job.id} failed (try ${job.attempts + 1} of ${retryDelays.length + 1}), trying again at ${at.toISOString()}: ${message}`,
          );
          deps.queue.retryLater(job.id, message, at);
        } else {
          deps.log.error(`${job.kind} ${job.id} failed: ${message}`);
          deps.queue.fail(job.id, message);
        }
      }
      deps.onChange?.();
    }
  };

  // quick: started by the paused worker's own timer.
  const start = (quick: boolean): void => {
    if (running) {
      // Something new arrived meanwhile: look at the queue once more after. Not for the timer:
      // the run's end sets it again if the worker is still paused, so no full check runs early.
      if (!quick) again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await drain(quick);
        } catch (err) {
          // DB or Immich unreachable: stay idle; the next kick (or the periodic one) retries.
          deps.log.error(`worker stopped: ${(err as Error).message}`);
        }
        quick = false;
      } while (again);
    })().finally(() => {
      running = null;
      scheduleWake();
      deps.onChange?.();
    });
  };
  const kick = (): void => start(false);

  // While moves wait for thumbnails, come back for the next check; while jobs wait to be tried
  // again, come back when the first is due. A paused worker comes back to check whether it can
  // go on.
  const scheduleWake = (): void => {
    clearTimeout(wakeTimer);
    if (paused) {
      // Counted from the start of the last check, so a slow failing one doesn't add its own time.
      const wait = Math.max(0, recheckMs - (Date.now() - guardStartedAt));
      wakeTimer = setTimeout(() => start(true), wait).unref();
      return;
    }
    const delays: number[] = [];
    try {
      if (deps.queue.unfinishedAtStep('linked')) delays.push(waitCheckMs - (Date.now() - lastCheck));
      const due = deps.queue.nextRetryAt();
      if (due) delays.push(Date.parse(due) - Date.now());
    } catch {
      return;
    }
    if (delays.length) wakeTimer = setTimeout(kick, Math.max(1000, Math.min(...delays))).unref();
  };

  const recheck = (): Promise<WorkerState> => {
    checking ??= (async () => {
      const ok = applyGuard(await runGuard());
      const found = state();
      if (ok) kick();
      else if (!running) scheduleWake(); // found paused while idle: keep checking
      return found;
    })().finally(() => {
      checking = null;
    });
    return checking;
  };

  return {
    kick,
    state,
    recheck,
    idle: () => running ?? Promise.resolve(),
  };
}
