// A horizontal swipe on the viewer (pure, unit-tested in test/swipe.test.ts).

export const SWIPE_MIN_PX = 50;

/**
 * dx, dy: how far the finger moved from where it went down. Returns the step to take (+1 next,
 * -1 previous), or 0 for a tap, a short move or a mostly vertical one. Swiping left shows the
 * next photo, as a page turns.
 */
export function swipeStep(dx, dy) {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}
