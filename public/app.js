// The picker page: member sidebar, timeline grid grouped by day, full-screen viewer, selection,
// Move to family / Give back. Preact + htm, loaded as browser modules (no JS build).
import { h, render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';
import { FilterBar } from './filters.js';
import { Grid } from './grid.js';
import { Icon } from './icons.js';
import { keepAlive } from './expiry.js';
import { CheckAgain, JobsIndicator, StorageTemplateReminder, useJobs } from './jobs.js';
import { QueuePage } from './queue.js';
import { addRange, toggleDay, toggleOne } from './selection.js';
import { startMember } from './start.js';
import { Viewer } from './viewer.js';

const html = htm.bind(h);

// --- routing: /members/<id>[?album=&from=&to=] | /family, viewer as &asset=<id> | /queue[?job=] -
// Opening the viewer pushes a history entry, so the browser's Back button closes it.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function parseLocation() {
  const q = new URLSearchParams(location.search);
  const asset = q.get('asset');
  const m = /^\/members\/([0-9a-f-]{36})$/.exec(location.pathname);
  if (m) {
    const day = (k) => (DAY.test(q.get(k) ?? '') ? q.get(k) : '');
    const filter = { album: /^[0-9a-f-]{36}$/.test(q.get('album') ?? '') ? q.get('album') : '', from: day('from'), to: day('to') };
    return { kind: 'member', id: m[1], filter, asset };
  }
  if (location.pathname === '/family') return { kind: 'family', asset };
  if (location.pathname === '/queue') {
    const job = Number(q.get('job'));
    return { kind: 'queue', asset: null, job: Number.isInteger(job) && job > 0 ? job : null };
  }
  return { kind: 'none', asset: null };
}
// The grid's URL (with its filter), optionally with the viewer open on 1 asset.
function gridPath(route, asset = null) {
  const path = route.kind === 'family' ? '/family' : `/members/${route.id}`;
  const q = new URLSearchParams(Object.entries(route.filter ?? {}).filter(([, v]) => v));
  if (asset) q.set('asset', asset);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

function navigate(url, { replace = false, state = null } = {}) {
  history[replace ? 'replaceState' : 'pushState'](state, '', url);
  dispatchEvent(new Event('picker:navigate'));
}

function useRoute() {
  const [route, setRoute] = useState(parseLocation);
  useEffect(() => {
    const update = () => setRoute(parseLocation());
    addEventListener('popstate', update);
    addEventListener('picker:navigate', update);
    return () => {
      removeEventListener('popstate', update);
      removeEventListener('picker:navigate', update);
    };
  }, []);
  return route;
}

// --- thumbnail size (zoom), remembered per browser -------------------------------------------
const ZOOM = { min: 96, max: 320, step: 32, default: 160, key: 'picker.tileSize' };
function useTileSize() {
  const [size, setSize] = useState(() => {
    try {
      const v = Number(localStorage.getItem(ZOOM.key));
      return v >= ZOOM.min && v <= ZOOM.max ? v : ZOOM.default;
    } catch {
      return ZOOM.default;
    }
  });
  const set = useCallback((v) => {
    const next = Math.min(ZOOM.max, Math.max(ZOOM.min, v));
    setSize(next);
    try {
      localStorage.setItem(ZOOM.key, String(next));
    } catch {
      /* private mode: just don't remember */
    }
  }, []);
  return [size, set];
}

// --- sidebar: full, collapsed to icons (remembered), or a drawer on a phone --------------------
const AVATAR_COLORS = ['bg-sky-600', 'bg-violet-600', 'bg-rose-600', 'bg-amber-600', 'bg-emerald-600', 'bg-fuchsia-600'];
const avatarColor = (id) => AVATAR_COLORS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-sky-400';

function useCollapsed() {
  const key = 'picker.sidebarCollapsed';
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(key, c ? '0' : '1');
      } catch {
        /* private mode: just don't remember */
      }
      return !c;
    });
  }, []);
  return [collapsed, toggle];
}

// Every row keeps its icon at the same place (px-3 in a 4.5rem rail centres a size-8 icon) and
// its label on 1 line: collapsing only narrows the column, which clips the labels, so nothing
// jumps or wraps while it animates.
const row = 'flex items-center gap-3 rounded-xl px-3 py-2 text-sm';

