// Full-screen viewer: ←/→ move, Space selects, Esc (or the browser's Back) closes.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { media } from './api.js';
import { MediaBadges, StatusBadges } from './grid.js';
import { CheckCircle, Icon } from './icons.js';

const html = htm.bind(h);

const timeLabel = (iso) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

const roundBtn = 'grid size-10 place-items-center rounded-full text-white transition-colors hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-transparent';

export function Viewer({ items, index, selected, isSelectable, onClose, onNav, onToggle }) {
  const item = items[index];
  const [playLive, setPlayLive] = useState(false);
  useEffect(() => setPlayLive(false), [item?.id]);

  // The grid behind must not scroll (or show its scrollbar) while the viewer is open.
  useEffect(() => {
    document.documentElement.classList.add('overflow-hidden');
    return () => document.documentElement.classList.remove('overflow-hidden');
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onNav(-1);
      else if (e.key === 'ArrowRight') onNav(1);
      else if (e.key === ' ' && isSelectable(item)) {
        e.preventDefault();
        onToggle(item.id);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [item, onClose, onNav, onToggle, isSelectable]);

  if (!item) return null;
  const isSelected = selected.has(item.id);
  const fit = 'max-h-full max-w-full object-contain';
  let body;
  if (item.type === 'video') {
    body = html`<video key=${item.id} class=${fit} src=${media.video(item.id)} poster=${media.preview(item.id)} controls autoplay />`;
  } else if (item.livePhotoVideoId && playLive) {
    body = html`<video key=${`live-${item.id}`} class=${fit} src=${media.video(item.livePhotoVideoId)} autoplay muted onEnded=${() => setPlayLive(false)} />`;
  } else {
    body = html`<img key=${item.id} class=${fit} src=${media.preview(item.id)} alt=${item.fileName} />`;
  }

  return html`
    <div class="group/viewer fixed inset-0 z-50 bg-black" role="dialog" aria-modal="true" aria-label=${item.fileName}>
      <div class="absolute inset-0 flex items-center justify-center p-2 pt-16">${body}</div>

      <div class="absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/80 to-transparent px-3 py-2">
        <button class=${roundBtn} onClick=${onClose} aria-label="Close" title="Close (Esc)"><${Icon} name="close" class="size-6" /></button>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium text-white">${item.fileName}</div>
          <div class="text-xs text-neutral-400">${timeLabel(item.localDateTime)} · ${index + 1} of ${items.length}</div>
        </div>
        <div class="flex gap-1"><${MediaBadges} item=${item} /><${StatusBadges} item=${item} /></div>
        ${item.livePhotoVideoId &&
        html`<button
          class="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
          onClick=${() => setPlayLive(!playLive)}
        ><${Icon} name=${playLive ? 'stop' : 'play'} class="size-4" />${playLive ? 'Still' : 'Play LIVE'}</button>`}
        ${isSelectable(item) &&
        html`<button
          class=${roundBtn}
          aria-pressed=${isSelected}
          aria-label=${isSelected ? 'Unselect' : 'Select'}
          title=${`${isSelected ? 'Unselect' : 'Select'} (Space)`}
          onClick=${() => onToggle(item.id)}
        ><${CheckCircle} on=${isSelected} class="size-7" /></button>`}
      </div>

      <button
        class=${`${roundBtn} absolute left-3 top-1/2 -translate-y-1/2 bg-black/30 opacity-0 group-hover/viewer:opacity-100`}
        onClick=${() => onNav(-1)} disabled=${index === 0} aria-label="Previous"
      ><${Icon} name="chevronLeft" class="size-7" /></button>
      <button
        class=${`${roundBtn} absolute right-3 top-1/2 -translate-y-1/2 bg-black/30 opacity-0 group-hover/viewer:opacity-100`}
        onClick=${() => onNav(1)} disabled=${index === items.length - 1} aria-label="Next"
      ><${Icon} name="chevronRight" class="size-7" /></button>
    </div>`;
}
