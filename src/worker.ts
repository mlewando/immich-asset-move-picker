// The in-process worker: runs queued jobs (moves and give backs) 1 at a time. Before each job it
// re-runs the upgrade guard; a failed guard pauses the worker until the next kick.
import type { GuardResult, Immich } from './immich/index.ts';
import type { Job, Queue } from './queue.ts';

export type JobDeps = {
  queue: Queue;
  immich: Pick<Immich, 'copyToFamily' | 'archive' | 'linkToFamily' | 'prepareGiveBack' | 'restore' | 'deleteFromFamily'>;
};

/**
 * Move to family: runs the steps after the last recorded one. Each Immich call is safe to repeat,
 * so a crash or a failure resumes cleanly.
 *
 *   queued ──copyToFamily──▶ copied ──archive──▶ archived ──linkToFamily──▶ linked (done)
 *
 * The original is archived only once its family copy fully exists, so a failure before that
 * leaves the member's timeline untouched. A live photo moves with its video, a stack whole
 * (copyToFamily returns the originals, recorded with 'copied').
 *
 * Throws on failure (Immich's refusal reason or the error); the caller records it.
 */
export async function runMove(deps: JobDeps, job: Job): Promise<void> {
  let { step, originals } = job;
  if (step === 'queued') {
    const copy = await deps.immich.copyToFamily(job.sourceAssetId);
    step = 'copied';
    originals = copy.originals;
    deps.queue.advance(job.id, { step, familyAssetId: copy.familyAssetId, originals });
  }
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
    const problems = results.flatMap((r) => (r.result === 'mismatch' || r.result === 'failed' ? [`not linked: ${r.reason}`] : []));
    if (problems.length) throw new Error([...new Set(problems)].join('; '));
    step = 'linked';
    deps.queue.advance(job.id, { step, done: true });
  }
}

/**
 * Give back: a family asset returns to the member(s) it came from.
 *
 *   queued ──prepareGiveBack + restore──▶ restored ──deleteFromFamily──▶ deleted (done)
 *
 * Originals first: a failure after that leaves the photo in both places, never in neither. The
 * family files to delete are recorded with 'restored', so a resume deletes exactly those.
 */
export async function runGiveBack(deps: JobDeps, job: Job): Promise<void> {
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
    await deps.immich.deleteFromFamily(familyIds ?? [job.sourceAssetId]);
    step = 'deleted';
    deps.queue.advance(job.id, { step, done: true });
  }
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
  },
): Worker {
  let running: Promise<void> | null = null;
  let again = false;
  let paused = false;
  let pausedReason: string[] = [];

  const drain = async (): Promise<void> => {
    for (;;) {
      const guard = await deps.guard();
      paused = !guard.ok;
      pausedReason = guard.problems;
      if (paused) {
        deps.log.error(`worker paused: ${guard.problems.join('; ')}`);
        return;
      }
      const job = deps.queue.claimNext();
      if (!job) return;
      try {
        await (job.kind === 'giveback' ? runGiveBack : runMove)(deps, job);
        deps.log.info(`${job.kind} ${job.id} done: ${job.sourceAssetId}`);
      } catch (err) {
        const message = (err as Error).message;
        deps.log.error(`${job.kind} ${job.id} failed: ${message}`);
        deps.queue.fail(job.id, message);
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
      deps.onChange?.();
    });
  };

  return {
    kick,
    state: () => ({ running: running !== null, paused, pausedReason }),
    idle: () => running ?? Promise.resolve(),
  };
}
