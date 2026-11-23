// How a job (move or give back) is described on the page: its state in a few words, its steps and
// its history lines. Shared by the top bar's dropdowns and the queue page.

export const time = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** "just now", "5 min ago", "3 h ago", else the date. */
export function ago(iso, now = Date.now()) {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export const kindLabel = (job) => (job.kind === 'giveback' ? 'Give back' : 'Move');

// The steps a job goes through, in order, with their label once done.
export const STEPS = {
  move: [
    ['queued', 'Queued'],
    ['copied', 'Copied'],
    ['archived', 'Archived'],
    ['linked', 'Linked'],
    ['thumbnailed', 'Thumbnails'],
  ],
  giveback: [
    ['queued', 'Queued'],
    ['restored', 'Restored'],
    ['deleted', 'Deleted'],
  ],
};

// What a job does after its last completed step.
const NEXT = {
  move: { queued: 'copying', copied: 'archiving the original', archived: 'hard-linking', linked: 'processing thumbnails' },
  giveback: { queued: 'restoring the originals', restored: 'deleting the family copy' },
};

// tone: ok | busy | warn | bad | idle (colours in TONE).
export const TONE = {
  ok: 'bg-emerald-500/15 text-emerald-200',
  busy: 'bg-sky-500/15 text-sky-200',
  warn: 'bg-amber-500/15 text-amber-200',
  bad: 'bg-rose-500/15 text-rose-200',
  idle: 'bg-white/10 text-neutral-300',
};

/** The job's state in a few words, and its tone. */
export function stateOf(job) {
  if (job.status === 'failed') return { text: 'Failed', tone: 'bad' };
  if (job.status === 'done') return { text: job.failures ? `Done • ${job.failures}× failed` : 'Done', tone: job.failures ? 'warn' : 'ok' };
  if (job.retryAt) return { text: `Retrying at ${clock(job.retryAt)}`, tone: 'warn' };
  if (job.status === 'running') return { text: NEXT[job.kind][job.step] ?? job.step, tone: 'busy' };
  if (job.waitingSince) return { text: 'Processing thumbnails', tone: 'busy' };
  return { text: job.step === 'queued' ? 'Queued' : `Queued • ${NEXT[job.kind][job.step] ?? job.step}`, tone: 'idle' };
}

/** A tile's name for screen readers and the hover title. */
export const tileLabel = (job) => `${kindLabel(job)} ${job.fileName ?? ''}: ${stateOf(job).text}`;

// A completed step, in the history.
const DONE_STEP = {
  copied: 'Copied to the family account',
  archived: 'Original archived',
  linked: 'Hard-linked to the family copy',
  thumbnailed: 'Family copy has its thumbnails',
  restored: 'Originals back on the timeline',
  deleted: 'Family copy deleted',
};

// The copy step when nothing was uploaded (the event's outcome).
const NOT_COPIED = {
  existing: 'Already in the family account, no copy made',
  unknown: 'In the family account: copied on an earlier try, or already there',
};

/** A history line: its text and kind (for its icon and colour). */
export function eventOf(e) {
  switch (e.type) {
    case 'queued':
      return { text: 'Queued', kind: 'neutral' };
    case 'step':
      return { text: NOT_COPIED[e.outcome] ?? DONE_STEP[e.step] ?? e.step, kind: 'step' };
    case 'done':
      return { text: DONE_STEP[e.step] ?? e.step, kind: 'done' };
    case 'waiting':
      return { text: 'Waiting for Immich to make the thumbnails', kind: 'wait' };
    case 'retrying':
      return { text: 'Failed, trying again on its own', kind: 'warn' };
    case 'failed':
      return { text: 'Failed, waits for Retry', kind: 'bad' };
    case 'retried':
      return { text: 'Retry', kind: 'person' };
    case 'resumed':
      return { text: 'Resumed after a restart', kind: 'neutral' };
    default:
      return { text: e.type, kind: 'neutral' };
  }
}
