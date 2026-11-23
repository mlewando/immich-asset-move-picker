import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dragOffset, swipeStep } from '../public/swipe.js';

const W = 400;

test('a far drag left shows the next photo, right the previous one', () => {
  assert.equal(swipeStep(-150, 5, W, 600), 1);
  assert.equal(swipeStep(150, -5, W, 600), -1);
});

test('a quick short flick commits, a slow short drag settles back', () => {
  assert.equal(swipeStep(-60, 0, W, 100), 1);
  assert.equal(swipeStep(-60, 0, W, 800), 0);
});

test('a tap, a tiny move or a mostly vertical one does nothing', () => {
  assert.equal(swipeStep(0, 0, W, 50), 0);
  assert.equal(swipeStep(-49, 0, W, 10), 0);
  assert.equal(swipeStep(-160, 200, W, 600), 0);
  assert.equal(swipeStep(160, 160, W, 600), 0);
});

test('the photos follow the finger, with resistance past either end', () => {
  assert.equal(dragOffset(-90, true, true), -90);
  assert.equal(dragOffset(90, true, true), 90);
  assert.equal(dragOffset(90, false, true), 30);
  assert.equal(dragOffset(-90, true, false), -30);
  assert.equal(dragOffset(90, true, false), 90);
});
