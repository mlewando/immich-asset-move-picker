// Move to family: which family album the photos go into. A searchable list of the family's albums
// (cover, name, when, how many), a typed name no album has becomes a new album, and, rarely, no
// album at all. When the grid is filtered by a member's album, it also offers to delete that album
// once all its photos are moved. A native modal <dialog>, as ConfirmDialog.
import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { albumOptions, chosenIndex, fieldKey, preselectedAlbum } from './albumchoice.js';
import { dayRange } from './albums.js';
import { api, media } from './api.js';
import { Icon } from './icons.js';
import { Thumb } from './thumb.js';

const html = htm.bind(h);

const LAST_ALBUM_KEY = 'picker.lastAlbum';
const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-sky-400';
const btn = `rounded-full px-4 py-1.5 text-sm font-semibold ${focusRing}`;

export function rememberAlbum(id) {
  try {
    localStorage.setItem(LAST_ALBUM_KEY, id);
  } catch {
    /* private mode: just don't remember */
  }
}
function lastAlbum() {
  try {
    return localStorage.getItem(LAST_ALBUM_KEY);
  } catch {
    return null;
  }
}

const photos = (n) => `${n} photo${n === 1 ? '' : 's'}`;

function Option({ option, chosen, id, onPick }) {
  const row = `mx-1 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 ${chosen ? 'bg-sky-500/15 ring-1 ring-inset ring-sky-400/40' : 'hover:bg-white/5'}`;
  if (option.kind === 'new') {
    return html`<li id=${id} role="option" aria-selected=${chosen} class=${row} onClick=${onPick}>
      <span class="grid size-12 shrink-0 place-items-center rounded-md border border-dashed border-sky-400/50 text-sky-300" aria-hidden="true">
        <${Icon} name="plus" class="size-6" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm">New album «${option.name}»</span>
        <span class="block text-xs text-sky-200">Will be created before moving</span>
      </span>
      ${chosen && html`<${Icon} name="check" class="size-4 shrink-0 text-sky-400" />`}
    </li>`;
  }
  const a = option.album;
  return html`<li id=${id} role="option" aria-selected=${chosen} class=${row} onClick=${onPick}>
    ${a.coverId
      ? html`<${Thumb} src=${media.thumbnail(a.coverId)} class="size-12 shrink-0 overflow-hidden rounded-md bg-neutral-800" loading="lazy" />`
      : html`<span class="grid size-12 shrink-0 place-items-center rounded-md bg-neutral-800 text-neutral-500" aria-hidden="true"><${Icon} name="album" class="size-6" /></span>`}
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm">${a.name}</span>
      <span class="block text-xs text-neutral-400">${a.from ? `${dayRange(a.from, a.to)} • ${photos(a.count)}` : 'Empty'}</span>
    </span>
    ${chosen && html`<${Icon} name="check" class="size-4 shrink-0 text-sky-400" />`}
  </li>`;
}

/**
 * Mount it to open it. count: the photos to move. source: the member's album the grid is filtered
 * by ({ id, name, ownerName }), else null. nearAlbumId: the family album the grid is near, chosen
 * at first. onConfirm({ album, deleteAlbumId }): album is { id }, { name } (to create) or null (no
 * album). The page unmounts it after onConfirm or onCancel.
 */
