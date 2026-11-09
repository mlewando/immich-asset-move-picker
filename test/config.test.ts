import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.ts';

const valid = {
  IMMICH_API_URL: 'http://127.0.0.1:2283/api/',
  IMMICH_FAMILY_API_KEY: 'secret-key-value',
  PGHOST: '127.0.0.1',
  PGPORT: '5432',
  PGDATABASE: 'immich',
  PGUSER: 'immich_picker',
  PGPASSWORD: 'secret-db-password',
  PICKER_LIBRARY_MOUNT: '/library',
  PICKER_LIBRARY_SUBDIRS: 'upload, library,backups,encoded-video',
  PICKER_METRICS_DIR: '/metrics',
  PICKER_DATA_DIR: '/var/lib/picker',
};

const problemsOf = (env: Record<string, string>): string[] => {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
  assert.fail('expected ConfigError');
};

test('valid env → config with contract defaults', () => {
  const c = loadConfig(valid);
  assert.deepEqual(c.listen, { host: '127.0.0.1', port: 2284 });
  assert.equal(c.immich.apiUrl, 'http://127.0.0.1:2283/api');
  assert.equal(c.db.port, 5432);
  assert.deepEqual(c.library.subdirs, ['upload', 'library', 'backups', 'encoded-video']);
});

test('PICKER_LISTEN accepts host:port and [ipv6]:port', () => {
  assert.deepEqual(loadConfig({ ...valid, PICKER_LISTEN: '0.0.0.0:8080' }).listen, { host: '0.0.0.0', port: 8080 });
  assert.deepEqual(loadConfig({ ...valid, PICKER_LISTEN: '[::1]:2284' }).listen, { host: '::1', port: 2284 });
});

test('reports every missing variable at once', () => {
  const problems = problemsOf({});
  for (const name of Object.keys(valid)) {
    assert.ok(problems.some((p) => p.startsWith(`${name} `)), `no problem reported for ${name}`);
  }
});

test('rejects bad values', () => {
  assert.deepEqual(problemsOf({ ...valid, PGPORT: '99999' }), ['PGPORT must be a port number 1-65535']);
  assert.deepEqual(problemsOf({ ...valid, PICKER_LISTEN: 'localhost' }), ['PICKER_LISTEN must be host:port']);
  assert.deepEqual(problemsOf({ ...valid, IMMICH_API_URL: 'not a url' }), ['IMMICH_API_URL must be a URL']);
  assert.deepEqual(problemsOf({ ...valid, PICKER_LIBRARY_MOUNT: 'library' }), [
    'PICKER_LIBRARY_MOUNT must be an absolute path',
  ]);
  assert.deepEqual(problemsOf({ ...valid, PICKER_LIBRARY_SUBDIRS: 'upload,../etc' }), [
    'PICKER_LIBRARY_SUBDIRS entry "../etc" must be a single directory name',
  ]);
  assert.deepEqual(problemsOf({ ...valid, PICKER_LIBRARY_SUBDIRS: ' , ' }), [
    'PICKER_LIBRARY_SUBDIRS must list at least 1 subdir',
  ]);
});

test('error message never contains secret values', () => {
  try {
    loadConfig({ ...valid, PGPORT: 'x' });
    assert.fail('expected ConfigError');
  } catch (err) {
    const msg = (err as Error).message;
    assert.ok(!msg.includes(valid.PGPASSWORD));
    assert.ok(!msg.includes(valid.IMMICH_FAMILY_API_KEY));
  }
});
