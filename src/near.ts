// "Near a family album": which of a member's days belong with a family album, and which family
// album a member's timeline most likely still has photos for. Days are YYYY-MM-DD wall-clock days
// (localDateTime), the grid's own.
import type { FamilyAlbum, GridItem } from './immich/index.ts';

export type DayRange = { from: string; to: string };

/** Most days a window reaches past its album, either way. */
export const MAX_SURROUND_DAYS = 30;

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * The days to show near an album: its first to last photo day, widened by `before` days and
 * `after` days. Null for an empty album. The only place that decides an album's days: a finer
 * rule (e.g. ignoring a lone stray photo) changes this function alone.
 */
export function albumWindow(album: Pick<FamilyAlbum, 'from' | 'to'>, before: number, after: number): DayRange | null {
  if (!album.from || !album.to) return null;
  return { from: addDays(album.from, -before), to: addDays(album.to, after) };
}

/** Days in both ranges; a missing bound is open. Null when they don't overlap. */
export function intersect(a: Partial<DayRange>, b: DayRange): DayRange | null {
  const from = a.from && a.from > b.from ? a.from : b.from;
  const to = a.to && a.to < b.to ? a.to : b.to;
  return from <= to ? { from, to } : null;
}

/**
 * The family album a member's photos most likely still belong in: of the albums not skipped, the
 * one with the latest last photo day whose own days (no surround) hold at least 1 of these items
 * the family account doesn't have yet. count = those items. Null when there is none.
 */
export function suggestAlbum(
  albums: FamilyAlbum[],
  items: Pick<GridItem, 'day' | 'inFamily'>[],
  skip: ReadonlySet<string> = new Set(),
): { album: FamilyAlbum; count: number } | null {
  const days = items.filter((i) => !i.inFamily).map((i) => i.day);
  const candidates = albums
    .filter((a) => a.from && a.to && !skip.has(a.id))
    .sort((a, b) => (a.to! < b.to! ? 1 : a.to! > b.to! ? -1 : a.id < b.id ? -1 : 1));
  for (const album of candidates) {
    const count = days.filter((d) => d >= album.from! && d <= album.to!).length;
    if (count) return { album, count };
  }
  return null;
}
