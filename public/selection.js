// Pure selection + grouping logic (no DOM), unit-tested in test/selection.test.ts.
// Selections are immutable Sets of asset ids: every change returns a new Set.

/** Items (already newest first) → [{ day, entries: [{ item, index }] }], index = flat position. */
export function groupByDay(items) {
  const groups = [];
  items.forEach((item, index) => {
    const last = groups[groups.length - 1];
    if (last && last.day === item.day) last.entries.push({ item, index });
    else groups.push({ day: item.day, entries: [{ item, index }] });
  });
  return groups;
}

export function toggleOne(selected, id) {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Shift-click: add every selectable item between 2 flat positions (inclusive, either order). */
export function addRange(selected, items, from, to, isSelectable) {
  const next = new Set(selected);
  const [a, b] = from <= to ? [from, to] : [to, from];
  for (let i = a; i <= b; i++) {
    const item = items[i];
    if (item && isSelectable(item)) next.add(item.id);
  }
  return next;
}

/** Rectangles as { left, top, right, bottom }; touching edges don't count. */
export function rectsIntersect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Drag-select: the selection when the drag started, plus (or minus, Alt held) the items hit. */
export function applyMarquee(base, hitIds, remove) {
  const next = new Set(base);
  for (const id of hitIds) {
    if (remove) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** Whole day: if all its selectable items are selected, unselect them; else select them all. */
export function toggleDay(selected, dayItems, isSelectable) {
  const ids = dayItems.filter(isSelectable).map((i) => i.id);
  const next = new Set(selected);
  const allIn = ids.length > 0 && ids.every((id) => next.has(id));
  for (const id of ids) {
    if (allIn) next.delete(id);
    else next.add(id);
  }
  return next;
}
