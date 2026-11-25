// "Near a family album" on a member's grid: where its 2 dividers go and what they say, the
// before/after days remembered for the next pick, and the albums the user skipped as suggestions.
// The days themselves are the server's (src/near.ts); the dividers mark the album's own days.
// Pure parts unit-tested in test/near-client.test.ts.

/** Most days before/after (the server's MAX_SURROUND_DAYS). */
export const MAX_SURROUND = 30;
export const DEFAULT_SURROUND = { before: 2, after: 2 };

/** A before/after value from the URL or a field: a whole number of days, 0..MAX_SURROUND. */
export function surroundDays(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_SURROUND) : 0;
}

/**
 * Where the dividers go among the grid's days (newest first): before group `ends` the album's
 * "end" divider, before group `starts` its "start" one (= groups.length: after the last day).
 * after / inside / before: whether that part of the window has photos.
 */
export function dividers(days, album) {
  const ends = firstIndex(days, (d) => d <= album.to);
  const starts = firstIndex(days, (d) => d < album.from);
  return { ends, starts, after: ends > 0, inside: starts > ends, before: starts < days.length };
}
const firstIndex = (list, ok) => {
  const i = list.findIndex(ok);
  return i < 0 ? list.length : i;
};

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

/** The dividers' text; a part of the window without photos says so. */
export function dividerLabels(name, { before, after }, d) {
  const ends = [`End of «${name}»`];
  if (!d.after && after > 0) ends.push(`no photos in the ${days(after)} after`);
  if (!d.inside) ends.push('no photos on its own days');
  const starts = [`Start of «${name}»`];
  if (!d.before && before > 0) starts.push(`no photos in the ${days(before)} before`);
  return { end: ends.join(' · '), start: starts.join(' · ') };
}

/** The surround in words: "±2 days", "1 day before, 3 days after". */
export function surroundText({ before, after }) {
  if (!before && !after) return 'its own days only';
  if (before === after) return `±${days(before)}`;
  return `${days(before)} before, ${days(after)} after`;
}

// --- remembered per browser --------------------------------------------------------------------
const SURROUND_KEY = 'picker.nearDays';
const skipKey = (memberId) => `picker.skippedAlbums.${memberId}`;

const read = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null; // private mode or garbage: nothing remembered
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: just don't remember */
  }
};

/** The before/after days last used, for the next album picked. */
export function lastSurround() {
  const v = read(SURROUND_KEY);
  return v ? { before: surroundDays(v.before), after: surroundDays(v.after) } : DEFAULT_SURROUND;
}
export const rememberSurround = (s) => write(SURROUND_KEY, { before: s.before, after: s.after });

/** Family albums the user passed over as a suggestion for this member. */
export function skippedAlbums(memberId) {
  const v = read(skipKey(memberId));
  return Array.isArray(v) ? v.filter((id) => typeof id === 'string') : [];
}
export const skipAlbum = (memberId, albumId) => write(skipKey(memberId), [...new Set([...skippedAlbums(memberId), albumId])]);
