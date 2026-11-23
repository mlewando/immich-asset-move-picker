// Full-screen viewer: ←/→ (or a swipe on a touch screen) move, Space selects, Esc (or the
// browser's Back) closes. It takes the keyboard focus when it opens; the page behind is inert
// meanwhile (app.js), so Tab stays inside.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { media } from './api.js';
import { MediaBadges, StatusBadges } from './grid.js';
import { CheckCircle, Icon } from './icons.js';
import { expiry } from './expiry.js';
import { swipeStep } from './swipe.js';

const html = htm.bind(h);

const timeLabel = (iso) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-sky-400';
const roundBtn = `grid size-10 place-items-center rounded-full text-white transition-colors hover:bg-white/15 ${focusRing}`;
// Previous/next show on hover, or when focused with the keyboard. At either end they are
// aria-disabled, not disabled: a disabled button would drop the focus out of the viewer.
const navBtn = `${roundBtn} absolute top-1/2 -translate-y-1/2 bg-black/30 opacity-0 group-hover/viewer:opacity-100 focus-visible:opacity-100 aria-disabled:text-white/30 aria-disabled:hover:bg-black/30`;

export function Viewer({ items, index, selected, isSelectable, onClose, onNav, onToggle }) {
  const item = items[index];
  const [playLive, setPlayLive] = useState(false);
  useEffect(() => setPlayLive(false), [item?.id]);

  // The focus goes to the viewer itself, not to a button: Space and Enter must not press one
  // by accident. Also when moving to another photo removes the focused button (Play LIVE, Select).
  const root = useRef(null);
  useEffect(() => {
    if (!root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true });
  }, [item?.id]);
  // A button clicked with the mouse must not keep the focus, or the next Space would press it
  // again instead of selecting. A click made with the keyboard has detail 0 and stays put.
  const onClick = (e) => e.detail > 0 && root.current.focus({ preventScroll: true });

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
      // Space on a focused button presses that button, nothing more.
      else if (e.key === ' ' && isSelectable(item) && !e.target.closest('button')) {
        e.preventDefault();
        onToggle(item.id);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [item, onClose, onNav, onToggle, isSelectable]);

  // Touch: a horizontal swipe moves between photos. A 2nd finger (pinch) cancels it; a swipe that
  // starts on a video is left to its seek bar.
  const touch = useRef({ id: null, x: 0, y: 0, ok: false }); // the finger that went down first
  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse') return;
    const t = touch.current;
    if (t.id !== null) {
      t.ok = false; // a 2nd finger: a pinch, not a swipe
      return;
    }
    Object.assign(t, { id: e.pointerId, x: e.clientX, y: e.clientY, ok: !e.target.closest('video, button') });
  };
  const onPointerEnd = (e) => {
    const t = touch.current;
    if (e.pointerId !== t.id) return;
    t.id = null;
    if (t.ok && e.type === 'pointerup') {
      const step = swipeStep(e.clientX - t.x, e.clientY - t.y);
      if (step) onNav(step);
    }
  };

  if (!item) return null;
  const isSelected = selected.has(item.id);
  const fit = 'max-h-full max-w-full object-contain';
  let body;
  if (item.type === 'video') {
    body = html`<video key=${item.id} class=${fit} src=${media.video(item.id)} poster=${media.preview(item.id)} controls autoplay onError=${expiry.check} />`;
  } else if (item.livePhotoVideoId && playLive) {
    body = html`<video key=${`live-${item.id}`} class=${fit} src=${media.video(item.livePhotoVideoId)} autoplay muted onEnded=${() => setPlayLive(false)} onError=${expiry.check} />`;
  } else {
    body = html`<img key=${item.id} class=${fit} src=${media.preview(item.id)} alt=${item.fileName} onError=${expiry.check} />`;
  }

  return html`
    <div ref=${root} tabindex="-1" class="group/viewer fixed inset-0 z-50 touch-pan-y touch-pinch-zoom bg-black outline-none" role="dialog" aria-modal="true" aria-label=${item.fileName} onClick=${onClick} onPointerDown=${onPointerDown} onPointerUp=${onPointerEnd} onPointerCancel=${onPointerEnd}>
      <div class="absolute inset-0 flex items-center justify-center p-2 pt-16">${body}</div>

      <div class="absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/80 to-transparent px-3 py-2">
        <button class=${roundBtn} onClick=${onClose} aria-label="Close" title="Close (Esc)"><${Icon} name="close" class="size-6" /></button>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium text-white">${item.fileName}</div>
          <div class="text-xs text-neutral-400">${timeLabel(item.localDateTime)} • ${index + 1} of ${items.length}</div>
        </div>
        <div class="flex gap-1"><${MediaBadges} item=${item} /><${StatusBadges} item=${item} /></div>
        ${item.livePhotoVideoId &&
        html`<button
          class=${`inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20 ${focusRing}`}
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
        class=${`${navBtn} left-3`}
        onClick=${() => onNav(-1)} aria-disabled=${index === 0} aria-label="Previous"
      ><${Icon} name="chevronLeft" class="size-7" /></button>
      <button
        class=${`${navBtn} right-3`}
        onClick=${() => onNav(1)} aria-disabled=${index === items.length - 1} aria-label="Next"
      ><${Icon} name="chevronRight" class="size-7" /></button>
    </div>`;
}
