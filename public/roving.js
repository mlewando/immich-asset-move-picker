// 1 Tab stop for a grid of buttons (roving tabindex): the timeline's photos and day headers, the
// queue's job tiles. Arrows move (public/gridnav.js works out where), Enter and Space act.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { dayKey, moveFocus, tabStop } from './gridnav.js';

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/** Focuses a grid button and scrolls it into view. */
export function focusNav(el) {
  el.focus({ preventScroll: true });
  // A photo's tile, not its button: the tile's scroll margin keeps it clear of the sticky top bar.
  (el.closest('.tile') ?? el).scrollIntoView({ block: 'nearest' });
}

// The grid button an event is about (a photo's magnifier counts as its photo's button).
const navOf = (target) => target.closest?.('[data-nav]') ?? target.closest?.('.tile')?.querySelector('[data-nav]');

/**
 * Hands the focus on when the grid button holding it leaves the page (a job moved its photo, a
 * reload): browsers then drop the focus to the page body. Returns the focusin handler for the
 * element around the buttons; it remembers the last button focused there. After a render in
 * which that button is gone and the focus is on the body, onLost({ section }) runs (section:
 * the <section> the button was in). A press anywhere but on a grid button forgets it, so a mouse
 * user who clicked away isn't pulled back in.
 */
export function useLostFocus(onLost) {
  const last = useRef(null);
  useEffect(() => {
    const forget = (e) => {
      if (last.current && !(navOf(e.target) && last.current.root.contains(e.target))) last.current = null;
    };
    document.addEventListener('pointerdown', forget, true);
    return () => document.removeEventListener('pointerdown', forget, true);
  }, []);
  useEffect(() => {
    const lost = last.current;
    if (!lost || lost.el.isConnected) return;
    last.current = null;
    const active = document.activeElement;
    if (!active || active === document.body) onLost(lost);
  });
  return (e) => {
    const el = navOf(e.target);
    last.current = el ? { el, root: e.currentTarget, section: el.closest('section') } : null;
  };
}

/**
 * groups: [{ day, entries: [{ item, index }] }] (as groupByDay), items: the same flat, each with
 * a string id. Buttons carry data-nav = item id, or dayKey(day) for a group's header button
 * (hasHead(entries) says whether it has one), and sit in elements of class nav-grid (a header's
 * grid is the nav-grid of its .day). onActivate(entry, event): Enter or Space on an item button;
 * a header button keeps its own click.
 *
 * The Tab stop follows the focus. When its button goes (a job moved its photo, a reload),
 * tabStop() picks the next one, and the focus moves with it if it was on the gone button
 * (onEmpty() runs instead when nothing is left). Returns the Tab stop's key and the wrapper's
 * event handlers.
 */
export function useRovingFocus(wrapRef, groups, items, hasHead, onActivate, onEmpty) {
  const [current, setCurrent] = useState(null);
  const lastIndex = useRef(0); // flat index of the item the Tab stop was last on

  // Each group as moveFocus sees it, and where every button sits.
  const { navDays, where } = useMemo(() => {
    const where = new Map();
    const navDays = groups.map(({ day, entries }, d) => {
      const head = hasHead(entries);
      // index: the flat index of the item, or of the group's 1st item for its header button.
      if (head) where.set(dayKey(day), { day: d, at: 'head', index: entries[0].index });
      entries.forEach((e, at) => where.set(e.item.id, { day: d, at, index: e.index }));
      return { count: entries.length, head };
    });
    return { navDays, where };
  }, [groups, hasHead]);
  const keyOf = (pos) => (pos.at === 'head' ? dayKey(groups[pos.day].day) : groups[pos.day].entries[pos.at].item.id);

  const stop = tabStop(items, groups, where, current, lastIndex.current);
  const elementOf = (key) => wrapRef.current?.querySelector(`[data-nav="${CSS.escape(key)}"]`);

  const rememberFocus = useLostFocus(() => {
    const el = stop && elementOf(stop);
    if (el) el.focus({ preventScroll: true });
    else onEmpty?.();
  });

  const moveStopTo = (target) => {
    const el = navOf(target);
    if (!el) return;
    setCurrent(el.dataset.nav);
    const pos = where.get(el.dataset.nav);
    if (pos) lastIndex.current = pos.index;
  };
  const onFocusIn = (e) => {
    rememberFocus(e);
    moveStopTo(e.target);
  };
  // Safari and Firefox on macOS don't focus a clicked button: the click moves the Tab stop there.
  const onClick = (e) => moveStopTo(e.target);

  const onKeyDown = (e) => {
    const navEl = navOf(e.target);
    if (!navEl) return;
    const pos = where.get(navEl.dataset.nav);
    if (!pos) return;
    if (NAV_KEYS.has(e.key)) {
      if (e.altKey || e.ctrlKey || e.metaKey) return; // e.g. Alt+← is the browser's Back
      e.preventDefault();
      const grid = navEl.closest('.nav-grid') ?? navEl.closest('.day')?.querySelector('.nav-grid');
      const cols = grid ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length) : 1;
      const el = elementOf(keyOf(moveFocus(navDays, cols, pos, e.key)));
      if (el) focusNav(el);
      return;
    }
    // Space and Enter on an item are handled here, not by the button's own click, so Shift is
    // read from the key itself (a Space-made click doesn't carry it in every browser). Not on a
    // magnifier: it is its own button.
    if (navEl !== e.target || pos.at === 'head' || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    if (e.repeat) return; // a held key acts once, like a button's click
    onActivate(groups[pos.day].entries[pos.at], e);
  };
  // The button would still click on Space's release.
  const onKeyUp = (e) => {
    const nav = e.target.dataset?.nav;
    if (e.key === ' ' && nav && where.get(nav)?.at !== 'head') e.preventDefault();
  };

  return { stop, onFocusIn, onClick, onKeyDown, onKeyUp };
}
