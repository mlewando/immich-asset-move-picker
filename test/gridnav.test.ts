import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveFocus } from '../public/gridnav.js';

// 3 columns. Day 0: 5 photos (rows 0-2, 3-4), with a day button. Day 1: 1 photo, no day button
// (nothing selectable). Day 2: 7 photos (rows 0-2, 3-5, 6), with a day button.
const days = [
  { count: 5, head: true },
  { count: 1, head: false },
  { count: 7, head: true },
];
const move = (day: number, at: number | 'head', key: string, cols = 3) => moveFocus(days, cols, { day, at }, key);

test('← → walk the photos in timeline order, across days, never onto a day button', () => {
  assert.deepEqual(move(0, 1, 'ArrowRight'), { day: 0, at: 2 });
  assert.deepEqual(move(0, 4, 'ArrowRight'), { day: 1, at: 0 });
  assert.deepEqual(move(1, 0, 'ArrowRight'), { day: 2, at: 0 });
  assert.deepEqual(move(2, 0, 'ArrowLeft'), { day: 1, at: 0 });
  assert.deepEqual(move(1, 0, 'ArrowLeft'), { day: 0, at: 4 });
});

test('← → stop at the grid ends', () => {
  assert.deepEqual(move(0, 0, 'ArrowLeft'), { day: 0, at: 0 });
  assert.deepEqual(move(2, 6, 'ArrowRight'), { day: 2, at: 6 });
});

test('↑ ↓ keep the column inside a day; a shorter row gives its last photo', () => {
  assert.deepEqual(move(0, 1, 'ArrowDown'), { day: 0, at: 4 });
  assert.deepEqual(move(0, 2, 'ArrowDown'), { day: 0, at: 4 }, 'row 2 has only 2 photos');
  assert.deepEqual(move(0, 4, 'ArrowUp'), { day: 0, at: 1 });
  assert.deepEqual(move(2, 5, 'ArrowDown'), { day: 2, at: 6 });
});

test('↑ from a 1st row goes to its day button; ↓ from a day button to its 1st photo', () => {
  assert.deepEqual(move(0, 2, 'ArrowUp'), { day: 0, at: 'head' });
  assert.deepEqual(move(0, 'head', 'ArrowDown'), { day: 0, at: 0 });
});

test('a day without a button: ↓ into its 1st row, ↑ out of it to the previous last row', () => {
  assert.deepEqual(move(0, 4, 'ArrowDown'), { day: 1, at: 0 }, 'column clamped to the 1 photo');
  assert.deepEqual(move(1, 0, 'ArrowUp'), { day: 0, at: 3 });
});

test('↓ from a last row goes to the next day button', () => {
  assert.deepEqual(move(1, 0, 'ArrowDown'), { day: 2, at: 'head' });
});

test('↑ from a day button lands in the previous day last row, 1st column', () => {
  assert.deepEqual(move(2, 'head', 'ArrowUp'), { day: 1, at: 0 });
  assert.deepEqual(moveFocus([{ count: 5, head: true }, { count: 2, head: true }], 3, { day: 1, at: 'head' }, 'ArrowUp'), { day: 0, at: 3 });
  assert.deepEqual(move(0, 'head', 'ArrowUp'), { day: 0, at: 'head' }, 'nothing above the 1st day');
});

test('← → on a day button do nothing', () => {
  assert.deepEqual(move(2, 'head', 'ArrowLeft'), { day: 2, at: 'head' });
  assert.deepEqual(move(2, 'head', 'ArrowRight'), { day: 2, at: 'head' });
});

test('↑ ↓ stop at the grid ends', () => {
  assert.deepEqual(move(2, 6, 'ArrowDown'), { day: 2, at: 6 });
  assert.deepEqual(moveFocus([{ count: 3, head: false }], 3, { day: 0, at: 1 }, 'ArrowUp'), { day: 0, at: 1 });
});

test('1 column: ↑ ↓ step 1 photo', () => {
  assert.deepEqual(move(0, 1, 'ArrowDown', 1), { day: 0, at: 2 });
  assert.deepEqual(move(0, 1, 'ArrowUp', 1), { day: 0, at: 0 });
  assert.deepEqual(move(0, 4, 'ArrowDown', 1), { day: 1, at: 0 });
});

test('Home / End go to the 1st / last photo, also from a day button', () => {
  assert.deepEqual(move(2, 3, 'Home'), { day: 0, at: 0 });
  assert.deepEqual(move(0, 'head', 'End'), { day: 2, at: 6 });
});
