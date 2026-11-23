// A horizontal swipe on the viewer (pure, unit-tested in test/swipe.test.ts).

export const SWIPE_MIN_PX = 50;
const FLING_PX_PER_MS = 0.4;

/**
 * Where a finger let go: dx, dy = how far it moved from where it went down, width = the viewer's
 * width, ms = how long it was down. Returns the step to take (+1 next, -1 previous), or 0 to
 * settle back (a tap, a short or mostly vertical move). Swiping left shows the next photo, as a
 * page turns. A far drag (a third of the width) or a quick flick commits.
 */
export function swipeStep(dx, dy, width, ms) {
  const far = Math.abs(dx);
  if (far < SWIPE_MIN_PX || far <= Math.abs(dy)) return 0;
  if (far < width / 3 && far / Math.max(ms, 1) < FLING_PX_PER_MS) return 0;
  return dx < 0 ? 1 : -1;
}

/** How far the photos follow the finger: all of it, a third of it past the first or last photo. */
export function dragOffset(dx, hasPrev, hasNext) {
  return (dx > 0 && !hasPrev) || (dx < 0 && !hasNext) ? dx / 3 : dx;
}