function NavItem({ href, active, label, collapsed, onNavigate, children }) {
  return html`<a
    href=${href}
    class=${`${row} transition-colors ${focusRing} ${active ? 'bg-sky-500/15 text-sky-200' : 'text-neutral-300 hover:bg-white/5'}`}
    aria-current=${active ? 'page' : undefined}
    aria-label=${collapsed ? label : undefined}
    title=${collapsed ? label : undefined}
    onClick=${(e) => {
      e.preventDefault();
      if (!active) navigate(href);
      onNavigate?.();
    }}
  >${children}</a>`;
}

// Who is logged in, and the way out. Without the login (local dev) there is no user: nothing shown.
function Account({ user, collapsed }) {
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const signOut = async () => {
    setBusy(true);
    try {
      const { next } = await api.signOut();
      location.assign(next);
    } catch {
      setBusy(false);
    }
  };
  const signOutBtn = (cls) => html`<button
    class=${`grid size-8 shrink-0 place-items-center rounded-full text-neutral-300 hover:bg-white/10 disabled:opacity-40 ${focusRing} ${cls}`}
    onClick=${signOut}
    disabled=${busy}
    aria-label=${`Sign out ${user}`}
    title=${`Sign out ${user}`}
  ><${Icon} name="logout" class="size-4" /></button>`;
  // Collapsed: the rail has room for 1 icon, so it is the way out.
  if (collapsed) return html`<div class=${`${row} py-1`}>${signOutBtn('')}</div>`;
  return html`<div class=${`${row} py-1`}>
    <span class="grid size-8 shrink-0 place-items-center rounded-full bg-neutral-700 text-sm font-semibold text-neutral-200" aria-hidden="true">${user.slice(0, 1).toUpperCase()}</span>
    <span class="min-w-0 flex-1 truncate text-xs text-neutral-400" title=${user}>${user}</span>
    ${signOutBtn('-mr-1.5')}
  </div>`;
}

function SidebarBody({ members, route, user, jobs, collapsed, onNavigate, onToggle }) {
  const active = jobs ? jobs.pending + jobs.running : 0;
  const failed = jobs ? jobs.failed.length : 0;
  const label = (text) =>
    html`<div class=${`flex h-9 items-end px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 transition-opacity ${collapsed ? 'opacity-0' : ''}`} aria-hidden=${collapsed}>${text}</div>`;
  const count = (n, tone, title) =>
    n > 0 &&
    html`<span class=${`shrink-0 rounded-full px-2 text-xs ${tone === 'bad' ? 'bg-rose-500/20 text-rose-200' : 'bg-sky-500/20 text-sky-200'}`} title=${title}>${n}</span>`;
  return html`
    <nav class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" aria-label="Members and pages">
      ${label('Members')}
      <div class="space-y-0.5">
        ${members.map(
          (m) => html`<${NavItem} href=${`/members/${m.id}`} active=${route.kind === 'member' && route.id === m.id} label=${m.name} collapsed=${collapsed} onNavigate=${onNavigate}>
            <span class=${`grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold text-white ${avatarColor(m.id)}`}>
              ${(m.name || m.email).slice(0, 1).toUpperCase()}
            </span>
            <span class="min-w-0">
              <span class="block truncate font-medium">${m.name}</span>
              <span class="block truncate text-xs text-neutral-500">${m.email}</span>
            </span>
          </${NavItem}>`,
        )}
      </div>
      ${label('Shared')}
      <div class="space-y-0.5">
        <${NavItem} href="/family" active=${route.kind === 'family'} label="Family account" collapsed=${collapsed} onNavigate=${onNavigate}>
          <span class="grid size-8 shrink-0 place-items-center rounded-full bg-neutral-700 text-neutral-200"><${Icon} name="family" class="size-4" /></span>
          <span class="min-w-0 truncate font-medium">Family account</span>
        </${NavItem}>
        <${NavItem} href="/queue" active=${route.kind === 'queue'} label="Queue" collapsed=${collapsed} onNavigate=${onNavigate}>
          <span class="relative grid size-8 shrink-0 place-items-center rounded-full bg-neutral-700 text-neutral-200">
            <${Icon} name="queue" class="size-4" />
            ${collapsed && failed > 0 && html`<span class="absolute right-0 top-0 size-2.5 rounded-full bg-rose-400 ring-2 ring-neutral-950" title=${`${failed} failed`} />`}
          </span>
          <span class="min-w-0 flex-1 truncate font-medium">Queue</span>
          ${count(failed, 'bad', 'Failed')}
          ${count(active, 'busy', 'In progress')}
        </${NavItem}>
      </div>
    </nav>
    <div class="space-y-1 border-t border-white/5 pt-2">
      ${onToggle &&
      html`<button
        class=${`${row} w-full text-neutral-400 hover:bg-white/5 hover:text-neutral-200 ${focusRing}`}
        onClick=${onToggle}
        aria-label=${collapsed ? 'Expand the menu' : 'Collapse the menu'}
        title=${collapsed ? 'Expand the menu' : 'Collapse the menu'}
      >
        <span class="grid size-8 shrink-0 place-items-center"><${Icon} name="menuOpen" class=${`size-5 transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`} /></span>
        <span class="truncate">Collapse</span>
      </button>`}
      <${Account} user=${user} collapsed=${collapsed} />
    </div>`;
}

