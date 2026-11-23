// Timeline grid: days, tiles, badges, drag-select, keyboard.
// Click a tile = select it (shift-click = range); the magnifier corner (bottom-right third)
// opens the viewer. The magnifier shows on hover, or always on a touch screen (no hover there). A tile that can't be selected (family "no origin") opens on click instead.
// Keyboard: the whole grid is 1 Tab stop (roving tabindex over the photos and day buttons);
// arrows move, Space selects (Shift+Space: range), Enter opens (public/roving.js).
import { Component, h } from 'preact';
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { media } from './api.js';
import { dayKey } from './gridnav.js';
import { CheckCircle, Icon } from './icons.js';
import { useRovingFocus } from './roving.js';
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
      next.index !== p.index || next.large !== p.large || next.isTabStop !== p.isTabStop
    );
  }

  render({ item, index, selected, selectable, large, isTabStop, onSelect, onOpen }) {
    const src = large ? media.preview(item.id) : media.thumbnail(item.id);
    return html`
      <div
        class=${`tile group relative aspect-square scroll-mt-14 overflow-hidden ${selected ? 'bg-neutral-800' : 'bg-neutral-900'}`}
        data-id=${item.id}
        data-selectable=${selectable ? '1' : '0'}
      >
        <button
          data-nav=${item.id}
          tabindex=${isTabStop ? 0 : -1}
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
          <span class="rounded-full bg-black/55 p-1.5 text-white opacity-0 shadow-sm backdrop-blur-sm transition-[opacity,scale,background-color,color] duration-150 group-hover:opacity-100 [@media(hover:none)]:opacity-100 group-hover/zoom:scale-115 group-hover/zoom:bg-white group-hover/zoom:text-neutral-900">
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

/** empty: what to say when there are no items (title, hint). */
export function Grid({ items, selected, setSelected, isSelectable, tileSize, onSelect, onDay, onOpen, empty }) {
  const groups = useMemo(() => groupByDay(items), [items]);
  const wrapRef = useRef(null);
  const { box, onPointerDown, onClickCapture } = useMarquee(wrapRef, selected, setSelected);
  // A day has its "select this day" button when something in it can be selected.
  const hasHead = useCallback((entries) => entries.some((e) => isSelectable(e.item)), [isSelectable]);
  // Enter opens; Space selects (Shift+Space: range), or opens a photo that can't be selected.
  // The last photo went with the focus on it: the page's content takes the focus.
  const focusMain = () => document.getElementById('main')?.focus({ preventScroll: true });
  const nav = useRovingFocus(wrapRef, groups, items, hasHead, ({ item, index }, e) => {
    if (e.key === 'Enter' || !isSelectable(item)) onOpen(item.id);
    else onSelect(index, e.shiftKey);
  }, focusMain);
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
            <div class="nav-grid grid grid-cols-[repeat(auto-fill,minmax(min(var(--tile),30vw),1fr))] gap-1">
              ${entries.map(
                ({ item, index }) => html`<${Tile}
                  key=${item.id}
                  item=${item}
                  index=${index}
                  selected=${selected.has(item.id)}
                  selectable=${isSelectable(item)}
                  large=${large}
                  isTabStop=${nav.stop === item.id}
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
