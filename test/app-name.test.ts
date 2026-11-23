import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { APP_NAME } from '../src/app-name.ts';

test('the page title and the app.js name are the server’s name', () => {
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(index, new RegExp(`<title>${APP_NAME}</title>`));
  assert.match(app, new RegExp(`const APP_NAME = '${APP_NAME}';`));
});

test('the sidebar shows APP_NAME, not a second spelling', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, />Family picker</);
});
