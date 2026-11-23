import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holdInert } from '../public/inert.js';

const element = () => {
  const el = { inert: false, toggleAttribute: (_name: string, on: boolean) => (el.inert = on) };
  return el;
};

test('holdInert keeps an element inert until the last owner lets go', () => {
  const shared = element();
  const menuOnly = element();
  holdInert('menu', [shared, menuOnly]);
  holdInert('panel', [shared]);
  assert.equal(shared.inert, true);
  holdInert('menu', null);
  assert.equal(shared.inert, true, 'still held by the panel');
  assert.equal(menuOnly.inert, false);
  holdInert('panel', null);
  assert.equal(shared.inert, false);
});

test('holdInert: holding again replaces what the owner held', () => {
  const a = element();
  const b = element();
  holdInert('menu', [a]);
  holdInert('menu', [b]);
  assert.deepEqual([a.inert, b.inert], [false, true]);
  holdInert('menu', null);
  assert.equal(b.inert, false);
});
