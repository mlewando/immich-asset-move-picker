// The member grid's filters: the member's album, the family album to show photos near (with how
// many days before and after it), the days taken (2 date fields) and Clear. They all apply
// together. On a phone each album gets its own full-width line, the days the next.
import { h } from 'preact';
import { useRef } from 'preact/hooks';
import htm from 'htm';
import { AlbumSelect } from './albums.js';
import { Icon } from './icons.js';
import { lastSurround, MAX_SURROUND, rememberSurround, surroundDays } from './near.js';

const html = htm.bind(h);

const field = (on) =>
  `h-9 rounded-full border px-3 max-sm:min-w-0 max-sm:flex-1 max-sm:px-2.5 text-sm [color-scheme:dark] outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
    on ? 'border-sky-400/40 bg-sky-500/15 text-sky-100' : 'border-white/10 bg-transparent text-neutral-200'
  }`;

export const NO_FILTER = { album: '', from: '', to: '', near: '', before: 0, after: 0 };

/**
 * The filter for photos near a family album ('' : none): the before/after days last used, and the
 * day fields cleared (the album's days replace them; they can be set again after).
 */
export function nearFilter(filter, albumId) {
  if (!albumId) return { ...filter, near: '', before: 0, after: 0 };
  return { ...filter, ...lastSurround(), near: albumId, from: '', to: '' };
}

/** familyAlbums: the family albums with photos (an empty one has no days to be near). */
export function FilterBar({ albums, familyAlbums, filter, onChange }) {
  const active = filter.album || filter.from || filter.to || filter.near;
  const set = (k) => (e) => onChange({ ...filter, [k]: e.currentTarget.value });
  const setDays = (k) => (e) => {
    const next = { ...filter, [k]: surroundDays(e.currentTarget.value) };
    rememberSurround(next);
    onChange(next);
  };
  const fromField = useRef(null);
  // Clear removes itself: by keyboard (a click with detail 0) the focus goes to the From day
  // field rather than the page top. Not on a tap: a focused date field may open its picker.
  const clear = (e) => {
    onChange(NO_FILTER);
    if (e.detail === 0) fromField.current?.focus();
  };
  const daysField = (k, label) => html`<input
    type="number"
    inputmode="numeric"
    min="0"
    max=${MAX_SURROUND}
    class=${`${field(filter[k] > 0)} w-16 max-sm:w-auto text-center`}
    value=${filter[k]}
    onChange=${setDays(k)}
    aria-label=${label}
    title=${label}
  />`;
  return html`
    <div
      class="flex flex-wrap items-center gap-2 border-b border-white/5 px-2 py-2 sm:px-4"
      role="group"
      aria-label="Filters"
    >
      ${(albums.length > 0 || filter.album) &&
      html`<${AlbumSelect}
        albums=${albums}
        value=${filter.album}
        onChange=${(album) => onChange({ ...filter, album })}
        name="Album"
        none="All albums"
        all="All photos"
        idPrefix="album"
      />`}
      ${(familyAlbums.length > 0 || filter.near) &&
      html`<${AlbumSelect}
        albums=${familyAlbums}
        value=${filter.near}
        onChange=${(id) => onChange(nearFilter(filter, id))}
        name="Near family album"
        none="Near family album"
        all="Any days"
        idPrefix="near"
        icon="family"
      />`}
      ${filter.near &&
      html`<div class="flex min-w-0 items-center gap-1.5 max-sm:w-full" role="group" aria-label="Days around the family album">
        <span class="text-sm text-neutral-400">−</span>
        ${daysField('before', 'Days before the album')}
        <span class="text-sm text-neutral-400">+</span>
        ${daysField('after', 'Days after the album')}
        <span class="text-sm text-neutral-400">days</span>
      </div>`}
      <div class="flex min-w-0 items-center gap-1.5 max-sm:flex-1" role="group" aria-label="Days taken">
        <${Icon} name="clock" class="hidden size-4 shrink-0 text-neutral-400 sm:block" />
        <input ref=${fromField} type="date" class=${field(!!filter.from)} value=${filter.from} max=${filter.to || undefined} onChange=${set('from')} aria-label="From day" title="From day" />
        <span class="text-neutral-400" aria-hidden="true">–</span>
        <input type="date" class=${field(!!filter.to)} value=${filter.to} min=${filter.from || undefined} onChange=${set('to')} aria-label="To day" title="To day" />
      </div>
      ${active &&
      html`<button
        class="flex h-9 shrink-0 items-center gap-1 rounded-full px-2.5 text-sm text-sky-300 outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-sky-400"
        onClick=${clear}
        aria-label="Clear filters"
        title="Clear filters"
      ><${Icon} name="close" class="size-4" /><span class="hidden sm:inline">Clear</span></button>`}
    </div>`;
}
