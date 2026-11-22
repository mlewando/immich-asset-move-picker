// Arrow-key moves in the timeline grid (pure, no DOM), unit-tested in test/gridnav.test.ts.
// The grid is days of photos, each day maybe headed by its "select this day" button; photos fill
// `cols` columns row by row. The DOM has no rows (CSS auto-fill), so rows are worked out here.

/**
 * days: [{ count, head }] in grid order (photos in the day, whether it has a day button).
 * pos: { day, at }, at = 'head' (the day button) or the photo's position in its day.
 * Returns the next pos, or the same one when there is nowhere to go.
 */
export function moveFocus(days, cols, pos, key) {
  const { day, at } = pos;
  const last = days.length - 1;
  const lastRowStart = (d) => Math.floor((days[d].count - 1) / cols) * cols;
  // Column `col` of a row starting at `start`, or the row's last photo when it is shorter.
  const inRow = (d, start, col) => Math.min(start + col, days[d].count - 1);

  if (key === 'Home') return { day: 0, at: 0 };
  if (key === 'End') return { day: last, at: days[last].count - 1 };

  if (at === 'head') {
    if (key === 'ArrowDown') return { day, at: 0 };
    if (key === 'ArrowUp' && day > 0) return { day: day - 1, at: lastRowStart(day - 1) };
    return pos;
  }

  const col = at % cols;
  switch (key) {
    case 'ArrowRight':
      if (at + 1 < days[day].count) return { day, at: at + 1 };
      return day < last ? { day: day + 1, at: 0 } : pos;
    case 'ArrowLeft':
      if (at > 0) return { day, at: at - 1 };
      return day > 0 ? { day: day - 1, at: days[day - 1].count - 1 } : pos;
    case 'ArrowDown':
      if (at < lastRowStart(day)) return { day, at: Math.min(at + cols, days[day].count - 1) };
      if (day === last) return pos;
      return days[day + 1].head ? { day: day + 1, at: 'head' } : { day: day + 1, at: inRow(day + 1, 0, col) };
    case 'ArrowUp':
      if (at >= cols) return { day, at: at - cols };
      if (days[day].head) return { day, at: 'head' };
      return day > 0 ? { day: day - 1, at: inRow(day - 1, lastRowStart(day - 1), col) } : pos;
    default:
      return pos;
  }
}