const Logo = () => html`<div class="flex h-14 shrink-0 items-center gap-3 px-3">
  <div class="grid size-8 shrink-0 place-items-center rounded-lg bg-sky-500 text-white"><${Icon} name="family" class="size-5" /></div>
  <span class="truncate text-base font-semibold tracking-tight">Family picker</span>
</div>`;

function Sidebar(props) {
  const { collapsed, drawerOpen, onCloseDrawer, onToggle } = props;
  // The drawer (phone): Esc or a tap beside it closes it.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e) => e.key === 'Escape' && onCloseDrawer();
    addEventListener('keydown', onKey);
    document.querySelector('#drawer a, #drawer button')?.focus();
    return () => removeEventListener('keydown', onKey);
  }, [drawerOpen]);
  return html`
    <aside
      class=${`sticky top-0 hidden h-dvh shrink-0 flex-col overflow-hidden whitespace-nowrap border-r border-white/5 bg-neutral-900/60 px-2 pb-2 transition-[width] duration-200 md:flex ${collapsed ? 'w-[4.5rem]' : 'w-64'}`}
    >
      <${Logo} />
      <${SidebarBody} ...${props} collapsed=${collapsed} onToggle=${onToggle} />
    </aside>
    ${drawerOpen &&
    html`<div class="fixed inset-0 z-50 md:hidden">
      <div class="absolute inset-0 bg-black/60 motion-safe:animate-fade-in" onClick=${onCloseDrawer} />
      <aside id="drawer" class="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col whitespace-nowrap bg-neutral-900 px-2 pb-2 shadow-2xl motion-safe:animate-drawer-in" role="dialog" aria-modal="true" aria-label="Menu">
        <div class="flex items-center">
          <div class="min-w-0 flex-1"><${Logo} /></div>
          <button class=${`mr-1 grid size-9 place-items-center rounded-full text-neutral-300 hover:bg-white/10 ${focusRing}`} onClick=${onCloseDrawer} aria-label="Close menu"><${Icon} name="close" /></button>
        </div>
        <${SidebarBody} ...${props} collapsed=${false} onNavigate=${onCloseDrawer} onToggle=${null} />
      </aside>
    </div>`}`;
}

