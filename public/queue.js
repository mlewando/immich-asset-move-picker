// The queue page (/queue[?job=<id>]): every job with its photo and state, in 3 collapsible
// sections (failed, in progress, done), and per job a side panel with its steps and history: each
// step, wait, failure and retry.
import { h } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { api, media } from './api.js';
import { Icon } from './icons.js';
import { expiry } from './expiry.js';
import { ago, eventOf, kindLabel, STEPS, stateOf, time, TONE } from './jobstate.js';
import { useLostFocus, useRovingFocus } from './roving.js';
import { Thumb } from './thumb.js';

const html = htm.bind(h);

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-sky-400';
const PANEL_MS = 120; // the side panel's slide out (animate-panel-out in styles/app.css)
const WIDE = '(min-width: 64rem)'; // Tailwind's lg: from here the panel sits beside the page

/**
 * 1 section, loaded page by page. Reloads every page shown so far whenever `refreshKey` changes
 * (the jobs poll), so "Load more" isn't undone by the next poll.
 */
function useSection(section, onlyFailures, refreshKey) {
  const [pages, setPages] = useState(1);
  const [data, setData] = useState({ jobs: null, next: null });
  useEffect(() => setPages(1), [onlyFailures]);
  useEffect(() => {
    let stop = false;
    (async () => {
      const jobs = [];
      let after;
      let next = null;
      for (let i = 0; i < pages; i++) {
        const page = await api.jobList({ section, after, onlyFailures }, { poll: true });
        jobs.push(...page.jobs);
        next = page.next;
        if (next === null) break;
        after = next;
      }
      if (!stop) setData({ jobs, next });
    })().catch(() => {});
    return () => {
      stop = true;
    };
  }, [section, onlyFailures, pages, refreshKey]);
  return { ...data, more: () => setPages((p) => p + 1) };
}

const Chip = ({ tone, children, class: cls = '' }) =>
  html`<span class=${`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[tone]} ${cls}`}>${children}</span>`;

const GiveBackMark = () =>
  html`<span class="absolute left-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/60 text-white backdrop-blur-sm" title="Give back">
    <${Icon} name="giveBack" class="size-3.5" />
  </span>`;

/**
 * A photo tile. Its section already says failed / in progress / done, so a tile only adds what
 * differs: the step in progress, or that a done job failed on the way.
 */
function Tile({ job, active, isTabStop, onOpen, showState }) {
  const s = job.status === 'done' ? { text: `${job.failures}× failed`, tone: 'warn' } : stateOf(job);
  const label = `${kindLabel(job)} ${job.fileName ?? ''}: ${s.text}`;
  return html`<button
    data-job=${job.id}
    data-nav=${String(job.id)}
    tabindex=${isTabStop ? 0 : -1}
    class="photo-ring group relative aspect-square scroll-mt-14 overflow-hidden bg-neutral-800"
    aria-current=${active ? 'true' : undefined}
    onClick=${() => onOpen(job.id)}
    aria-label=${label}
    title=${label}
  >
    <${Thumb} class="size-full transition-transform duration-200 group-hover:scale-105" src=${media.thumbnail(job.thumbAssetId)} loading="lazy" />
    ${job.kind === 'giveback' && html`<${GiveBackMark} />`}
    ${showState(job) &&
    html`<span class="absolute inset-x-1.5 bottom-1.5 flex">
      <span class=${`max-w-full truncate rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-medium backdrop-blur-sm ${s.tone === 'warn' ? 'text-amber-200' : s.tone === 'busy' ? 'text-sky-200' : 'text-neutral-200'}`}>${s.text}</span>
    </span>`}
  </button>`;
}

const noHeads = () => false;

