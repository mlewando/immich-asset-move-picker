// An in-app yes/no question on a native modal <dialog>: the browser makes the page behind inert,
// keeps Tab inside, closes it on Esc and (via onClose) the focus goes back to where it was.
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

const btn = 'rounded-full px-4 py-1.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-sky-400';

/**
 * Mount it to open it. onConfirm / onCancel: the page unmounts it after either (and after Esc).
 * The padding sits on an inner box, so a click on the dialog element itself is a click on the
 * backdrop (which cancels).
 */
export function ConfirmDialog({ title, text, confirmLabel, onConfirm, onCancel }) {
  const box = useRef(null);
  const opener = useRef(document.activeElement);
  useEffect(() => {
    box.current?.showModal();
    return () => {
      // Gone from the page: the focus goes back to the button that asked, if it is still there.
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  return html`<dialog
    ref=${box}
    class="m-auto w-[26rem] max-w-[90vw] rounded-2xl border border-white/10 bg-neutral-900 p-0 text-neutral-100 shadow-2xl backdrop:bg-black/60"
    aria-labelledby="confirm-title"
    aria-describedby="confirm-text"
    onCancel=${(e) => {
      e.preventDefault();
      onCancel();
    }}
    onClick=${(e) => e.target === e.currentTarget && onCancel()}
  >
    <div class="p-5">
      <h2 id="confirm-title" class="text-base font-semibold">${title}</h2>
      <p id="confirm-text" class="mt-2 text-sm text-neutral-300">${text}</p>
      <div class="mt-5 flex justify-end gap-2">
        <button class=${`${btn} text-neutral-200 hover:bg-white/10`} onClick=${onCancel} autofocus>Cancel</button>
        <button class=${`${btn} bg-rose-500 text-white hover:bg-rose-400`} onClick=${onConfirm}>${confirmLabel}</button>
      </div>
    </div>
  </dialog>`;
}