// --- top bar: menu, title + zoom, or the selection actions -----------------------------------
function TopBar({ title, count, selectedCount, action, tileSize, setTileSize, onClear, onMenu, jobs }) {
  const iconBtn = `grid size-9 shrink-0 place-items-center rounded-full text-neutral-300 hover:bg-white/10 disabled:opacity-30 ${focusRing}`;
  const bar = '@container sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-white/5 px-2 sm:gap-3 sm:px-4';
  if (selectedCount > 0) {
    return html`
      <header class=${`${bar} bg-sky-950`}>
        <button class=${iconBtn} onClick=${onClear} aria-label="Clear selection" title="Clear selection"><${Icon} name="close" /></button>
        <span class="flex-1 truncate text-sm font-medium">${selectedCount} selected</span>
        ${jobs}
        <button
          class=${`shrink-0 rounded-full bg-sky-500 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:opacity-40 disabled:hover:bg-sky-500 ${focusRing}`}
          disabled=${action.disabled}
          title=${action.title}
          onClick=${action.run}
        >${action.label}</button>
      </header>`;
  }
  return html`
    <header class=${`${bar} bg-neutral-950`}>
      <button class=${`${iconBtn} md:hidden`} onClick=${onMenu} aria-label="Menu" title="Menu"><${Icon} name="menu" /></button>
      <div class="min-w-16 flex-1 truncate">
        <span class="text-base font-semibold">${title}</span>
        ${count !== null && html`<span class="ml-2 hidden text-sm text-neutral-500 @2xl:inline">${count} items</span>`}
        ${count !== null && html`<span class="hidden text-sm text-neutral-500 @5xl:inline"> • drag to select, Alt+drag to unselect</span>`}
      </div>
      ${jobs}
      <div class="hidden items-center gap-1 @lg:flex" title="Thumbnail size">
        <button class=${iconBtn} onClick=${() => setTileSize(tileSize - ZOOM.step)} disabled=${tileSize <= ZOOM.min} aria-label="Smaller thumbnails"><${Icon} name="zoomOut" /></button>
        <input
          type="range"
          class="hidden w-28 accent-sky-500 @3xl:block"
          min=${ZOOM.min}
          max=${ZOOM.max}
          step="8"
          value=${tileSize}
          aria-label="Thumbnail size"
          onInput=${(e) => setTileSize(Number(e.currentTarget.value))}
        />
        <button class=${iconBtn} onClick=${() => setTileSize(tileSize + ZOOM.step)} disabled=${tileSize >= ZOOM.max} aria-label="Bigger thumbnails"><${Icon} name="zoomIn" /></button>
      </div>
    </header>`;
}

// --- app -----------------------------------------------------------------------------------
const STATUS_POLL_MS = 10_000; // the read-only state (the guard runs at start and before each job)
const TOAST_MS = 6000;

/**
 * The grid's photos and the selection in them. Another grid (member, filter, family) starts
 * empty; reload() refreshes in place and keeps the selection of what is still there.
 */
function useGrid(route) {
  const gridKey = route.kind === 'member' || route.kind === 'family' ? gridPath(route) : '';
  const [items, setItems] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const anchor = useRef(null); // flat index of the last single select (shift-click range start)
  // opts.poll: a reload the jobs poll started is not the user's doing (it must not keep an
  // unused tab's session alive); the user's own actions ping on their own (expiry.js).
  const load = useCallback(
    (opts) => (route.kind === 'family' ? api.familyAssets(opts) : api.memberAssets(route.id, route.filter, opts)),
    [gridKey],
  );

  useEffect(() => {
    setItems(null);
    setError(null);
    setSelected(new Set());
    anchor.current = null;
    if (!gridKey) return; // e.g. the queue page: no grid
    load().then(setItems, (e) => setError(e.message));
  }, [gridKey]);

  const reload = useCallback(() => {
    if (!gridKey) return;
    load({ poll: true }).then((next) => {
      setItems(next);
      const ids = new Set(next.map((i) => i.id));
      setSelected((s) => new Set([...s].filter((id) => ids.has(id))));
    }, () => {});
  }, [gridKey, load]);

  // Takes just-queued items out of the grid at once; the server leaves them out from now on.
  const drop = useCallback((ids) => {
    const gone = new Set(ids);
    setItems((list) => list && list.filter((i) => !gone.has(i.id)));
    setSelected((s) => new Set([...s].filter((id) => !gone.has(id))));
  }, []);

  return { gridKey, items, error, setError, selected, setSelected, anchor, reload, drop };
}

/** A short message at the bottom ({ kind: 'ok' | 'warn' | 'error', text }), gone after TOAST_MS. */
function useToast() {
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);
  return [toast, setToast];
}

const LAST_MEMBER_KEY = 'picker.lastMember';

