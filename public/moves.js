// Queue progress (Moves and Give backs) in the top bar: "Working on N…", failures with Retry, a paused worker, and the
// Storage Template Migration reminder after moves.
import { h } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';
import { Icon } from './icons.js';

const html = htm.bind(h);

/**
 * Polls GET /api/moves: every 1.5 s while moves are queued or running, else every 10 s.
 * Calls onMoved(n, moves) when n more queue rows finished since the last poll, `moves` of them
 * Moves (the rest are Give backs).
 */
export function useMoves(onMoved) {
  const [summary, setSummary] = useState(null);
  const lastDone = useRef(null);
  const lastMovesDone = useRef(null);
  const onMovedRef = useRef(onMoved);
  onMovedRef.current = onMoved;
  const timer = useRef(0);

  const poll = useCallback(async () => {
    clearTimeout(timer.current);
    let active = false;
    try {
      const s = await api.moves();
      setSummary(s);
      active = s.pending + s.running > 0;
      if (lastDone.current !== null && s.done > lastDone.current) {
        onMovedRef.current(s.done - lastDone.current, s.movesDone - lastMovesDone.current);
      }
      lastDone.current = s.done;
      lastMovesDone.current = s.movesDone;
    } catch {
      // Not ready yet (migrations) or offline: try again later.
    }
    timer.current = setTimeout(poll, active ? 1500 : 10_000);
  }, []);

  useEffect(() => {
    poll();
    return () => clearTimeout(timer.current);
  }, [poll]);

  return { summary, refresh: poll };
}

const pillBase = 'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium';

export function MovesIndicator({ summary, onRetry }) {
  const [open, setOpen] = useState(false);
  if (!summary) return null;
  const active = summary.pending + summary.running;
  const failed = summary.failed.length;
  const paused = summary.worker.paused;
  if (!active && !failed && !paused) return null;

  return html`
    <div class="relative flex items-center gap-2">
      ${active > 0 &&
      html`<span class=${`${pillBase} ${paused ? 'bg-amber-500/15 text-amber-200' : 'bg-sky-500/15 text-sky-200'}`} title=${paused ? summary.worker.pausedReason.join(' · ') : ''}>
        ${paused
          ? html`<${Icon} name="alert" class="size-3.5" />Paused · ${active} waiting`
          : html`<span class="size-3 animate-spin rounded-full border-2 border-sky-300/30 border-t-sky-300" />Working on ${active}…`}
      </span>`}
      ${failed > 0 &&
      html`<button class=${`${pillBase} bg-rose-500/15 text-rose-200 hover:bg-rose-500/25`} onClick=${() => setOpen(!open)} aria-expanded=${open}>
        <${Icon} name="alert" class="size-3.5" />${failed} failed
      </button>`}
      ${open &&
      failed > 0 &&
      html`<div class="absolute right-0 top-full z-40 mt-2 w-[28rem] max-w-[90vw] overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 shadow-2xl">
        <div class="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
          <span class="text-sm font-semibold">Failed</span>
          <button class="grid size-7 place-items-center rounded-full text-neutral-400 hover:bg-white/10" onClick=${() => setOpen(false)} aria-label="Close"><${Icon} name="close" class="size-4" /></button>
        </div>
        <ul class="max-h-80 divide-y divide-white/5 overflow-y-auto">
          ${summary.failed.map(
            (f) => html`<li key=${f.id} class="flex items-start gap-3 px-4 py-3">
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium">${f.fileName ?? f.sourceAssetId}</div>
                <div class="mt-0.5 break-words text-xs text-rose-300/90">${f.error}</div>
                <div class="mt-0.5 text-[11px] text-neutral-500">
                  ${f.kind === 'giveback' ? 'Give back' : 'Move'} · stopped after step “${f.step}”
                </div>
              </div>
              <button
                class="shrink-0 rounded-full bg-white/10 px-3 py-1 text-xs font-medium hover:bg-white/20 disabled:opacity-40"
                disabled=${paused}
                onClick=${() => onRetry(f.id)}
              >Retry</button>
            </li>`,
          )}
        </ul>
      </div>`}
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
