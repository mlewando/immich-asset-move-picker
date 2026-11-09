// The Give back decision (src/immich/giveback.ts planGiveBack); the SQL that gathers the facts
// is covered by test/integration/move.int.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planGiveBack, type PlanFile } from '../src/immich/giveback.ts';

const file = (id: string, twins: PlanFile['twins'], isVideoHalf = false): PlanFile => ({ id, fileName: `${id}.jpg`, isVideoHalf, twins });

test('restores archived and timeline twins of the photos; deletes every family file', () => {
  const plan = planGiveBack([
    file('still', [{ id: 'bob-still', visibility: 'archive' }, { id: 'anna-still', visibility: 'timeline' }]),
    file('video', [{ id: 'bob-video', visibility: 'hidden' }], true),
  ]);
  assert.deepEqual(plan, { familyIds: ['still', 'video'], originals: ['bob-still', 'anna-still'] });
});

test('a locked twin is a copy (safe to delete) but is not restored', () => {
  assert.deepEqual(planGiveBack([file('a', [{ id: 'm', visibility: 'locked' }])]), { familyIds: ['a'], originals: [] });
});

test('any family file without a twin → refused (never delete the only copy)', () => {
  assert.throws(
    () => planGiveBack([file('a', [{ id: 'm', visibility: 'archive' }]), file('b', [])]),
    /no original of b\.jpg in any member's account: giving it back would delete its only copy/,
  );
  assert.throws(() => planGiveBack([file('s', [{ id: 'm', visibility: 'archive' }]), file('v', [], true)]), /v\.jpg/);
});
