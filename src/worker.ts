// The in-process worker: runs queued jobs (moves and give backs) 1 at a time. Before each job it
// re-runs the upgrade guard; a failed guard pauses the worker until the next kick.
import { isTransient, transient, type GuardResult, type Immich } from './immich/index.ts';
import type { Job, Queue } from './queue.ts';

/**
 * A transient failure (see isTransient: Immich not answering or restarting, a file moved by
 * Storage Template Migration) is tried again on its own after these delays; once they run out the
 * job fails and waits for Retry. Every step is safe to repeat.
 */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

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
 * file it can't read). Returns the jobs it finished and those it failed (with the error).
 */
export async function checkThumbnails(
  deps: JobDeps,
  { now = Date.now(), stallMs = THUMBNAIL_STALL_MS } = {},
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
    const since = Math.max(Date.parse(job.waitingSince!), last ? Date.parse(last) : 0);
    if (now - since > stallMs) {
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
  /** Resolves once the current run (if any) has finished. */
  idle(): Promise<void>;
};

export function createWorker(
  deps: JobDeps & {
    guard: () => Promise<GuardResult>;
    log: { info(msg: string): void; error(msg: string): void };
    onChange?: () => void;
    /** How often waiting moves are checked against Immich (default 30 s). */
    waitCheckMs?: number;
    /** Delays before trying a transient failure again (default RETRY_DELAYS_MS). */
    retryDelaysMs?: number[];
  },
): Worker {
  const waitCheckMs = deps.waitCheckMs ?? 30_000;
  const retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  let running: Promise<void> | null = null;
  let again = false;
  let paused = false;
  let pausedReason: string[] = [];
  let wakeTimer: NodeJS.Timeout | undefined;
  let lastCheck = 0;

  const drain = async (): Promise<void> => {
    for (;;) {
      const guard = await deps.guard();
      paused = !guard.ok;
      pausedReason = guard.problems;
      if (paused) {
        deps.log.error(`worker paused: ${guard.problems.join('; ')}`);
        return;
      }
      // Also between jobs: a long batch of copies doesn't hold back the moves already copied.
      if (Date.now() - lastCheck >= waitCheckMs) {
        lastCheck = Date.now();
        const checked = await checkThumbnails(deps);
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

  const kick = (): void => {
    if (running) {
      again = true; // something new arrived meanwhile: look at the queue once more after
      return;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await drain();
        } catch (err) {
          // DB or Immich unreachable: stay idle; the next kick (or the periodic one) retries.
          deps.log.error(`worker stopped: ${(err as Error).message}`);
        }
      } while (again);
    })().finally(() => {
      running = null;
      scheduleWake();
      deps.onChange?.();
    });
  };

  // While moves wait for thumbnails, come back for the next check; while jobs wait to be tried
  // again, come back when the first is due. A paused worker waits for the periodic kick instead.
  const scheduleWake = (): void => {
    clearTimeout(wakeTimer);
    if (paused) return;
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

  return {
    kick,
    state: () => ({ running: running !== null, paused, pausedReason }),
    idle: () => running ?? Promise.resolve(),
  };
}
