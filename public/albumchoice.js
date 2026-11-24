// What the Move dialog offers for a typed album name (pure, unit-tested in test/albumchoice.test.ts).

// Case- and accent-blind ("zolw" finds "Żółw").
export const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();

// Immich's own name check: letter case and spaces around it don't make a different album.
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The options for what is typed: { kind: 'album', album } for each family album matching it, and
 * first { kind: 'new', name } when no album has exactly that name, so "Trip" can still be created
 * while "Trip 2024" exists. An album with exactly that name comes first instead. Nothing typed:
 * every album, as listed (most recently updated first).
 */
export function albumOptions(albums, query) {
  const name = query.trim();
  if (!name) return albums.map((album) => ({ kind: 'album', album }));
  const q = fold(name);
  const matches = albums.filter((a) => fold(a.name).includes(q));
  const exact = matches.filter((a) => same(a.name, name));
  if (exact.length) return [...exact, ...matches.filter((a) => !exact.includes(a))].map((album) => ({ kind: 'album', album }));
  return [{ kind: 'new', name }, ...matches.map((album) => ({ kind: 'album', album }))];
}

/**
 * A key in the album field, with option `index` chosen of `n`: the arrows move the choice (round),
 * Enter picks it ('pick': focus goes to the Move button, so a 2nd Enter moves; never at once, as a
 * typo would create an album); Enter with nothing chosen does nothing ('none'). null: the key is
 * the field's own.
 */
export function fieldKey(key, index, n) {
  if ((key === 'ArrowDown' || key === 'ArrowUp') && n) {
    return { index: key === 'ArrowDown' ? (index + 1) % n : index <= 0 ? n - 1 : index - 1 };
  }
  if (key === 'Enter') return index >= 0 && index < n ? 'pick' : 'none';
  return null;
}

/**
 * The option chosen when the list changes: with nothing typed, the album last moved into (if it
 * still exists), else none (-1); with a name typed, the 1st option.
 */
export function chosenIndex(options, query, lastAlbumId) {
  if (query.trim()) return options.length ? 0 : -1;
  return options.findIndex((o) => o.kind === 'album' && o.album.id === lastAlbumId);
}
