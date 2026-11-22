// Timeline grid: days, tiles, badges, drag-select, keyboard.
// Click a tile = select it (shift-click = range); the magnifier corner (bottom-right third)
// opens the viewer. The magnifier shows on hover, or always on a touch screen (no hover there). A tile that can't be selected (family "no origin") opens on click instead.
// Keyboard: the whole grid is 1 Tab stop (roving tabindex over the photos and day buttons);
// arrows move, Space selects (Shift+Space: range), Enter opens.
import { Component, h } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { media } from './api.js';
import { moveFocus } from './gridnav.js';
import { CheckCircle, Icon } from './icons.js';
import { applyMarquee, groupByDay, rectsIntersect } from './selection.js';
import { Thumb } from './thumb.js';

const html = htm.bind(h);

// localDateTime is wall-clock time encoded as UTC → format in UTC to keep the photo's own time.
const dayLabel = (day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
export const duration = (ms) => {
  const s = Math.round((ms ?? 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const pill = 'rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-medium leading-none text-white backdrop-blur-sm';

/** Media facts (top-right): video length, LIVE, stack size. */
export function MediaBadges({ item }) {
  return html`
    ${item.type === 'video' &&
    html`<span class=${`${pill} inline-flex items-center gap-0.5`}><${Icon} name="play" class="size-3" />${duration(item.durationMs)}</span>`}
    ${item.livePhotoVideoId && html`<span class=${pill}>LIVE</span>`}
    ${item.stack &&
    html`<span class=${`${pill} inline-flex items-center gap-1`} title="Stack: moves as a whole"><${Icon} name="stack" class="size-3" />${item.stack.size}</span>`}`;
}

/** Picker facts (bottom-left): what the Move / Give back will do differently. */
export function StatusBadges({ item }) {
  const tag = 'rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none text-white';
  return html`
    ${item.inFamily && html`<span class=${`${tag} bg-emerald-600/90`} title="Same bytes already in the family account">in family</span>`}
    ${item.edited && html`<span class=${`${tag} bg-amber-600/90`} title="Crop/rotate/mirror done in Immich are not carried to the family copy">edits not carried</span>`}
    ${item.noOrigin && html`<span class=${`${tag} bg-neutral-600/90`} title="No original to give back to">no origin</span>`}`;
}

// A class with shouldComponentUpdate: a drag-select changes the selection on every frame, and
// only the tiles whose state changed should re-render (a timeline can have thousands).
class Tile extends Component {
  shouldComponentUpdate(next) {
    const p = this.props;
    return (
      next.item !== p.item || next.selected !== p.selected || next.selectable !== p.selectable ||
      next.index !== p.index || next.large !== p.large || next.tabStop !== p.tabStop
    );
  }

  render({ item, index, selected, selectable, large, tabStop, onSelect, onOpen }) {
    const src = large ? media.preview(item.id) : media.thumbnail(item.id);
    return html`
      <div
        class=${`tile group relative aspect-square scroll-mt-14 overflow-hidden ${selected ? 'bg-neutral-800' : 'bg-neutral-900'}`}
        data-id=${item.id}
        data-selectable=${selectable ? '1' : '0'}
      >
        <button
          data-nav=${item.id}
          tabindex=${tabStop ? 0 : -1}
          class=${`photo-ring absolute inset-0 block size-full ${selectable ? 'cursor-pointer' : 'cursor-zoom-in'}`}
          aria-pressed=${selectable ? selected : undefined}
          aria-label=${selectable ? `${selected ? 'Unselect' : 'Select'} ${item.fileName}` : `Open ${item.fileName}`}
          title=${item.fileName}
          onClick=${(e) => (selectable ? onSelect(index, e.shiftKey) : onOpen(item.id))}
        >
          <${Thumb}
            src=${src}
            loading="lazy"
            decoding="async"
            draggable=${false}
            class=${`size-full transition-[scale] duration-200 ease-out ${selected ? 'scale-[0.86]' : 'scale-100'}`}
          />
        </button>

        <div class="pointer-events-none absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-black/40 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />

        ${selectable &&
        html`<div class=${`pointer-events-none absolute left-1.5 top-1.5 transition-opacity ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 [.selecting_&]:opacity-100'}`}>
          <${CheckCircle} on=${selected} />
        </div>`}

        <div class="pointer-events-none absolute right-1.5 top-1.5 flex gap-1"><${MediaBadges} item=${item} /></div>
        <div class="pointer-events-none absolute bottom-1.5 left-1.5 right-1/3 flex flex-wrap-reverse gap-1"><${StatusBadges} item=${item} /></div>

        <button
          data-open
          tabindex="-1"
          class="group/zoom absolute bottom-0 right-0 flex h-1/3 w-1/3 cursor-zoom-in items-end justify-end p-1.5 outline-none"
          aria-label=${`Open ${item.fileName}`}
          title="Open"
          onClick=${() => onOpen(item.id)}
        >
          <span class="rounded-full bg-black/55 p-1.5 text-white opacity-0 shadow-sm backdrop-blur-sm transition-[opacity,scale,background-color,color] duration-150 group-hover:opacity-100 [@media(hover:none)]:opacity-100 group-hover/zoom:scale-115 group-hover/zoom:bg-white group-hover/zoom:text-neutral-900 group-focus-visible/zoom:opacity-100 group-focus-visible/zoom:ring-2 group-focus-visible/zoom:ring-sky-400">
            <${Icon} name="magnify" class="size-4" />
          </span>
        </button>
      </div>`;
  }
}

const DRAG_THRESHOLD = 6; // px the pointer must move before a press becomes a drag-select
const EDGE = 48; // px from the window edge where a drag-select scrolls the page

// Drag-select (Finder-style rectangle). Adds the touched photos to the selection; with Alt held
// it removes them. A press that moves less than DRAG_THRESHOLD stays a normal click; the day
// buttons never start a drag.
function useMarquee(wrapRef, selected, setSelected) {
  const [box, setBox] = useState(null);
  const drag = useRef(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const swallowClick = useRef(false);

  const update = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    d.frame = 0;
    const x = d.x + scrollX;
    const y = d.y + scrollY;
    const rect = { left: Math.min(d.startX, x), right: Math.max(d.startX, x), top: Math.min(d.startY, y), bottom: Math.max(d.startY, y) };
    setBox({ left: rect.left - scrollX, top: rect.top - scrollY, width: rect.right - rect.left, height: rect.bottom - rect.top });

    // Only look inside days the rectangle touches (off-screen days skip layout).
    const docRect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left + scrollX, right: r.right + scrollX, top: r.top + scrollY, bottom: r.bottom + scrollY };
    };
    const hits = [];
    for (const day of wrapRef.current.querySelectorAll('.day')) {
      if (!rectsIntersect(rect, docRect(day))) continue;
      for (const tile of day.querySelectorAll('.tile[data-selectable="1"]')) {
        if (rectsIntersect(rect, docRect(tile))) hits.push(tile.dataset.id);
      }
    }
    setSelected(applyMarquee(d.base, hits, d.remove));

    // Near the top/bottom edge: keep scrolling while the pointer stays there.
    const step = d.y < EDGE ? -20 : d.y > innerHeight - EDGE ? 20 : 0;
    if (step) {
      scrollBy(0, step);
      d.frame = requestAnimationFrame(update);
    }
  }, [setSelected]);

  const schedule = useCallback(() => {
    const d = drag.current;
    if (d?.active && !d.frame) d.frame = requestAnimationFrame(update);
  }, [update]);

  const onPointerDown = useCallback(
    (e) => {
      if (e.button !== 0 || e.target.closest('.day-tick')) return;
      swallowClick.current = false;
      drag.current = {
        startX: e.clientX + scrollX, startY: e.clientY + scrollY,
        x: e.clientX, y: e.clientY, active: false, frame: 0,
        base: selectedRef.current, remove: e.altKey,
      };
      const move = (ev) => {
        const d = drag.current;
        d.x = ev.clientX;
        d.y = ev.clientY;
        if (!d.active && Math.hypot(ev.clientX + scrollX - d.startX, ev.clientY + scrollY - d.startY) < DRAG_THRESHOLD) return;
        d.active = true;
        schedule();
      };
      const end = () => {
        const d = drag.current;
        if (d?.frame) cancelAnimationFrame(d.frame);
        if (d?.active) swallowClick.current = true; // the release must not toggle or open a tile
        drag.current = null;
        setBox(null);
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', end);
        removeEventListener('pointercancel', end);
        removeEventListener('scroll', schedule);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', end);
      addEventListener('pointercancel', end);
      addEventListener('scroll', schedule);
    },
    [schedule],
  );

  const onClickCapture = useCallback((e) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  return { box, onPointerDown, onClickCapture };
}

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
const dayKey = (day) => `day:${day}`;

/**
 * The grid's 1 Tab stop (roving tabindex): a photo id or dayKey(day). It follows the focus (a
 * click moves it too). When its photo or day button goes (a job moved it, a reload), the photo
 * at the same flat position takes over, else the last one; and the focus with it, if the focus
 * was in the grid.
 */
function useRovingFocus(wrapRef, groups, items, isSelectable, onSelect, onOpen) {
  const [current, setCurrent] = useState(null);
  const lastIndex = useRef(0); // flat index of the photo the Tab stop was last on
  const focusInside = useRef(false);

  // Each day as moveFocus sees it, and where every photo / day button sits.
  const { navDays, where } = useMemo(() => {
    const where = new Map();
    const navDays = groups.map(({ day, entries }, d) => {
      const head = entries.some((e) => isSelectable(e.item));
      if (head) where.set(dayKey(day), { day: d, at: 'head' });
      entries.forEach((e, at) => where.set(e.item.id, { day: d, at }));
      return { count: entries.length, head };
    });
    return { navDays, where };
  }, [groups, isSelectable]);
  const keyOf = (pos) => (pos.at === 'head' ? dayKey(groups[pos.day].day) : groups[pos.day].entries[pos.at].item.id);

  let stop = null;
  if (items.length) {
    if (current && where.has(current)) stop = current;
    else if (current?.startsWith('day:')) {
      // Its day button went (nothing selectable left): the day's 1st photo, if the day is still there.
      stop = groups.find((g) => dayKey(g.day) === current)?.entries[0].item.id ?? null;
    }
    stop ??= items[Math.min(lastIndex.current, items.length - 1)].id;
  }

  const elementOf = (key) => wrapRef.current?.querySelector(`[data-nav="${CSS.escape(key)}"]`);
  const focusKey = (key) => {
    const el = elementOf(key);
    if (!el) return;
    el.focus({ preventScroll: true });
    // The tile, not its button: the tile's scroll margin keeps it clear of the sticky top bar.
    (el.closest('.tile') ?? el).scrollIntoView({ block: 'nearest' });
  };

  // The Tab stop moved off a photo or day button that went: the focus follows if it was in the grid.
  useEffect(() => {
    if (stop === current || !stop) return;
    const active = document.activeElement;
    const wasInside = focusInside.current && (active === document.body || wrapRef.current?.contains(active));
    if (current && wasInside) elementOf(stop)?.focus({ preventScroll: true });
  });

  const onFocusIn = (e) => {
    focusInside.current = true;
    const el = e.target.closest('[data-nav]') ?? e.target.closest('.tile')?.querySelector('[data-nav]');
    if (!el) return;
    const key = el.dataset.nav;
    setCurrent(key);
    const pos = where.get(key);
    if (pos) lastIndex.current = groups[pos.day].entries[pos.at === 'head' ? 0 : pos.at].index;
  };
  const onFocusOut = (e) => {
    if (!wrapRef.current?.contains(e.relatedTarget)) focusInside.current = false;
  };

  const onKeyDown = (e) => {
    const target = e.target.closest('[data-nav]');
    const navEl = target ?? e.target.closest('.tile')?.querySelector('[data-nav]');
    if (!navEl) return;
    const pos = where.get(navEl.dataset.nav);
    if (!pos) return;
    if (NAV_KEYS.has(e.key)) {
      if (e.altKey || e.ctrlKey || e.metaKey) return; // e.g. Alt+← is the browser's Back
      e.preventDefault();
      const tracks = getComputedStyle(navEl.closest('.day').querySelector('.day-grid')).gridTemplateColumns;
      const cols = Math.max(1, tracks.split(' ').length);
      focusKey(keyOf(moveFocus(navDays, cols, pos, e.key)));
      return;
    }
    // Space and Enter on a photo are handled here, not by the button's own click, so Shift is
    // read from the key itself (a Space-made click doesn't carry it in every browser).
    if (!target || pos.at === 'head') return;
    const { item, index } = groups[pos.day].entries[pos.at];
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(item.id);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (isSelectable(item)) onSelect(index, e.shiftKey);
    }
  };
  // The button would still click on Space's release.
  const onKeyUp = (e) => {
    if (e.key === ' ' && e.target.closest('.tile [data-nav]')) e.preventDefault();
  };

  return { stop, onFocusIn, onFocusOut, onKeyDown, onKeyUp };
}

/** empty: what to say when there are no items (title, hint). */
export function Grid({ items, selected, setSelected, isSelectable, tileSize, onSelect, onDay, onOpen, empty }) {
  const groups = useMemo(() => groupByDay(items), [items]);
  const wrapRef = useRef(null);
  const { box, onPointerDown, onClickCapture } = useMarquee(wrapRef, selected, setSelected);
  const nav = useRovingFocus(wrapRef, groups, items, isSelectable, onSelect, onOpen);
  if (items.length === 0) {
    return html`<div class="flex flex-col items-center gap-2 py-20 text-center">
      <span class="grid size-14 place-items-center rounded-full bg-white/5 text-neutral-500"><${Icon} name="album" class="size-7" /></span>
      <p class="text-base font-medium text-neutral-300">${empty?.[0] ?? 'No photos here'}</p>
      ${empty?.[1] && html`<p class="max-w-sm text-sm text-neutral-500">${empty[1]}</p>`}
    </div>`;
  }
  // Immich's thumbnails are ~250 px; bigger tiles use the preview so they stay sharp.
  const large = tileSize > 240;
  return html`
    <div
      ref=${wrapRef}
      data-photos
      role="group"
      aria-label="Photos"
      aria-describedby="photos-keys"
      class=${`select-none ${selected.size ? 'selecting' : ''}`}
      style=${{ '--tile': `${tileSize}px` }}
      onPointerDown=${onPointerDown}
      onClickCapture=${onClickCapture}
      onFocusIn=${nav.onFocusIn}
      onFocusOut=${nav.onFocusOut}
      onKeyDown=${nav.onKeyDown}
      onKeyUp=${nav.onKeyUp}
    >
      <p id="photos-keys" class="sr-only">Arrow keys move, Space selects, Enter opens.</p>
      ${groups.map(({ day, entries }) => {
        const dayItems = entries.map((e) => e.item).filter(isSelectable);
        const allIn = dayItems.length > 0 && dayItems.every((i) => selected.has(i.id));
        const count = html`<span class="text-xs font-normal text-neutral-500">${entries.length}<span class="sr-only">${entries.length === 1 ? ' item' : ' items'}</span></span>`;
        return html`
          <section class="day group/day" key=${day}>
            <h2 class="pb-2 pt-5 text-sm font-medium text-neutral-300">
              ${dayItems.length > 0
                ? html`<button
                    data-nav=${dayKey(day)}
                    tabindex=${nav.stop === dayKey(day) ? 0 : -1}
                    class="day-tick group/label -mx-1.5 inline-flex scroll-mt-14 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 outline-none transition-colors hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-sky-400"
                    aria-pressed=${allIn}
                    title=${allIn ? 'Unselect this day' : 'Select this day'}
                    onClick=${() => onDay(entries.map((e) => e.item))}
                  >
                    <span class=${`flex transition-opacity ${allIn ? 'opacity-100' : 'opacity-0 group-hover/day:opacity-100 [.selecting_&]:opacity-100'}`}>
                      <${CheckCircle} on=${allIn} class="size-5" />
                    </span>
                    <span>${dayLabel(day)}</span>
                    ${count}
                  </button>`
                : html`<span class="inline-flex items-center gap-2 px-1.5 py-1">
                    <span class="size-5" />
                    <span>${dayLabel(day)}</span>
                    ${count}
                  </span>`}
            </h2>
            <div class="day-grid grid grid-cols-[repeat(auto-fill,minmax(min(var(--tile),30vw),1fr))] gap-1">
              ${entries.map(
                ({ item, index }) => html`<${Tile}
                  key=${item.id}
                  item=${item}
                  index=${index}
                  selected=${selected.has(item.id)}
                  selectable=${isSelectable(item)}
                  large=${large}
                  tabStop=${nav.stop === item.id}
                  onSelect=${onSelect}
                  onOpen=${onOpen}
                />`,
              )}
            </div>
          </section>`;
      })}
      ${box &&
      html`<div
        class="pointer-events-none fixed z-30 rounded-sm border border-sky-400 bg-sky-400/15"
        style=${{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }}
      />`}
    </div>`;
}
