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
import { dragOffset, swipeStep } from './swipe.js';

const html = htm.bind(h);

const timeLabel = (iso) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-sky-400';
const roundBtn = `grid size-10 place-items-center rounded-full text-white transition-colors hover:bg-white/15 ${focusRing}`;
// Previous/next show on hover, or when focused with the keyboard. At either end they are
// aria-disabled, not disabled: a disabled button would drop the focus out of the viewer.
const navBtn = `${roundBtn} absolute top-1/2 -translate-y-1/2 bg-black/30 opacity-0 group-hover/viewer:opacity-100 focus-visible:opacity-100 aria-disabled:text-white/30 aria-disabled:hover:bg-black/30`;

// A slide between photos; none for people who ask for less motion.
const SLIDE_MS = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220;

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

  // Moving between photos slides. The photos sit side by side (previous, this, next), shifted by
  // `px` while a finger drags or a slide runs. The shift belongs to the index it was set at: once
  // the route moves on to the next photo it counts as 0 in that very render, so the new photo is
  // in place without a jump or a second animation.
  const [shift, setShift] = useState(null); // { index, px, anim }
  const cur = shift?.index === index ? shift : null;
  const timer = useRef(0);
  const latest = useRef(index); // the index now, for a timer that outlives a render
  latest.current = index;
  useEffect(() => () => clearTimeout(timer.current), []); // closed mid-slide: no late navigation
  const slideTo = (step) => {
    if (cur?.anim || index + step < 0 || index + step >= items.length) return;
    setShift({ index, px: -step * root.current.clientWidth, anim: true });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onNav(step);
      // If the route did not follow, don't stay half way.
      timer.current = setTimeout(() => latest.current === index && setShift(null), 300);
    }, SLIDE_MS);
  };
  // Back to where it was; the shift is dropped once that has run (it blocks the next slide until).
  const settle = () => {
    setShift({ index, px: 0, anim: true });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShift(null), SLIDE_MS);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') slideTo(-1);
      else if (e.key === 'ArrowRight') slideTo(1);
      // Space on a focused button presses that button, nothing more.
      else if (e.key === ' ' && isSelectable(item) && !e.target.closest('button')) {
        e.preventDefault();
        onToggle(item.id);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [item, onClose, onNav, onToggle, isSelectable, cur]);

  // Touch: the photos follow the finger; letting go slides to the next or previous one, or back.
  // A 2nd finger (pinch) cancels it; a swipe that starts on a video or a button is left alone.
  const touch = useRef({ id: null, x: 0, y: 0, time: 0, ok: false, dragging: false }); // the finger that went down first
  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' || cur?.anim) return;
    const t = touch.current;
    if (t.id !== null) {
      // a 2nd finger: a pinch, not a swipe
      t.ok = false;
      if (t.dragging) settle();
      t.dragging = false;
      return;
    }
    Object.assign(t, { id: e.pointerId, x: e.clientX, y: e.clientY, time: e.timeStamp, ok: !e.target.closest('video, button'), dragging: false });
  };
  const onPointerMove = (e) => {
    const t = touch.current;
    if (e.pointerId !== t.id || !t.ok) return;
    const dx = e.clientX - t.x;
    // Only a mostly horizontal move is a drag; a vertical one is the browser's.
    if (!t.dragging && (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(e.clientY - t.y))) return;
    t.dragging = true;
    setShift({ index, px: dragOffset(dx, index > 0, index < items.length - 1), anim: false });
  };
  const onPointerEnd = (e) => {
    const t = touch.current;
    if (e.pointerId !== t.id) return;
    t.id = null;
    if (!t.dragging) return;
    t.dragging = false;
    const step = e.type === 'pointerup' && t.ok ? swipeStep(e.clientX - t.x, e.clientY - t.y, root.current.clientWidth, e.timeStamp - t.time) : 0;
    if (step && index + step >= 0 && index + step < items.length) slideTo(step);
    else settle();
  };

  if (!item) return null;
  const isSelected = selected.has(item.id);
  const fit = 'max-h-full max-w-full object-contain';
  const px = cur?.px ?? 0;
  // The photo itself; the neighbours are only pictures (a video shows its poster, nothing plays).
  const slide = (it, at) => {
    let body;
    if (at !== 0) {
      body = html`<img class=${fit} src=${media.preview(it.id)} alt="" />`;
    } else if (it.type === 'video') {
      body = html`<video class=${fit} src=${media.video(it.id)} poster=${media.preview(it.id)} controls autoplay onError=${expiry.check} />`;
    } else if (it.livePhotoVideoId && playLive) {
      body = html`<video key=${`live-${it.id}`} class=${fit} src=${media.video(it.livePhotoVideoId)} autoplay muted onEnded=${() => setPlayLive(false)} onError=${expiry.check} />`;
    } else {
      body = html`<img class=${fit} src=${media.preview(it.id)} alt=${it.fileName} onError=${expiry.check} />`;
    }
    return html`<div
      key=${it.id}
      class="absolute inset-0 flex items-center justify-center p-2 pt-16 will-change-transform"
      style=${{ transform: `translateX(calc(${at * 100}% + ${px}px))`, transition: cur?.anim ? `transform ${SLIDE_MS}ms cubic-bezier(0.2, 0, 0, 1)` : 'none' }}
      aria-hidden=${at !== 0 ? 'true' : undefined}
    >${body}</div>`;
  };

  return html`
    <div ref=${root} tabindex="-1" class="group/viewer fixed inset-0 z-50 touch-pan-y touch-pinch-zoom overflow-hidden bg-black outline-none" role="dialog" aria-modal="true" aria-label=${item.fileName} onClick=${onClick} onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerEnd} onPointerCancel=${onPointerEnd}>
      ${[-1, 0, 1].map((at) => items[index + at] && slide(items[index + at], at))}

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
        onClick=${() => slideTo(-1)} aria-disabled=${index === 0} aria-label="Previous"
      ><${Icon} name="chevronLeft" class="size-7" /></button>
      <button
        class=${`${navBtn} right-3`}
        onClick=${() => slideTo(1)} aria-disabled=${index === items.length - 1} aria-label="Next"
      ><${Icon} name="chevronRight" class="size-7" /></button>
    </div>`;
}