export function MoveDialog({ count, source, nearAlbumId, onConfirm, onCancel }) {
  const box = useRef(null);
  const list = useRef(null);
  const moveButton = useRef(null);
  const opener = useRef(document.activeElement);
  const [albums, setAlbums] = useState(null); // null while loading
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(-1);
  const [deleteSource, setDeleteSource] = useState(true);
  const last = useMemo(() => preselectedAlbum(nearAlbumId, lastAlbum()), []);

  useEffect(() => {
    box.current?.showModal();
    api.familyAlbums().then(setAlbums, (e) => (setAlbums([]), setError(e.message)));
    return () => {
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);

  const options = useMemo(() => albumOptions(albums ?? [], query), [albums, query]);
  useEffect(() => setIndex(chosenIndex(options, query, last)), [options]);
  // The chosen row stays in view while the arrow keys move it.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const chosen = options[index] ?? null;
  const deleteAlbumId = source && deleteSource ? source.id : undefined;
  const confirm = (album) => onConfirm({ album, deleteAlbumId });
  const confirmChosen = () => {
    if (!chosen) return;
    confirm(chosen.kind === 'new' ? { name: chosen.name } : { id: chosen.album.id });
  };
  const onKey = (e) => {
    const action = fieldKey(e.key, index, options.length);
    if (action === null) return;
    // Also keeps this Enter from reaching the Move button it focuses.
    e.preventDefault();
    if (action === 'pick') moveButton.current?.focus();
    else if (action !== 'none') setIndex(action.index);
  };

  const label = !chosen
    ? 'Move'
    : chosen.kind === 'new'
      ? `Create «${chosen.name}» and move`
      : `Move to «${chosen.album.name}»`;
  const owner = source?.ownerName ? `${source.ownerName}’s album` : 'album';

  return html`<dialog
    ref=${box}
    class="m-auto flex h-[min(85vh,38rem)] w-[32rem] max-w-[94vw] flex-col rounded-2xl border border-white/10 bg-neutral-900 p-0 text-neutral-100 shadow-2xl backdrop:bg-black/60"
    aria-labelledby="move-title"
    onCancel=${(e) => {
      e.preventDefault();
      onCancel();
    }}
    onClick=${(e) => e.target === e.currentTarget && onCancel()}
  >
    <div class="flex min-h-0 flex-1 flex-col p-5">
      <h2 id="move-title" class="text-base font-semibold">Move ${photos(count)} to family</h2>
      <p class="mt-1 text-sm text-neutral-300">Into which family album?</p>
      <label class="mt-3 flex items-center gap-2 rounded-lg bg-white/5 px-2.5 focus-within:ring-2 focus-within:ring-sky-400">
        <${Icon} name="magnify" class="size-4 shrink-0 text-neutral-400" />
        <input
          class="w-full bg-transparent py-2 text-sm outline-none placeholder:text-neutral-400"
          placeholder="Search albums or type a new name"
          aria-label="Album"
          role="combobox"
          aria-expanded="true"
          aria-controls="move-albums"
          aria-activedescendant=${chosen ? `move-album-${index}` : undefined}
          autofocus
          maxlength="200"
          value=${query}
          onInput=${(e) => setQuery(e.currentTarget.value)}
          onKeyDown=${onKey}
        />
      </label>
      <ul ref=${list} id="move-albums" role="listbox" aria-label="Family albums" class="mt-2 min-h-24 flex-1 overflow-y-auto py-1">
        ${albums === null && html`<li class="px-4 py-6 text-center text-sm text-neutral-400">Loading albums…</li>`}
        ${error && html`<li class="px-4 py-3 text-sm text-rose-300" role="alert">${error}</li>`}
        ${albums !== null && !error && options.length === 0 &&
        html`<li class="px-4 py-6 text-center text-sm text-neutral-400">No family albums yet: type a name to create one.</li>`}
        ${options.map(
          (o, i) => html`<${Option}
            key=${o.kind === 'new' ? 'new' : o.album.id}
            id=${`move-album-${i}`}
            option=${o}
            chosen=${i === index}
            onPick=${() => setIndex(i)}
          />`,
        )}
      </ul>
      ${source &&
      html`<label class="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg bg-white/5 px-3 py-2.5 text-sm">
        <input type="checkbox" class="mt-0.5 size-4 shrink-0 accent-sky-500" checked=${deleteSource} onChange=${(e) => setDeleteSource(e.currentTarget.checked)} />
        <span>
          Delete ${owner} «${source.name}» when all its photos are moved
          <span class="block text-xs text-neutral-400">Its sharing, shared links and comments go with it. Give back doesn’t bring it back.</span>
        </span>
      </label>`}
      <div class="mt-4 flex flex-wrap items-center gap-2">
        <button class=${`mr-auto rounded px-1 text-xs text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline ${focusRing}`} onClick=${() => confirm(null)}>
          Move without album
        </button>
        <button class=${`${btn} text-neutral-200 hover:bg-white/10`} onClick=${onCancel}>Cancel</button>
        <button
          ref=${moveButton}
          class=${`${btn} max-w-64 truncate focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900 bg-sky-500 text-white hover:bg-sky-400 disabled:opacity-40 disabled:hover:bg-sky-500`}
          disabled=${!chosen}
          title=${chosen ? label : 'Pick an album or type a name for a new one'}
          onClick=${confirmChosen}
        >
          ${label}
        </button>
      </div>
    </div>
  </dialog>`;
}
