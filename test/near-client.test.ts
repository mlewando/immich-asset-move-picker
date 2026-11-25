import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dividerLabels, dividers, surroundDays, surroundText } from '../public/near.js';

const trip = { from: '2026-07-03', to: '2026-07-10' };

test('dividers: end before the album’s newest day, start after its oldest (grid is newest first)', () => {
  const days = ['2026-07-12', '2026-07-11', '2026-07-10', '2026-07-05', '2026-07-03', '2026-07-02'];
  assert.deepEqual(dividers(days, trip), { ends: 2, starts: 5, after: true, inside: true, before: true });
});

test('dividers: a part of the window without photos', () => {
  assert.deepEqual(dividers(['2026-07-10', '2026-07-03'], trip), { ends: 0, starts: 2, after: false, inside: true, before: false }, 'album days only');
  assert.deepEqual(dividers(['2026-07-12', '2026-07-01'], trip), { ends: 1, starts: 1, after: true, inside: false, before: true }, 'around only: back to back');
  assert.deepEqual(dividers(['2026-07-11'], trip), { ends: 1, starts: 1, after: true, inside: false, before: false }, 'after only: both at the end');
});

test('dividerLabels: say which part has no photos, only when it has days', () => {
  const all = { after: true, inside: true, before: true };
  assert.deepEqual(dividerLabels('Trip', { before: 2, after: 2 }, all), { end: 'End of «Trip»', start: 'Start of «Trip»' });
  assert.deepEqual(dividerLabels('Trip', { before: 1, after: 3 }, { after: false, inside: false, before: false }), {
    end: 'End of «Trip» · no photos in the 3 days after · no photos on its own days',
    start: 'Start of «Trip» · no photos in the 1 day before',
  });
  assert.deepEqual(dividerLabels('Trip', { before: 0, after: 0 }, { ...all, after: false, before: false }), {
    end: 'End of «Trip»',
    start: 'Start of «Trip»',
  }, 'no surround: nothing to miss');
});

test('surroundDays: whole days 0..30; surroundText', () => {
  assert.deepEqual(['3', '2.7', '-1', '99', 'x', null].map(surroundDays), [3, 2, 0, 30, 0, 0]);
  assert.equal(surroundText({ before: 2, after: 2 }), '±2 days');
  assert.equal(surroundText({ before: 1, after: 3 }), '1 day before, 3 days after');
  assert.equal(surroundText({ before: 0, after: 0 }), 'its own days only');
});
