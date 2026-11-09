// The picker page: member sidebar, timeline grid grouped by day, full-screen viewer, selection,
// Move to family / Give back. Preact + htm, loaded as browser modules (no JS build).
import { h, render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';
import { Grid } from './grid.js';
import { Icon } from './icons.js';
import { MovesIndicator, StorageTemplateReminder, useMoves } from './moves.js';
import { addRange, toggleDay, toggleOne } from './selection.js';
import { Viewer } from './viewer.js';

const html = htm.bind(h);

// --- routing: /members/<id>[?album=&from=&to=] | /family, viewer as &asset=<id> ------------
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

// --- sidebar -----------------------------------------------------------------------------------
const AVATAR_COLORS = ['bg-sky-600', 'bg-violet-600', 'bg-rose-600', 'bg-amber-600', 'bg-emerald-600', 'bg-fuchsia-600'];
const avatarColor = (id) => AVATAR_COLORS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

function NavItem({ href, active, children }) {
  return html`<a
    href=${href}
    class=${`flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm transition-colors ${active ? 'bg-sky-500/15 text-sky-200' : 'text-neutral-300 hover:bg-white/5'}`}
    aria-current=${active ? 'page' : undefined}
    onClick=${(e) => {
      e.preventDefault();
      if (!active) navigate(href);
    }}
  >${children}</a>`;
}

function Sidebar({ members, route }) {
  const label = 'px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-neutral-500';
  return html`
    <aside class="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r border-white/5 bg-neutral-900/50 px-2 py-3">
      <div class="flex items-center gap-2 px-2.5 pb-2">
        <div class="grid size-8 place-items-center rounded-lg bg-sky-500 text-white"><${Icon} name="family" class="size-5" /></div>
        <span class="text-[15px] font-semibold tracking-tight">Family picker</span>
      </div>
      <nav class="flex-1 overflow-y-auto">
        <div class=${label}>Members</div>
        ${members.map(
          (m) => html`<${NavItem} href=${`/members/${m.id}`} active=${route.kind === 'member' && route.id === m.id}>
            <span class=${`grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white ${avatarColor(m.id)}`}>
              ${(m.name || m.email).slice(0, 1).toUpperCase()}
            </span>
            <span class="min-w-0">
              <span class="block truncate font-medium">${m.name}</span>
              <span class="block truncate text-xs text-neutral-500">${m.email}</span>
            </span>
          </${NavItem}>`,
        )}
        <div class=${label}>Shared</div>
        <${NavItem} href="/family" active=${route.kind === 'family'}>
          <span class="grid size-7 shrink-0 place-items-center rounded-full bg-neutral-700 text-neutral-200"><${Icon} name="family" class="size-4" /></span>
          <span class="font-medium">Family account</span>
        </${NavItem}>
      </nav>
    </aside>`;
}

// --- top bar: title + zoom, or the selection actions -----------------------------------------
function TopBar({ title, count, selectedCount, action, tileSize, setTileSize, onClear, moves }) {
  const iconBtn = 'grid size-9 place-items-center rounded-full text-neutral-300 hover:bg-white/10 disabled:opacity-30';
  const bar = 'sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-white/5 px-4 backdrop-blur';
  if (selectedCount > 0) {
    return html`
      <header class=${`${bar} bg-sky-950/80`}>
        <button class=${iconBtn} onClick=${onClear} aria-label="Clear selection" title="Clear selection"><${Icon} name="close" /></button>
        <span class="flex-1 text-sm font-medium">${selectedCount} selected</span>
        ${moves}
        <button
          class="rounded-full bg-sky-500 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:opacity-40 disabled:hover:bg-sky-500"
          disabled=${action.disabled}
          title=${action.title}
          onClick=${action.run}
        >${action.label}</button>
      </header>`;
  }
  return html`
    <header class=${`${bar} bg-neutral-950/80`}>
      <div class="min-w-0 flex-1">
        <span class="text-[15px] font-semibold">${title}</span>
        ${count !== null && html`<span class="ml-2 text-sm text-neutral-500">${count} items · drag to select, Alt+drag to unselect</span>`}
      </div>
      ${moves}
      <div class="flex items-center gap-1" title="Thumbnail size">
        <button class=${iconBtn} onClick=${() => setTileSize(tileSize - ZOOM.step)} disabled=${tileSize <= ZOOM.min} aria-label="Smaller thumbnails"><${Icon} name="zoomOut" /></button>
        <input
          type="range"
          class="w-28 accent-sky-500"
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

// --- member filter: 1 album and/or a day range -----------------------------------------------
function FilterBar({ albums, filter, onChange }) {
  const field = 'rounded-lg border border-white/10 bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-200 [color-scheme:dark] focus:border-sky-500 focus:outline-none';
  const set = (k) => (e) => onChange({ ...filter, [k]: e.currentTarget.value });
  const active = filter.album || filter.from || filter.to;
  return html`
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/5 px-4 py-2 text-sm text-neutral-400">
      <label class="flex items-center gap-2">
        Album
        <select class=${`${field} max-w-64`} value=${filter.album} onChange=${set('album')} aria-label="Album">
          <option value="">All photos</option>
          ${albums.map((a) => html`<option value=${a.id}>${a.name} (${a.count})</option>`)}
        </select>
      </label>
      <label class="flex items-center gap-2">
        From
        <input type="date" class=${field} value=${filter.from} max=${filter.to || undefined} onChange=${set('from')} aria-label="From day" />
      </label>
      <label class="flex items-center gap-2">
        To
        <input type="date" class=${field} value=${filter.to} min=${filter.from || undefined} onChange=${set('to')} aria-label="To day" />
      </label>
      ${active &&
      html`<button class="rounded-full px-3 py-1.5 text-sky-300 hover:bg-white/5" onClick=${() => onChange({ album: '', from: '', to: '' })}>
        Clear filters
      </button>`}
    </div>`;
}

// --- app -----------------------------------------------------------------------------------
function App() {
  const route = useRoute();
  const [status, setStatus] = useState(null);
  const [members, setMembers] = useState([]);
  const [items, setItems] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [tileSize, setTileSize] = useTileSize();
  const anchor = useRef(null); // flat index of the last single select (shift-click range start)

  useEffect(() => {
    api.members().then(setMembers, (e) => setError(e.message));
    // The guard runs at server start and before each move: keep the read-only state current.
    const loadStatus = () => api.status().then(setStatus, () => {});
    loadStatus();
    const t = setInterval(loadStatus, 10_000);
    return () => clearInterval(t);
  }, []);

  // No grid chosen yet (/) → first member, without leaving "/" in the history.
  useEffect(() => {
    if (route.kind === 'none' && members.length) navigate(`/members/${members[0].id}`, { replace: true });
  }, [route.kind, members]);

  const gridKey = route.kind === 'none' ? '' : gridPath(route);
  const loadGrid = useCallback(
    () => (route.kind === 'family' ? api.familyAssets() : api.memberAssets(route.id, route.filter)),
    [gridKey],
  );

  // The member's albums, for the filter.
  const [albums, setAlbums] = useState([]);
  const memberId = route.kind === 'member' ? route.id : null;
  useEffect(() => {
    setAlbums([]);
    if (memberId) api.memberAlbums(memberId).then(setAlbums, () => {});
  }, [memberId]);
  const onFilter = useCallback((filter) => navigate(gridPath({ ...route, filter }), { replace: true }), [gridKey]);
  useEffect(() => {
    if (!gridKey) return;
    setItems(null);
    setError(null);
    setSelected(new Set());
    anchor.current = null;
    loadGrid().then(setItems, (e) => setError(e.message));
  }, [gridKey]);

  // Moves finished → refresh the grid in place (moved originals leave a member's timeline,
  // copies join the family one); keep the selection of what is still there.
  const [movedCount, setMovedCount] = useState(0);
  const { summary, refresh: refreshMoves } = useMoves(
    useCallback(
      (n, moves) => {
        if (moves > 0) setMovedCount((c) => c + moves);
        if (!gridKey) return;
        loadGrid().then((next) => {
          setItems(next);
          const ids = new Set(next.map((i) => i.id));
          setSelected((s) => new Set([...s].filter((id) => ids.has(id))));
        }, () => {});
      },
      [gridKey, loadGrid],
    ),
  );

  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

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
      setSelected(new Set());
      // What can't be moved shows up as failed in the moves indicator (the worker decides).
      const parts = [`${r.queued} queued`];
      if (r.alreadyQueued) parts.push(`${r.alreadyQueued} already queued`);
      setToast({ kind: 'ok', text: parts.join(' · ') });
      refreshMoves();
    } catch (e) {
      setToast({ kind: 'error', text: e.message });
    }
  }, [selected, route.kind, route.id, refreshMoves]);
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
  const onRetry = useCallback(
    (id) => api.retryMove(id).then(refreshMoves, (e) => setToast({ kind: 'error', text: e.message })),
    [refreshMoves],
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

  const member = route.kind === 'member' ? members.find((m) => m.id === route.id) : null;
  const title = route.kind === 'family' ? 'Family account' : member?.name ?? '';

  return html`
    <div class="flex min-h-screen">
      <${Sidebar} members=${members} route=${route} />
      <div class="min-w-0 flex-1">
        <${TopBar}
          title=${title}
          count=${items ? items.length : null}
          selectedCount=${selected.size}
          action=${action}
          tileSize=${tileSize}
          setTileSize=${setTileSize}
          onClear=${() => setSelected(new Set())}
          moves=${html`<${MovesIndicator} summary=${summary} onRetry=${onRetry} />`}
        />
        ${route.kind === 'member' && html`<${FilterBar} albums=${albums} filter=${route.filter} onChange=${onFilter} />`}
        <${StorageTemplateReminder} count=${movedCount} onDismiss=${() => setMovedCount(0)} />
        ${status?.readOnly &&
        html`<div class="flex items-start gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200" role="alert">
          <${Icon} name="alert" class="mt-0.5 size-4 shrink-0" />
          <span><strong class="font-semibold">Read-only.</strong> ${status.problems.join(' · ')}</span>
        </div>`}
        <main class="px-4 pb-24">
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
    ${viewerIndex >= 0 &&
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

render(html`<${App} />`, document.getElementById('app'));
