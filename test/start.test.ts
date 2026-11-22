import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startMember } from '../public/start.js';

const admin = { id: 'admin', hasPhotos: false };
const anna = { id: 'anna', hasPhotos: true };
const bob = { id: 'bob', hasPhotos: true };

test('start member: the last viewed, else the 1st with photos', () => {
  assert.equal(startMember([admin, anna, bob], 'bob'), 'bob', 'last viewed');
  assert.equal(startMember([admin, anna, bob], 'admin'), 'admin', 'last viewed, even with an empty timeline');
  assert.equal(startMember([admin, anna, bob], null), 'anna', 'nothing remembered → 1st with photos');
  assert.equal(startMember([admin, anna, bob], 'gone'), 'anna', 'last viewed no longer a member');
  assert.equal(startMember([admin, { id: 'eve', hasPhotos: false }], null), 'admin', 'nobody has photos → 1st member');
  assert.equal(startMember([], 'bob'), null, 'no members');
});