/** A section's job tiles: 1 Tab stop, arrows move, Enter or Space opens the job (public/roving.js). */
function TileGrid({ id, label, jobs, jobId, tileSize, onOpen, showState }) {
  const wrap = useRef(null);
  const items = useMemo(() => jobs.map((job) => ({ id: String(job.id), job })), [jobs]);
  // The section is 1 group (the hook takes days) with no header button.
  const groups = useMemo(() => [{ day: id, entries: items.map((item, index) => ({ item, index })) }], [id, items]);
  const nav = useRovingFocus(wrap, groups, items, noHeads, ({ item }) => onOpen(item.job.id));
  return html`<div
    ref=${wrap}
    role="group"
    aria-label=${label}
    aria-describedby=${`${id}-keys`}
    class="nav-grid grid grid-cols-[repeat(auto-fill,minmax(min(var(--tile),30vw),1fr))] gap-1"
    style=${{ '--tile': `${tileSize}px` }}
    onFocusIn=${nav.onFocusIn}
    onClick=${nav.onClick}
    onKeyDown=${nav.onKeyDown}
    onKeyUp=${nav.onKeyUp}
  >
    <p id=${`${id}-keys`} class="sr-only">Arrow keys move, Enter or Space opens.</p>
    ${jobs.map(
      (j) => html`<${Tile} key=${j.id} job=${j} active=${j.id === jobId} isTabStop=${nav.stop === String(j.id)} onOpen=${onOpen} showState=${showState} />`,
    )}
  </div>`;
}

/** A failed job: its reason matters more than its photo, so a card with both and Retry. */
function FailedCard({ job, active, memberName, readOnly, onOpen, onRetry }) {
  return html`<div
    class=${`flex items-center gap-3 rounded-xl border bg-neutral-900 p-2 pr-3 ${active ? 'border-sky-400' : 'border-white/5 hover:border-white/15'}`}
  >
    <button data-job=${job.id} class=${`flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left ${focusRing}`} aria-current=${active ? 'true' : undefined} onClick=${() => onOpen(job.id)}>
      <span class="relative shrink-0">
        <${Thumb} class="size-16 rounded-lg" src=${media.thumbnail(job.thumbAssetId)} loading="lazy" />
        ${job.kind === 'giveback' && html`<${GiveBackMark} />`}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-medium">${job.fileName ?? job.thumbAssetId}</span>
        <span class="mt-0.5 line-clamp-2 break-words text-xs text-rose-300">${job.error}</span>
        <span class="mt-0.5 block truncate text-[11px] text-neutral-500">
          ${[kindLabel(job), memberName, ago(job.updatedAt)].filter(Boolean).join(' • ')}
        </span>
      </span>
    </button>
    <button
      class=${`shrink-0 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20 disabled:opacity-40 ${focusRing}`}
      disabled=${readOnly}
      onClick=${() => onRetry(job.id)}
    >Retry</button>
  </div>`;
}

function Section({ id, title, count, open, onToggle, extra, data, empty, children }) {
  return html`<section class="border-b border-white/5 py-3 last:border-b-0">
    <div class="flex min-h-10 items-center gap-3">
      <button
        class=${`-ml-2 flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5 ${focusRing}`}
        aria-expanded=${open}
        aria-controls=${`section-${id}`}
        onClick=${onToggle}
      >
        <${Icon} name="chevronDown" class=${`size-5 text-neutral-400 transition-transform ${open ? '' : '-rotate-90'}`} />
        <h2 class="text-base font-semibold">${title}</h2>
        ${count > 0 && html`<span class="rounded-full bg-white/10 px-2 text-xs text-neutral-300">${count}</span>`}
      </button>
      ${open && extra}
    </div>
    <div id=${`section-${id}`} hidden=${!open} class="pt-2">
      ${data.jobs === null
        ? html`<p class="text-sm text-neutral-500">Loading…</p>`
        : data.jobs.length === 0
          ? html`<p class="text-sm text-neutral-500">${empty}</p>`
          : children}
      ${data.next !== null &&
      html`<button class=${`mt-3 rounded-full bg-white/10 px-4 py-1.5 text-sm hover:bg-white/20 ${focusRing}`} onClick=${data.more}>Load more</button>`}
    </div>
  </section>`;
}

/**
 * Full-screen photo; click or Esc closes it. It sits inside the job panel's <dialog>: outside a
 * modal one it would be inert.
 */
