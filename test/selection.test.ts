import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addRange, applyMarquee, groupByDay, rectsIntersect, toggleDay, toggleOne } from '../public/selection.js';

type It = { id: string; day: string; noOrigin?: boolean };
const items: It[] = [
  { id: 'a', day: '2026-07-03' },
  { id: 'b', day: '2026-07-02' },
  { id: 'c', day: '2026-07-02', noOrigin: true },
  { id: 'd', day: '2026-07-02' },
  { id: 'e', day: '2026-07-01' },
];
const selectable = (i: It) => !i.noOrigin;
const ids = (s: Set<string>) => [...s].sort();

test('groupByDay keeps order and flat indexes', () => {
  assert.deepEqual(
    groupByDay(items).map((g: { day: string; entries: { item: It; index: number }[] }) => [g.day, g.entries.map((e) => `${e.item.id}${e.index}`)]),
    [
      ['2026-07-03', ['a0']],
      ['2026-07-02', ['b1', 'c2', 'd3']],
      ['2026-07-01', ['e4']],
    ],
  );
});

test('toggleOne adds then removes, never mutates', () => {
  const s0 = new Set<string>();
  const s1 = toggleOne(s0, 'a');
  assert.deepEqual(ids(s1), ['a']);
  assert.deepEqual(ids(toggleOne(s1, 'a')), []);
  assert.equal(s0.size, 0);
});

test('addRange selects selectable items between 2 positions, either direction', () => {
  assert.deepEqual(ids(addRange(new Set(), items, 0, 3, selectable)), ['a', 'b', 'd']);
  assert.deepEqual(ids(addRange(new Set(['e']), items, 3, 1, selectable)), ['b', 'd', 'e']);
});

test('rectsIntersect: overlap counts, touching edges do not', () => {
  const r = { left: 0, top: 0, right: 10, bottom: 10 };
  assert.equal(rectsIntersect(r, { left: 5, top: 5, right: 15, bottom: 15 }), true);
  assert.equal(rectsIntersect(r, { left: 2, top: 2, right: 3, bottom: 3 }), true, 'inside');
  assert.equal(rectsIntersect(r, { left: 10, top: 0, right: 20, bottom: 10 }), false, 'touching');
  assert.equal(rectsIntersect(r, { left: 0, top: 11, right: 10, bottom: 20 }), false, 'below');
});

test('applyMarquee adds hits to the starting selection, or removes them (Alt)', () => {
  const base = new Set(['a', 'b']);
  assert.deepEqual(ids(applyMarquee(base, ['b', 'c'], false)), ['a', 'b', 'c']);
  assert.deepEqual(ids(applyMarquee(base, ['b', 'c'], true)), ['a']);
  assert.deepEqual(ids(base), ['a', 'b'], 'base untouched');
});

test('toggleDay selects the whole day, then unselects it', () => {
  const day = items.filter((i) => i.day === '2026-07-02');
  const s1 = toggleDay(new Set(['b']), day, selectable);
  assert.deepEqual(ids(s1), ['b', 'd'], 'partially selected day → select all selectable');
  assert.deepEqual(ids(toggleDay(s1, day, selectable)), [], 'fully selected → unselect');
  assert.deepEqual(ids(toggleDay(new Set(), [items[2]!], selectable)), [], 'no selectable item → no-op');
});
