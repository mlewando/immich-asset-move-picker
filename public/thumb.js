// A photo's thumbnail or preview that says why it isn't showing. A new upload has none until
// Immich's own job makes it: the server answers 503 then, and the tile shows "making the
// thumbnail" and asks again every RETRY_MS. Any other failure shows as an error.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { expiry } from './expiry.js';
import { Icon } from './icons.js';

const html = htm.bind(h);

const RETRY_MS = 5000;

/**
 * class: the box (size, shape, transitions); fit: how the image fills it (object-cover by
 * default). Other props (alt, loading, draggable…) go to the <img>.
 */
export function Thumb({ src, class: cls = '', fit = 'object-cover', alt = '', ...img }) {
  const [state, setState] = useState('ok'); // ok | pending | error
  const [tries, setTries] = useState(0);
  useEffect(() => {
    setState('ok');
    setTries(0);
  }, [src]);
  // While Immich makes it: load it again (a new URL, so the browser really asks) every RETRY_MS.
  useEffect(() => {
    if (state !== 'pending') return;
    const t = setTimeout(() => setTries((n) => n + 1), RETRY_MS);
    return () => clearTimeout(t);
  }, [state, tries]);

  // An <img> error doesn't say why: ask the same URL for its status alone.
  const onError = async () => {
    expiry.check();
    try {
      const res = await fetch(src, { method: 'HEAD', headers: { 'x-picker-poll': '1' } });
      setState(res.status === 503 ? 'pending' : 'error');
    } catch {
      setState('error');
    }
  };

  const url = tries ? `${src}?try=${tries}` : src;
  return html`<span class=${`@container relative block overflow-hidden bg-neutral-800 ${cls}`}>
    ${state !== 'error' &&
    html`<img
      ...${img}
      src=${url}
      alt=${alt}
      class=${`size-full ${fit} ${state === 'ok' ? '' : 'opacity-0'}`}
      onLoad=${() => setState('ok')}
      onError=${onError}
    />`}
    ${state === 'pending' &&
    html`<span class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-2 text-center text-neutral-400" title="Immich is still making the thumbnail of this new upload" role="img" aria-label="Thumbnail not made yet">
      <span class="size-5 animate-spin rounded-full border-2 border-white/15 border-t-neutral-300" />
      <span class="hidden text-[11px] leading-tight @[6rem]:block">Making thumbnail…</span>
    </span>`}
    ${state === 'error' &&
    html`<span class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-2 text-center text-rose-300" title="The picker couldn't load this file (see its log)" role="img" aria-label="Couldn't load the photo">
      <${Icon} name="imageBroken" class="size-6" />
      <span class="hidden text-[11px] leading-tight @[6rem]:block">Couldn't load</span>
    </span>`}
  </span>`;
}