function Enlarged({ job, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Only this, not the side panel too (nor, as a modal dialog, its own Esc).
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return html`<div class="fixed inset-0 z-50 flex items-center justify-center bg-black p-4" role="dialog" aria-modal="true" aria-label=${job.fileName ?? 'Photo'} onClick=${onClose}>
    <img class="max-h-full max-w-full object-contain" src=${media.preview(job.thumbAssetId)} alt=${job.fileName ?? ''} onError=${expiry.check} />
    <button class=${`absolute left-3 top-3 grid size-10 place-items-center rounded-full text-white hover:bg-white/15 ${focusRing}`} aria-label="Close" title="Close (Esc)">
      <${Icon} name="close" class="size-6" />
    </button>
  </div>`;
}

/** The job's steps as dots on a line: done, the one it is at (or stopped before), still to do. */
function Steps({ job }) {
  const steps = STEPS[job.kind];
  const at = steps.findIndex(([s]) => s === job.step);
  const done = job.status === 'done';
  const current = done ? -1 : at + 1; // the step being worked on (or that failed)
  const currentTone =
    job.status === 'failed' ? 'bad' : job.retryAt ? 'warn' : job.status === 'running' || job.waitingSince ? 'busy' : 'idle';
  const dot = {
    done: 'bg-emerald-500 text-neutral-950',
    bad: 'bg-rose-500 text-white',
    warn: 'bg-amber-400 text-neutral-950',
    busy: 'bg-sky-500 text-white ring-4 ring-sky-500/25 animate-pulse',
    idle: 'bg-neutral-600 text-white',
    todo: 'bg-neutral-800 text-neutral-500 ring-1 ring-inset ring-white/10',
  };
  return html`<ol class="flex items-start" aria-label="Steps">
    ${steps.map(([key, label], i) => {
      const state = done || i <= at ? 'done' : i === current ? currentTone : 'todo';
      const status = state === 'done' ? 'done' : state === 'todo' ? 'to do' : stateOf(job).text;
      return html`<li key=${key} class="relative flex flex-1 flex-col items-center gap-1.5" aria-label=${`${label}: ${status}`}>
        ${i > 0 &&
        html`<span class=${`absolute right-1/2 top-3 h-0.5 w-full -translate-y-1/2 ${state === 'done' ? 'bg-emerald-500/60' : 'bg-white/10'}`} aria-hidden="true" />`}
        <span class=${`relative grid size-6 place-items-center rounded-full ${dot[state]}`} aria-hidden="true">
          ${state === 'done'
            ? html`<${Icon} name="check" class="size-4" />`
            : state === 'bad'
              ? html`<${Icon} name="close" class="size-4" />`
              : state === 'warn'
                ? html`<${Icon} name="refresh" class="size-3.5" />`
                : html`<span class="text-[10px] font-semibold">${i + 1}</span>`}
        </span>
        <span class=${`text-center text-[11px] leading-tight ${state === 'todo' ? 'text-neutral-500' : 'text-neutral-300'}`}>${label}</span>
      </li>`;
    })}
  </ol>`;
}

const EVENT_ICON = {
  neutral: ['clock', 'bg-white/10 text-neutral-300'],
  step: ['check', 'bg-emerald-500/15 text-emerald-300'],
  done: ['check', 'bg-emerald-500 text-neutral-950'],
  wait: ['clock', 'bg-sky-500/15 text-sky-300'],
  warn: ['refresh', 'bg-amber-500/15 text-amber-300'],
  bad: ['alert', 'bg-rose-500/15 text-rose-300'],
  person: ['account', 'bg-violet-500/15 text-violet-300'],
};

function History({ events }) {
  if (events === null) return html`<p class="text-sm text-neutral-500">Loading…</p>`;
  if (events.length === 0) return html`<p class="text-sm text-neutral-500">No history: queued before the picker kept it.</p>`;
  return html`<ol class="space-y-3">
    ${events.map((e, i) => {
      const ev = eventOf(e);
      const [icon, tone] = EVENT_ICON[ev.kind];
      const bad = ev.kind === 'bad' || ev.kind === 'warn';
      return html`<li key=${i} class="flex gap-3">
        <span class=${`grid size-7 shrink-0 place-items-center rounded-full ${tone}`} aria-hidden="true"><${Icon} name=${icon} class="size-4" /></span>
        <div class="min-w-0 flex-1 pt-0.5">
          <div class="flex flex-wrap items-baseline justify-between gap-x-2">
            <span class="text-sm">${ev.text}</span>
            <time class="text-[11px] text-neutral-500" datetime=${e.at} title=${time(e.at)}>${time(e.at)}</time>
          </div>
          ${e.by && html`<div class="text-xs text-neutral-400">by ${e.by}</div>`}
          ${e.message &&
          html`<div class=${`mt-1 break-words text-xs ${bad ? 'rounded-md bg-black/30 px-2 py-1.5 font-mono text-neutral-300' : 'text-neutral-400'}`}>${e.message}</div>`}
        </div>
      </li>`;
    })}
  </ol>`;
}

/** closing: sliding out (it unmounts after PANEL_MS); the page already takes its room back. */
function Detail({ job, closing, memberName, readOnly, onRetry, toast, onClose }) {
  const [events, setEvents] = useState(null);
  const [enlarged, setEnlarged] = useState(false);
  const heading = useRef(null);
  // Another job in the same (open) panel: start from its own history.
  useEffect(() => {
    setEvents(null);
    setEnlarged(false);
  }, [job.id]);
  // Reloaded whenever the job changes (each change adds to its history).
  useEffect(() => {
    let stop = false;
    api.jobEvents(job.id, { poll: true }).then((ev) => !stop && setEvents(ev), () => {});
    return () => {
      stop = true;
    };
  }, [job.id, job.updatedAt]);
  useEffect(() => heading.current?.focus({ preventScroll: true }), [job.id]);
  // Below lg the panel covers the page: the page behind must not scroll.
  useEffect(() => {
    document.documentElement.classList.add('max-lg:overflow-hidden');
    return () => document.documentElement.classList.remove('max-lg:overflow-hidden');
  }, []);
  // A <dialog>: below lg it covers the page as a modal one (the browser makes the page behind
  // inert and keeps Tab inside); from lg it is a side panel beside the page, not modal. Resizing
  // across lg reopens it the other way.
  const dialog = useRef(null);
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = matchMedia(WIDE);
    const update = () => setWide(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const d = dialog.current;
    if (d.open) d.close();
    if (wide) d.show();
    else d.showModal();
    heading.current?.focus({ preventScroll: true });
  }, [wide]);
  // Gone (after sliding out): the focus goes back to the job's tile, for keyboard users. Leaving
  // the page already took the dialog out (and with it the page's inertness): no close() here.
  const jobId = useRef(job.id);
  jobId.current = job.id;
  useEffect(() => () => document.querySelector(`[data-job="${jobId.current}"]`)?.focus({ preventScroll: true }), []);
  // Esc closes through onClose (it slides out and updates the URL), not the dialog's own Esc.
  useEffect(() => {
    if (closing) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose, closing]);

  const s = stateOf(job);
  const fact = (label, value) =>
    value && html`<div class="min-w-0"><dt class="text-[11px] uppercase tracking-wider text-neutral-500">${label}</dt><dd class="truncate text-sm" title=${value}>${value}</dd></div>`;
  return html`
    <dialog
      ref=${dialog}
      data-panel=${closing ? undefined : ''}
      class=${`fixed inset-0 z-40 m-0 size-full max-h-none max-w-none flex-col border-0 bg-neutral-900 p-0 text-neutral-100 shadow-2xl backdrop:bg-transparent open:flex lg:left-auto lg:right-0 lg:z-30 lg:w-[28rem] lg:border-l lg:border-white/5 ${closing ? 'motion-safe:animate-panel-out' : 'motion-safe:animate-panel-in'}`}
      aria-labelledby="job-detail-title"
      inert=${closing}
      onCancel=${(e) => {
        // A close request (Esc, Android's Back): close the app's way, so the URL and page follow.
        e.preventDefault();
        if (!closing) onClose();
      }}
      onClose=${(e) => {
        // Closed by the browser anyway (a 2nd close request can't be refused): the same. Not
        // once it left the page (its listener outlives it): that is no request to close.
        const d = e.currentTarget;
        if (d.isConnected && !d.open && !closing) onClose();
      }}
    >
      <div class="flex h-14 shrink-0 items-center gap-2 border-b border-white/5 pl-5 pr-2">
        <h2 id="job-detail-title" ref=${heading} tabindex="-1" class="min-w-0 flex-1 truncate text-[15px] font-semibold outline-none">
          ${kindLabel(job)} • ${job.fileName ?? job.thumbAssetId}
        </h2>
        <button class=${`grid size-9 place-items-center rounded-full text-neutral-300 hover:bg-white/10 ${focusRing}`} onClick=${onClose} aria-label="Close" title="Close (Esc)">
          <${Icon} name="close" class="size-5" />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <button class="photo-ring group relative block aspect-[4/3] w-full bg-black" onClick=${() => setEnlarged(true)} aria-label="Show the photo full screen">
          <${Thumb} class="size-full bg-black!" fit="object-contain" src=${media.preview(job.thumbAssetId)} alt=${job.fileName ?? ''} />
          <span class="absolute bottom-3 right-3 grid size-9 place-items-center rounded-full bg-black/60 text-white opacity-80 backdrop-blur-sm transition-opacity group-hover:opacity-100">
            <${Icon} name="expand" class="size-4" />
          </span>
        </button>
        <div class="space-y-5 px-5 py-4">
          <div class="flex items-center gap-2">
            <${Chip} tone=${s.tone}>${s.text}</${Chip}>
            <span class="text-xs text-neutral-500" title=${time(job.updatedAt)}>${ago(job.updatedAt)}</span>
          </div>
          ${job.error && job.status !== 'done' &&
          html`<p class=${`break-words rounded-lg px-3 py-2 text-sm ${job.status === 'failed' ? 'bg-rose-500/10 text-rose-200' : 'bg-amber-500/10 text-amber-200'}`}>${job.error}</p>`}
          <${Steps} job=${job} />
          <dl class="grid grid-cols-2 gap-x-4 gap-y-3">
            ${fact('Member', memberName)}
            ${fact('Requested by', job.requestedBy)}
            ${fact('Queued', time(job.createdAt))}
            ${fact('Job', `#${job.id}`)}
          </dl>
          <div>
            <h3 class="pb-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">History</h3>
            <${History} events=${events} />
          </div>
        </div>
      </div>
      ${job.status === 'failed' &&
      html`<div class="shrink-0 border-t border-white/5 p-4">
        <button
          class=${`flex w-full items-center justify-center gap-2 rounded-full bg-sky-500 py-2 text-sm font-semibold text-white hover:bg-sky-400 disabled:opacity-40 ${focusRing}`}
          disabled=${readOnly}
          title=${readOnly ? 'Read-only: the upgrade guard failed' : 'Run it again from the step it stopped at'}
          onClick=${() => onRetry(job.id)}
        ><${Icon} name="refresh" class="size-4" />Retry</button>
      </div>`}
      ${enlarged && html`<${Enlarged} job=${job} onClose=${() => setEnlarged(false)} />`}
      ${!wide && toast}
    </dialog>`;
}

/** jobId: the job shown in the side panel (from the URL); onSelectJob(id | null) changes it. */
export function QueuePage({ summary, members, tileSize, readOnly, onRetry, toast, jobId, onSelectJob }) {
  const [onlyFailures, setOnlyFailures] = useState(false);
  // Done is the long one, and rarely what you come for: closed until asked.
  const [open, setOpen] = useState({ failed: true, active: true, done: false });
  const toggle = (k) => () => setOpen((o) => ({ ...o, [k]: !o[k] }));
  // Every poll of the jobs summary reloads the sections.
  const failed = useSection('failed', false, summary);
  const active = useSection('active', false, summary);
  const done = useSection('done', onlyFailures, summary);

  // The open job: its latest state from the sections, or the last one seen.
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    if (jobId === null) return;
    const found = [failed.jobs, active.jobs, done.jobs].flatMap((l) => l ?? []).find((j) => j.id === jobId);
    if (found) setSelected(found);
  }, [jobId, failed.jobs, active.jobs, done.jobs]);
  // Closed: the panel slides out, then goes.
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (jobId !== null) {
      setClosing(false);
      // The grid narrowed for the panel: keep the job's tile in sight.
      requestAnimationFrame(() => document.querySelector(`[data-job="${jobId}"]`)?.scrollIntoView({ block: 'nearest' }));
      return;
    }
    setClosing(true);
    const t = setTimeout(() => {
      setSelected(null);
      setClosing(false);
    }, PANEL_MS);
    return () => clearTimeout(t);
  }, [jobId]);
  const close = useCallback(() => onSelectJob(null), [onSelectJob]);
  // A section's last job left while its tile had the focus (e.g. in progress -> done: "Nothing
  // queued." replaces the tiles): the focus goes to the section's own button.
  const onFocusIn = useLostFocus(({ section }) => section?.querySelector('button[aria-controls]')?.focus());

  const memberName = (id) => members.find((m) => m.id === id)?.name ?? null;
  const tiles = (id, label, jobs, showState) =>
    html`<${TileGrid} id=${id} label=${label} jobs=${jobs} jobId=${jobId} tileSize=${tileSize} onOpen=${onSelectJob} showState=${showState} />`;

  // Nothing ever queued (or all of it pruned): 1 message rather than 3 empty sections.
  if (summary && !summary.failed.length && !summary.pending && !summary.running && !summary.done) {
    return html`<div class="flex flex-col items-center gap-2 py-20 text-center">
      <span class="grid size-14 place-items-center rounded-full bg-white/5 text-neutral-500"><${Icon} name="queue" class="size-7" /></span>
      <p class="text-base font-medium text-neutral-300">The queue is empty</p>
      <p class="max-w-sm text-sm text-neutral-500">Select photos on a member’s timeline and Move them to the family account: each move shows up here, with its steps and history.</p>
    </div>`;
  }

  return html`
    <div class="pb-8" onFocusIn=${onFocusIn}>
      <${Section} id="failed" title="Failed" count=${summary?.failed.length} open=${open.failed} onToggle=${toggle('failed')} data=${failed} empty="Nothing failed.">
        <div class="grid grid-cols-[repeat(auto-fill,minmax(min(24rem,100%),1fr))] gap-2">
          ${failed.jobs?.map(
            (j) => html`<${FailedCard} key=${j.id} job=${j} active=${j.id === jobId} memberName=${memberName(j.memberId)} readOnly=${readOnly} onOpen=${onSelectJob} onRetry=${onRetry} />`,
          )}
        </div>
      </${Section}>
      <${Section}
        id="active"
        title="In progress"
        count=${summary ? summary.pending + summary.running : 0}
        open=${open.active}
        onToggle=${toggle('active')}
        data=${active}
        empty="Nothing queued."
      >${active.jobs && tiles('active-jobs', 'Jobs in progress', active.jobs, () => true)}</${Section}>
      <${Section}
        id="done"
        title="Done"
        count=${summary?.done}
        open=${open.done}
        onToggle=${toggle('done')}
        data=${done}
        empty=${onlyFailures ? 'No done job had a failure.' : 'Nothing done yet.'}
        extra=${html`<label class="ml-auto flex items-center gap-2 text-sm text-neutral-400">
          <input type="checkbox" class="size-4 accent-sky-500" checked=${onlyFailures} onChange=${(e) => setOnlyFailures(e.currentTarget.checked)} />
          Only with failures
        </label>`}
      >${done.jobs && tiles('done-jobs', 'Done jobs', done.jobs, (j) => j.failures > 0)}</${Section}>
    </div>
    ${selected &&
    html`<${Detail} job=${selected} closing=${closing} memberName=${memberName(selected.memberId)} readOnly=${readOnly} onRetry=${onRetry} toast=${toast} onClose=${close} />`}`;
}
