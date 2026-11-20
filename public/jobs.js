// Job progress (moves and give backs) in the top bar: "Working on N…" and "N failed", each opening
// a dropdown of those jobs (a row opens it on the queue page; failed ones have Retry), a paused
// worker, and the Storage Template Migration reminder after moves.
import { h } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { api, media } from './api.js';
import { Icon } from './icons.js';
import { kindLabel, stateOf } from './jobstate.js';
import { Popover } from './popover.js';
import { Thumb } from './thumb.js';

const html = htm.bind(h);

// How often the jobs are polled: while some are queued or running, and otherwise.
const POLL_BUSY_MS = 1500;
const POLL_IDLE_MS = 10_000;

/**
 * Polls GET /api/jobs (POLL_BUSY_MS while jobs are queued or running, else POLL_IDLE_MS).
 * Calls onDone(n, moves) when n more jobs finished since the last poll, `moves` of them moves
 * (the rest are give backs).
 */
export function useJobs(onDone) {
  const [summary, setSummary] = useState(null);
  const lastDone = useRef(null);
  const lastMovesDone = useRef(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const timer = useRef(0);

  const poll = useCallback(async () => {
    clearTimeout(timer.current);
    let active = false;
    try {
      const s = await api.jobs({ poll: true });
      setSummary(s);
      active = s.pending + s.running > 0;
      if (lastDone.current !== null && s.done > lastDone.current) {
        onDoneRef.current(s.done - lastDone.current, s.movesDone - lastMovesDone.current);
      }
      lastDone.current = s.done;
      lastMovesDone.current = s.movesDone;
    } catch {
      // Not ready yet (migrations) or offline: try again later.
    }
    timer.current = setTimeout(poll, active ? POLL_BUSY_MS : POLL_IDLE_MS);
  }, []);

  useEffect(() => {
    poll();
    return () => clearTimeout(timer.current);
  }, [poll]);

  return { summary, refresh: poll };
}

const pillBase =
  'inline-flex shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-400';

/** The jobs of 1 queue section, reloaded on every poll (`refreshKey`) while shown. */
function JobRows({ section, refreshKey, readOnly, onOpenJob, onRetry }) {
  const [jobs, setJobs] = useState(null);
  useEffect(() => {
    let stop = false;
    api.jobList({ section }, { poll: true }).then((p) => !stop && setJobs(p.jobs), () => {});
    return () => {
      stop = true;
    };
  }, [section, refreshKey]);
  if (jobs === null) return html`<p class="px-4 py-6 text-center text-sm text-neutral-500">Loading…</p>`;
  if (!jobs.length) return html`<p class="px-4 py-6 text-center text-sm text-neutral-500">Nothing here any more.</p>`;
  return html`<ul class="min-h-0 flex-1 divide-y divide-white/5 overflow-y-auto">
    ${jobs.map((j) => {
      const s = stateOf(j);
      return html`<li key=${j.id} class="flex items-center gap-3 px-3 py-2">
        <button
          class="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-sky-400"
          onClick=${() => onOpenJob(j.id)}
          title="Show in the queue"
        >
          <${Thumb} class="size-11 shrink-0 rounded-md" src=${media.thumbnail(j.thumbAssetId)} loading="lazy" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm">${j.fileName ?? j.thumbAssetId}</span>
            <span class=${`block text-xs ${section === 'failed' ? 'line-clamp-2 break-words text-rose-300' : 'truncate text-neutral-400'}`}>
              ${section === 'failed' ? j.error : `${kindLabel(j)} • ${s.text}`}
            </span>
          </span>
        </button>
        ${section === 'failed' &&
        html`<button
          class="shrink-0 rounded-full bg-white/10 px-3 py-1 text-xs font-medium outline-none hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-40"
          disabled=${readOnly}
          onClick=${() => onRetry(j.id)}
        >Retry</button>`}
      </li>`;
    })}
  </ul>`;
}

export function JobsIndicator({ summary, readOnly, onRetry, onOpenJob, onOpenQueue }) {
  const [open, setOpen] = useState(null); // 'active' | 'failed' | null
  const activeBtn = useRef(null);
  const failedBtn = useRef(null);
  const close = useCallback(() => setOpen(null), []);
  const active = summary ? summary.pending + summary.running : 0;
  const failed = summary ? summary.failed.length : 0;
  const paused = summary?.worker.paused ?? false;
  // Its pill gone (nothing left in progress / failed): close the dropdown too.
  useEffect(() => {
    if ((open === 'active' && !active && !paused) || (open === 'failed' && !failed)) setOpen(null);
  }, [open, active, failed, paused]);
  if (!summary || (!active && !failed && !paused)) return null;

  const toggle = (which) => setOpen((o) => (o === which ? null : which));
  const go = (fn) => (...args) => {
    setOpen(null);
    fn(...args);
  };
  const detail = [
    summary.processingThumbnails > 0 && `${summary.processingThumbnails} processing thumbnails`,
    summary.retrying > 0 && `${summary.retrying} retrying`,
  ].filter(Boolean);
  const header = (title) => html`<div class="flex items-center gap-2 border-b border-white/5 py-2 pl-4 pr-2">
    <span class="flex-1 text-sm font-semibold">${title}</span>
    <button class="rounded-full px-3 py-1 text-xs text-sky-300 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-sky-400" onClick=${go(onOpenQueue)}>Open queue</button>
    <button class="grid size-8 place-items-center rounded-full text-neutral-400 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-sky-400" onClick=${close} aria-label="Close"><${Icon} name="close" class="size-4" /></button>
  </div>`;

  return html`
    <div class="relative flex items-center gap-2">
      ${(active > 0 || paused) &&
      html`<button
        ref=${activeBtn}
        class=${`${pillBase} ${paused ? 'bg-amber-500/15 text-amber-200 hover:bg-amber-500/25' : 'bg-sky-500/15 text-sky-200 hover:bg-sky-500/25'}`}
        title=${paused ? summary.worker.pausedReason.join(' • ') : detail.join(' • ')}
        aria-haspopup="dialog"
        aria-expanded=${open === 'active'}
        onClick=${() => toggle('active')}
      >
        ${paused
          ? html`<${Icon} name="alert" class="size-3.5" /><span>Paused<span class="hidden @md:inline"> • ${active} waiting</span></span>`
          : html`<span class="size-3 animate-spin rounded-full border-2 border-sky-300/30 border-t-sky-300" />
              <span><span class="hidden @md:inline">Working on </span>${active}<span class="hidden @4xl:inline">${detail.length ? ` • ${detail.join(' • ')}` : ''}</span></span>`}
        <${Icon} name="chevronDown" class="size-3.5 opacity-70" />
      </button>`}
      ${failed > 0 &&
      html`<button
        ref=${failedBtn}
        class=${`${pillBase} bg-rose-500/15 text-rose-200 hover:bg-rose-500/25`}
        aria-haspopup="dialog"
        aria-expanded=${open === 'failed'}
        onClick=${() => toggle('failed')}
      >
        <${Icon} name="alert" class="size-3.5" />${failed}<span class="hidden @md:inline"> failed</span>
        <${Icon} name="chevronDown" class="size-3.5 opacity-70" />
      </button>`}
      <${Popover} open=${open === 'active'} onClose=${close} anchor=${activeBtn} label="Jobs in progress" class="sm:right-0 sm:w-[26rem]">
        ${header(paused ? `Paused • ${active} waiting` : `In progress • ${active}`)}
        ${paused && html`<p class="border-b border-white/5 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">${summary.worker.pausedReason.join(' • ')}</p>`}
        <${JobRows} section="active" refreshKey=${summary} readOnly=${readOnly} onOpenJob=${go(onOpenJob)} onRetry=${onRetry} />
      </${Popover}>
      <${Popover} open=${open === 'failed'} onClose=${close} anchor=${failedBtn} label="Failed jobs" class="sm:right-0 sm:w-[26rem]">
        ${header(`Failed • ${failed}`)}
        <${JobRows} section="failed" refreshKey=${summary} readOnly=${readOnly} onOpenJob=${go(onOpenJob)} onRetry=${onRetry} />
      </${Popover}>
    </div>`;
}

/** Shown after moves complete: Immich files family copies into albums only via this job. */
export function StorageTemplateReminder({ count, onDismiss }) {
  if (!count) return null;
  return html`<div class="flex items-start gap-2 border-b border-sky-500/20 bg-sky-500/10 px-4 py-2.5 text-sm text-sky-100" role="status">
    <span class="flex-1">
      <strong class="font-semibold">${count} moved to the family account.</strong>${' '}
      When you're done moving, run <em>Administration → Jobs → Storage Template Migration</em> in Immich
      so the family copies are filed into their folders.
    </span>
    <button class="grid size-6 place-items-center rounded-full hover:bg-white/10" onClick=${onDismiss} aria-label="Dismiss"><${Icon} name="close" class="size-4" /></button>
  </div>`;
}
