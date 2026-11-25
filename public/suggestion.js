// A thin note above a member's grid naming the family album their photos most likely still belong
// in (the server picks it): Show filters the grid near it, Skip passes it over for the next one
// (remembered per member in this browser).
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { dayRange } from './albums.js';
import { api } from './api.js';
import { Icon } from './icons.js';
import { skipAlbum, skippedAlbums } from './near.js';

const html = htm.bind(h);

/** The error of a grid filtered near a family album that no longer exists (src/server.ts). */
export const NO_SUCH_ALBUM = 'no such album';

const link = 'rounded-full px-2.5 py-0.5 font-semibold text-sky-300 outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-sky-400';

/**
 * items: the grid's photos; asked again whenever they change (loaded, refreshed after jobs, some
 * queued), so the count follows what is still to move. onShow(albumId).
 */
export function SuggestionNote({ memberId, familyAlbums, items, onShow }) {
  const [suggestion, setSuggestion] = useState(null);
  const [skips, setSkips] = useState(0); // bumped by Skip: ask again
  useEffect(() => {
    let live = true;
    api.suggestion(memberId, skippedAlbums(memberId), { poll: true }).then(
      (r) => live && setSuggestion(r.suggestion),
      () => live && setSuggestion(null),
    );
    return () => {
      live = false;
    };
  }, [memberId, items, skips]);

  const album = suggestion && familyAlbums.find((a) => a.id === suggestion.albumId);
  if (!album) return null;
  const n = suggestion.count;
  return html`<div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-white/5 bg-sky-500/5 px-3 py-1.5 text-sm text-neutral-300 sm:px-4" role="status">
    <${Icon} name="family" class="size-4 shrink-0 text-sky-300" />
    <span class="min-w-0">
      ${n} photo${n === 1 ? '' : 's'} fall${n === 1 ? 's' : ''} within «${album.name}» (${dayRange(album.from, album.to)})
    </span>
    <span class="flex gap-1">
      <button class=${link} onClick=${() => onShow(album.id)}>Show</button>
      <button
        class=${link}
        title="Suggest another album"
        onClick=${() => {
          skipAlbum(memberId, album.id);
          setSuggestion(null);
          setSkips((k) => k + 1);
        }}
      >Skip</button>
    </span>
  </div>`;
}
