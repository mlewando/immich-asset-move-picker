// A dropdown anchored to its button: Esc, a click elsewhere or Tab out of it closes it; Esc gives
// the focus back to the button. On a phone it spans the screen's width under the top bar.
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

const FOCUSABLE = 'input, button:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * anchor: ref to the button that toggles it (a click on it is left to the button's own handler).
 * initialFocus: CSS selector of the element to focus on open (default the first focusable one).
 * phoneTop: where it starts on a phone (default right under the top bar).
 */
export function Popover({ open, onClose, anchor, label, initialFocus, phoneTop = 'top-16', class: cls = '', children }) {
  const box = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const el = box.current;
    const first = (initialFocus && el.querySelector(initialFocus)) || el.querySelector(FOCUSABLE) || el;
    first.focus({ preventScroll: true });

    const inside = (node) => el.contains(node) || anchor.current?.contains(node);
    // Capture phase on window: runs before the side panel's or viewer's own Esc, and stops it, so
    // 1 Esc closes only the topmost thing.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
      anchor.current?.focus();
    };
    const onPointer = (e) => !inside(e.target) && onCloseRef.current();
    const onFocus = (e) => !inside(e.target) && onCloseRef.current();
    addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('focusin', onFocus);
    };
  }, [open]);

  if (!open) return null;
  return html`<div
    ref=${box}
    role="dialog"
    aria-label=${label}
    tabindex="-1"
    class=${`fixed inset-x-2 ${phoneTop} z-40 flex max-h-[calc(100dvh-8rem)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 shadow-2xl outline-none sm:absolute sm:inset-x-auto sm:top-full sm:mt-2 ${cls}`}
  >${children}</div>`;
}
