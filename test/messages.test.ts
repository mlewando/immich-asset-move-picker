import assert from 'node:assert/strict';
import { test } from 'node:test';
import { giveBackQuestion, queuedMessage } from '../public/messages.js';

const items = [
  { id: 'a', fileName: 'IMG_1.jpg' },
  { id: 'b', fileName: 'IMG_2.jpg' },
  { id: 'c', fileName: 'IMG_3.jpg' },
];

test('the message names the photos queued, and how many more', () => {
  assert.equal(queuedMessage(items, { queued: 1, queuedIds: ['b'], alreadyQueued: 0 }, 1), "Queued 'IMG_2.jpg'");
  assert.equal(queuedMessage(items, { queued: 3, queuedIds: ['a', 'b', 'c'], alreadyQueued: 0 }, 3), "Queued 'IMG_1.jpg' + 2 more");
});

test('files are counted when more than the photos, already queued ones are kept', () => {
  assert.equal(
    queuedMessage(items, { queued: 2, queuedIds: ['a', 'b'], alreadyQueued: 1 }, 5),
    "Queued 'IMG_1.jpg' + 1 more (5 files) • 1 already queued",
  );
});

test('nothing new queued: only the already-queued count', () => {
  assert.equal(queuedMessage(items, { queued: 0, queuedIds: [], alreadyQueued: 2 }, 0), '2 already queued');
});

test('ids missing from the grid fall back to the count', () => {
  assert.equal(queuedMessage([], { queued: 2, queuedIds: ['x', 'y'], alreadyQueued: 0 }, 2), 'Queued 2 photos');
});

test('the Give back question is singular or plural', () => {
  assert.equal(giveBackQuestion(1), 'Give back 1 photo?');
  assert.equal(giveBackQuestion(4), 'Give back 4 photos?');
});
