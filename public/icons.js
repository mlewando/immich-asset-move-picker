// Inline SVG icons (Material Design Icons paths, the set Immich uses). Inline <svg> elements
// are plain DOM, so the strict Content-Security-Policy allows them.
import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

const PATHS = {
  checkCircle: 'M12 2C6.5 2 2 6.5 2 12S6.5 22 12 22 22 17.5 22 12 17.5 2 12 2M10 17L5 12L6.41 10.59L10 14.17L17.59 6.58L19 8L10 17Z',
  magnify: 'M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z',
  close: 'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z',
  chevronLeft: 'M15.41,16.58L10.83,12L15.41,7.41L14,6L8,12L14,18L15.41,16.58Z',
  chevronRight: 'M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z',
  play: 'M8,5.14V19.14L19,12.14L8,5.14Z',
  stop: 'M18,18H6V6H18V18Z',
  stack: 'M4 6H2v14a2 2 0 0 0 2 2h14v-2H4V6m16-4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2m0 14H8V4h12v12z',
  family: 'M16,13C15.71,13 15.38,13 15.03,13.05C16.19,13.89 17,15 17,16.5V19H23V16.5C23,14.17 18.33,13 16,13M8,13C5.67,13 1,14.17 1,16.5V19H15V16.5C15,14.17 10.33,13 8,13M8,11A3,3 0 0,0 11,8A3,3 0 0,0 8,5A3,3 0 0,0 5,8A3,3 0 0,0 8,11M16,11A3,3 0 0,0 19,8A3,3 0 0,0 16,5A3,3 0 0,0 13,8A3,3 0 0,0 16,11Z',
  zoomOut: 'M15.5,14H14.71L14.43,13.73C15.41,12.59 16,11.11 16,9.5A6.5,6.5 0 0,0 9.5,3A6.5,6.5 0 0,0 3,9.5A6.5,6.5 0 0,0 9.5,16C11.11,16 12.59,15.41 13.73,14.43L14,14.71V15.5L19,20.5L20.5,19L15.5,14M9.5,14C7,14 5,12 5,9.5C5,7 7,5 9.5,5C12,5 14,7 14,9.5C14,12 12,14 9.5,14M7,9H12V10H7V9Z',
  zoomIn: 'M15.5,14L20.5,19L19,20.5L14,15.5V14.71L13.73,14.43C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.43,13.73L14.71,14H15.5M9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14M12,10H10V12H9V10H7V9H9V7H10V9H12V10Z',
  alert: 'M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z',
};

export function Icon({ name, class: cls = 'size-5' }) {
  return html`<svg viewBox="0 0 24 24" class=${cls} aria-hidden="true" fill="currentColor"><path d=${PATHS[name]} /></svg>`;
}

/**
 * Immich-style selection circle: white ring when off, filled blue check when on. Both layers
 * are always in the DOM, so switching animates: the check pops in (slight overshoot) and fades.
 */
export function CheckCircle({ on, class: cls = 'size-6' }) {
  return html`<span class=${`relative block shrink-0 ${cls}`} aria-hidden="true">
    <svg viewBox="0 0 24 24" class="absolute inset-0 size-full text-white/90 drop-shadow">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
    </svg>
    <svg
      viewBox="0 0 24 24"
      class=${`absolute inset-0 size-full text-sky-400 drop-shadow transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${on ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`}
    >
      <circle cx="12" cy="12" r="9" fill="white" />
      <path fill="currentColor" d=${PATHS.checkCircle} />
    </svg>
  </span>`;
}