function App() {
  const route = useRoute();
  const [status, setStatus] = useState(null);
  const [members, setMembers] = useState([]);
  const [tileSize, setTileSize] = useTileSize();
  const { gridKey, items, error, setError, selected, setSelected, anchor, reload, drop } = useGrid(route);
  const [toast, setToast] = useToast();

  const loadStatus = useCallback(() => api.status({ poll: true }).then(setStatus, () => {}), []);
  useEffect(() => {
    api.members().then(setMembers, (e) => setError(e.message));
    loadStatus();
    const t = setInterval(loadStatus, STATUS_POLL_MS);
    return () => clearInterval(t);
  }, []);

  // No grid chosen yet (/) → the member last viewed in this browser, else the 1st with photos,
  // without leaving "/" in the history.
  useEffect(() => {
    if (route.kind !== 'none') return;
    let lastViewed = null;
    try {
      lastViewed = localStorage.getItem(LAST_MEMBER_KEY);
    } catch {
      /* private mode: nothing remembered */
    }
    const start = startMember(members, lastViewed);
    if (start) navigate(`/members/${start}`, { replace: true });
  }, [route.kind, members]);

  // Remember the member whose timeline is shown (never an id that is no member).
  useEffect(() => {
    if (route.kind !== 'member' || !members.some((m) => m.id === route.id)) return;
    try {
      localStorage.setItem(LAST_MEMBER_KEY, route.id);
    } catch {
      /* private mode: just don't remember */
    }
  }, [route.kind, route.id, members]);

  // The member's albums, for the filter.
  const [albums, setAlbums] = useState([]);
  const memberId = route.kind === 'member' ? route.id : null;
  useEffect(() => {
    setAlbums([]);
    if (memberId) api.memberAlbums(memberId).then(setAlbums, () => {});
  }, [memberId]);
  const onFilter = useCallback((filter) => navigate(gridPath({ ...route, filter }), { replace: true }), [gridKey]);

  // Jobs finished → refresh the grid in place (moved originals leave a member's timeline, copies
  // join the family one).
  const [movedCount, setMovedCount] = useState(0);
  const { summary, refresh: refreshJobs } = useJobs(
    useCallback(
      (_done, moves) => {
        if (moves > 0) setMovedCount((c) => c + moves);
        reload();
      },
      [reload],
    ),
  );

  // Family grid: only assets with an original can be given back. Member grid: anything
  // (a live photo moves with its video, a stack whole).
  const isSelectable = useCallback((item) => (route.kind === 'family' ? !item.noOrigin : true), [route.kind]);

  const readOnly = status?.readOnly ?? true;
  const runSelected = useCallback(async () => {
    const ids = [...selected];
    // Give back deletes family copies (each has an original that goes back first): ask once.
    const ask = `Give back ${ids.length} photo${ids.length === 1 ? '' : 's'}? The originals return to the members' timelines and these family copies are deleted.`;
    if (route.kind === 'family' && !confirm(ask)) return;
    try {
      const r = route.kind === 'family' ? await api.giveBack(ids) : await api.move(route.id, ids);
      // Queued now or already: either way each has an unfinished job, so it leaves the grid.
      drop(ids);
      // What can't be moved shows up as failed in the jobs indicator (the worker decides).
      const parts = [`${r.queued} queued`];
      if (r.alreadyQueued) parts.push(`${r.alreadyQueued} already queued`);
      setToast({ kind: 'ok', text: parts.join(' • ') });
      refreshJobs();
    } catch (e) {
      setToast({ kind: 'error', text: e.message });
    }
  }, [selected, route.kind, route.id, refreshJobs, drop]);
  const action = {
    label: route.kind === 'family' ? 'Give back' : 'Move to family',
    disabled: readOnly,
    title: readOnly
      ? 'Read-only: the upgrade guard failed'
      : route.kind === 'family'
        ? 'Put the originals back on the members’ timelines and delete these family copies'
        : 'Copy to the family account and archive the originals',
    run: runSelected,
  };
  // The worker paused or went on (the jobs poll saw it): the read-only banner follows at once,
  // not at its own next poll.
  // The 1st summary only sets where it stands: the status was just loaded on start.
  const paused = summary?.worker.paused;
  const seenSummary = useRef(false);
  useEffect(() => {
    if (paused === undefined) return;
    if (seenSummary.current) loadStatus();
    seenSummary.current = true;
  }, [paused]);

  // "Check again", in the read-only banner and the paused dropdown: 1 check for both.
  const [checking, setChecking] = useState(false);
  const onCheckAgain = useCallback(async () => {
    setChecking(true);
    try {
      const r = await api.recheck();
      setStatus((s) => ({ ...s, ...r }));
      await refreshJobs();
      setToast(r.readOnly ? { kind: 'warn', text: 'Still not working' } : { kind: 'ok', text: 'Working again: moves resumed' });
    } catch (e) {
      setToast({ kind: 'error', text: e.message });
    } finally {
      setChecking(false);
    }
  }, [refreshJobs]);

  const onRetry = useCallback(
    (id) => api.retryJob(id).then(refreshJobs, (e) => setToast({ kind: 'error', text: e.message })),
    [refreshJobs],
  );

  const onSelect = useCallback(
    (index, shift) => {
      const item = items[index];
      if (shift && anchor.current !== null) {
        setSelected((s) => addRange(s, items, anchor.current, index, isSelectable));
      } else {
        setSelected((s) => toggleOne(s, item.id));
      }
      anchor.current = index;
    },
    [items, isSelectable],
  );
  const onDay = useCallback((dayItems) => setSelected((s) => toggleDay(s, dayItems, isSelectable)), [isSelectable]);
  const onToggle = useCallback((id) => setSelected((s) => toggleOne(s, id)), []);

  // Viewer state lives in the URL (?asset=<id>).
  const viewerIndex = items && route.asset ? items.findIndex((i) => i.id === route.asset) : -1;
  const onOpen = useCallback((id) => navigate(gridPath(route, id), { state: { viewer: true } }), [gridKey]);
  const onClose = useCallback(() => {
    // Opened from the grid → step back over that entry; opened from a pasted link → replace it.
    if (history.state?.viewer) history.back();
    else navigate(gridKey, { replace: true });
  }, [gridKey]);
  const onNav = useCallback(
    (d) => {
      if (viewerIndex < 0) return;
      const next = items[Math.min(Math.max(viewerIndex + d, 0), items.length - 1)];
      // Replace, not push: Back should close the viewer, not step through every photo seen.
      if (next) navigate(gridPath(route, next.id), { replace: true, state: history.state });
    },
    [items, viewerIndex, gridKey],
  );
  // The viewer closed (Esc, its button, the browser's Back): the focus goes to the magnifier of
  // the photo last shown, so the keyboard carries on from there, not from the photo first opened.
  const viewerOpen = viewerIndex >= 0;
  const lastShown = useRef(null);
  if (viewerOpen) lastShown.current = route.asset;
  // An effect after the paint, not a layout effect: from a layout effect the scroll does not hold
  // when the viewer closes through history.back().
  useEffect(() => {
    if (viewerOpen || !lastShown.current) return;
    const tile = document.querySelector(`.tile[data-id="${lastShown.current}"]`);
    if (!tile) return; // gone meanwhile (a job moved it)
    tile.querySelector('[data-open]').focus({ preventScroll: true });
    // The whole tile, not just its magnifier; its scroll margin keeps it clear of the top bar.
    tile.scrollIntoView({ block: 'nearest' });
  }, [viewerOpen]);

  const member = route.kind === 'member' ? members.find((m) => m.id === route.id) : null;
  const title = route.kind === 'family' ? 'Family account' : route.kind === 'queue' ? 'Queue' : member?.name ?? '';
  const openQueue = useCallback(() => navigate('/queue'), []);
  // The queue's side panel follows the URL (?job=), so a job can be linked (the top bar's
  // dropdowns open one from any page). Opening it on the queue page adds a history entry, so the
  // browser's Back closes it like Esc; another job in the open panel replaces that entry.
  const openJob = useCallback((id) => {
    const onQueue = location.pathname === '/queue';
    const panelOpen = onQueue && new URLSearchParams(location.search).has('job');
    if (id === null) {
      if (history.state?.panel) history.back();
      else navigate('/queue', { replace: true });
    } else if (panelOpen) {
      navigate(`/queue?job=${id}`, { replace: true, state: history.state });
    } else {
      navigate(`/queue?job=${id}`, { state: { panel: onQueue } });
    }
  }, []);

  const [collapsed, toggleCollapsed] = useCollapsed();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const onMenu = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // With the queue's side panel open (lg and up), the content column makes room for it, so the
  // top bar and its dropdowns end where the panel starts.
  return html`
    <div class="flex min-h-dvh" inert=${viewerOpen}>
      <${Sidebar}
        members=${members}
        route=${route}
        user=${status?.user}
        jobs=${summary}
        collapsed=${collapsed}
        onToggle=${toggleCollapsed}
        drawerOpen=${drawerOpen}
        onCloseDrawer=${closeDrawer}
      />
      <div class="min-w-0 flex-1 lg:has-[[data-panel]]:pr-[28rem]">
        <${TopBar}
          title=${title}
          count=${items && route.kind !== 'queue' ? items.length : null}
          selectedCount=${selected.size}
          action=${action}
          tileSize=${tileSize}
          setTileSize=${setTileSize}
          onClear=${() => setSelected(new Set())}
          onMenu=${onMenu}
          jobs=${html`<${JobsIndicator} summary=${summary} readOnly=${readOnly} checking=${checking} onCheckAgain=${onCheckAgain} onRetry=${onRetry} onOpenJob=${openJob} onOpenQueue=${openQueue} />`}
        />
        ${route.kind === 'member' && html`<${FilterBar} albums=${albums} filter=${route.filter} onChange=${onFilter} />`}
        <${StorageTemplateReminder} count=${movedCount} onDismiss=${() => setMovedCount(0)} />
        ${status?.readOnly &&
        html`<div class="flex items-start gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200" role="alert">
          <${Icon} name="alert" class="mt-0.5 size-4 shrink-0" />
          <span class="min-w-0 flex-1 break-words"><strong class="font-semibold">Read-only.</strong> ${status.problems.join(' • ')}</span>
          <${CheckAgain} checking=${checking} onClick=${onCheckAgain} />
        </div>`}
        <main class="px-2 pb-24 sm:px-4">
          ${route.kind === 'queue' &&
          html`<${QueuePage}
            summary=${summary}
            members=${members}
            tileSize=${tileSize}
            readOnly=${readOnly}
            onRetry=${onRetry}
            jobId=${route.job}
            onSelectJob=${openJob}
          />`}
          ${error && html`<p class="py-16 text-center text-rose-300" role="alert">${error}</p>`}
          ${!error && items === null && gridKey && html`<p class="py-16 text-center text-neutral-500">Loading…</p>`}
          ${items &&
          html`<${Grid}
            items=${items}
            selected=${selected}
            setSelected=${setSelected}
            isSelectable=${isSelectable}
            tileSize=${tileSize}
            onSelect=${onSelect}
            onDay=${onDay}
            onOpen=${onOpen}
            empty=${route.kind === 'family'
              ? ['No photos in the family account', 'Photos moved here from a member’s timeline show up here.']
              : route.filter?.album || route.filter?.from || route.filter?.to
                ? ['No photos match these filters', 'Try another album or other days.']
                : [`No photos on ${member ? `${member.name}’s` : 'this'} timeline`, 'Only photos on the timeline show up: archived, trashed and locked ones don’t.']}
          />`}
        </main>
      </div>
    </div>
    ${toast &&
    html`<div
      class=${`fixed bottom-6 left-1/2 z-40 max-w-[90vw] -translate-x-1/2 rounded-full px-4 py-2 text-sm shadow-2xl ${
        toast.kind === 'error' ? 'bg-rose-600 text-white' : toast.kind === 'warn' ? 'bg-amber-500 text-neutral-950' : 'bg-neutral-100 text-neutral-900'
      }`}
      role="status"
    >${toast.text}</div>`}
    ${viewerOpen &&
    html`<${Viewer}
      items=${items}
      index=${viewerIndex}
      selected=${selected}
      isSelectable=${isSelectable}
      onClose=${onClose}
      onNav=${onNav}
      onToggle=${onToggle}
    />`}
  `;
}

keepAlive();
render(html`<${App} />`, document.getElementById('app'));
