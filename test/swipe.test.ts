import assert from 'node:assert/strict';
import { test } from 'node:test';
import { swipeStep } from '../public/swipe.js';

test('swiping left shows the next photo, right the previous one', () => {
  assert.equal(swipeStep(-80, 5), 1);
  assert.equal(swipeStep(80, -5), -1);
});

test('a tap, a short move or a mostly vertical one does nothing', () => {
  assert.equal(swipeStep(0, 0), 0);
  assert.equal(swipeStep(-49, 0), 0);
  assert.equal(swipeStep(-60, 90), 0);
  assert.equal(swipeStep(60, 60), 0);
});
