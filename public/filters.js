// The member grid's filters: the album (a chip opening its list), the days taken (2 date fields)
// and Clear. 1 row; on a phone the album gets its own full-width line, the days the next.
import { h } from 'preact';
import { useRef } from 'preact/hooks';
import htm from 'htm';
import { AlbumPicker } from './albums.js';
import { Icon } from './icons.js';

const html = htm.bind(h);

const dateField = (on) =>
  `h-9 rounded-full border px-3 max-sm:min-w-0 max-sm:flex-1 max-sm:px-2.5 text-sm [color-scheme:dark] outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
    on ? 'border-sky-400/40 bg-sky-500/15 text-sky-100' : 'border-white/10 bg-transparent text-neutral-200'
  }`;

export function FilterBar({ albums, filter, onChange }) {
  const active = filter.album || filter.from || filter.to;
  const set = (k) => (e) => onChange({ ...filter, [k]: e.currentTarget.value });
  const fromField = useRef(null);
  // Clear removes itself: by keyboard (a click with detail 0) the focus goes to the From day
  // field rather than the page top. Not on a tap: a focused date field may open its picker.
  const clear = (e) => {
    onChange({ album: '', from: '', to: '' });
    if (e.detail === 0) fromField.current?.focus();
  };
  return html`
    <div
      class="flex flex-wrap items-center gap-2 border-b border-white/5 px-2 py-2 sm:px-4"
      role="group"
      aria-label="Filters"
    >
      ${(albums.length > 0 || filter.album) &&
      html`<${AlbumPicker} albums=${albums} value=${filter.album} onChange=${(album) => onChange({ ...filter, album })} />`}
      <div class="flex min-w-0 items-center gap-1.5 max-sm:flex-1" role="group" aria-label="Days taken">
        <${Icon} name="clock" class="hidden size-4 shrink-0 text-neutral-400 sm:block" />
        <input ref=${fromField} type="date" class=${dateField(!!filter.from)} value=${filter.from} max=${filter.to || undefined} onChange=${set('from')} aria-label="From day" title="From day" />
        <span class="text-neutral-400" aria-hidden="true">–</span>
        <input type="date" class=${dateField(!!filter.to)} value=${filter.to} min=${filter.from || undefined} onChange=${set('to')} aria-label="To day" title="To day" />
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
