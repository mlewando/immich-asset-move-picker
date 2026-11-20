// The member grid's album filter: a button that opens a searchable list of the albums holding the
// member's photos, newest first, each with when its photos were taken and how many there are.
import { h } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { Icon } from './icons.js';
import { Popover } from './popover.js';

const html = htm.bind(h);

// Album days are the photos' own (wall-clock) days: format them in UTC so they stay that day.
const fmt = (day, opts) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });

/** "3 Jul 2026", "Jul 2026", "Jul – Aug 2026" or "Dec 2025 – Jan 2026". */
export function dayRange(from, to) {
  if (from === to) return fmt(from, { day: 'numeric', month: 'short', year: 'numeric' });
  const [fy, fm] = from.split('-');
  const [ty, tm] = to.split('-');
  if (fy === ty && fm === tm) return fmt(from, { month: 'short', year: 'numeric' });
  if (fy === ty) return `${fmt(from, { month: 'short' })} – ${fmt(to, { month: 'short', year: 'numeric' })}`;
  return `${fmt(from, { month: 'short', year: 'numeric' })} – ${fmt(to, { month: 'short', year: 'numeric' })}`;
}

/** A filter's button: a chip, tinted while its filter is on. */
export const chip = (on) =>
  `flex h-9 min-w-0 items-center gap-1.5 rounded-full border px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-400 ${
    on ? 'border-sky-400/40 bg-sky-500/15 text-sky-100 hover:bg-sky-500/25' : 'border-white/10 text-neutral-200 hover:bg-white/5'
  }`;

// Case- and accent-blind ("zolw" finds "Żółw").
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();

export function AlbumPicker({ albums, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0); // highlighted option
  const button = useRef(null);
  const current = albums.find((a) => a.id === value);

  // "All photos" first, then the albums matching the search.
  const options = useMemo(() => {
    const q = fold(query.trim());
    const found = q ? albums.filter((a) => fold(a.name).includes(q)) : albums;
    return [...(q ? [] : [{ id: '', name: 'All photos' }]), ...found];
  }, [albums, query]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const pick = (id) => {
    close();
    onChange(id);
    button.current?.focus();
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = options.length;
      setHi((i) => (n ? (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n : 0));
    } else if (e.key === 'Enter' && options[hi]) {
      e.preventDefault();
      pick(options[hi].id);
    }
  };

  return html`<div class="relative flex min-w-30 max-sm:w-full">
    <button
      ref=${button}
      class=${`${chip(!!current)} max-sm:w-full sm:max-w-80`}
      aria-haspopup="dialog"
      aria-expanded=${open}
      aria-label=${current ? `Album: ${current.name}` : 'Album: all photos'}
      onClick=${() => (open ? close() : (setHi(0), setOpen(true)))}
    >
      <${Icon} name="album" class="size-4 shrink-0 opacity-70" />
      <span class="truncate max-sm:flex-1 max-sm:text-left">${current ? current.name : 'All albums'}</span>
      ${current && html`<span class="shrink-0 text-xs opacity-60">${dayRange(current.from, current.to)}</span>`}
      <${Icon} name="chevronDown" class="size-4 shrink-0 opacity-70" />
    </button>
    <${Popover} open=${open} onClose=${close} anchor=${button} label="Albums" initialFocus="input" phoneTop="top-28" class="sm:left-0 sm:w-96">
      <div class="border-b border-white/5 p-2">
        <label class="flex items-center gap-2 rounded-lg bg-white/5 px-2.5 focus-within:ring-2 focus-within:ring-sky-400">
          <${Icon} name="magnify" class="size-4 shrink-0 text-neutral-400" />
          <input
            class="w-full bg-transparent py-2 text-sm outline-none placeholder:text-neutral-500"
            placeholder=${`Search ${albums.length} album${albums.length === 1 ? '' : 's'}`}
            role="combobox"
            aria-expanded="true"
            aria-controls="album-options"
            aria-activedescendant=${options[hi] ? `album-${options[hi].id || 'all'}` : undefined}
            value=${query}
            onInput=${(e) => (setQuery(e.currentTarget.value), setHi(0))}
            onKeyDown=${onKey}
          />
        </label>
      </div>
      <ul id="album-options" role="listbox" aria-label="Albums" class="min-h-0 flex-1 overflow-y-auto py-1 sm:max-h-96">
        ${options.length === 0 && html`<li class="px-4 py-6 text-center text-sm text-neutral-500">No album matches.</li>`}
        ${options.map(
          (a, i) => html`<li
            key=${a.id || 'all'}
            id=${`album-${a.id || 'all'}`}
            role="option"
            aria-selected=${a.id === value}
            class=${`mx-1 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 ${i === hi ? 'bg-white/10' : ''}`}
            onPointerMove=${() => setHi(i)}
            onClick=${() => pick(a.id)}
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">${a.name}</span>
              ${a.from && html`<span class="block text-xs text-neutral-500">${dayRange(a.from, a.to)} • ${a.count} photo${a.count === 1 ? '' : 's'}</span>`}
            </span>
            ${a.id === value && html`<${Icon} name="check" class="size-4 shrink-0 text-sky-400" />`}
          </li>`,
        )}
      </ul>
    </${Popover}>
  </div>`;
}
