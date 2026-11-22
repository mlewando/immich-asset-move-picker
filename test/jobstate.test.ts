import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventOf } from '../public/jobstate.js';

test('history: the copy step says whether the photo was copied or already there', () => {
  const copied = (outcome: string | null) => eventOf({ type: 'step', step: 'copied', outcome }).text;
  assert.equal(copied(null), 'Copied to the family account');
  assert.equal(copied('existing'), 'Already in the family account, no copy made');
  assert.equal(copied('unknown'), 'In the family account: copied on an earlier try, or already there');
  // History from before the outcome was kept has none.
  assert.equal(eventOf({ type: 'step', step: 'copied' }).text, 'Copied to the family account');
  assert.equal(eventOf({ type: 'step', step: 'archived', outcome: null }).text, 'Original archived');
});
