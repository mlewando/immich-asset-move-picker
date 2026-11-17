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
  PICKER_OIDC_ISSUER: 'https://auth.example.org',
  PICKER_OIDC_CLIENT_ID: 'picker',
  PICKER_OIDC_CLIENT_SECRET: 'secret-client-secret',
  PICKER_OIDC_ALLOWED_GROUPS: 'photos-curators, admins',
  PICKER_PUBLIC_URL: 'https://picker.example.org',
  PICKER_HEALTHZ_USER: 'probe',
  PICKER_HEALTHZ_PASSWORD: 'secret-healthz-password',
  PICKER_TLS_CERT: '/tls/cert.pem',
  PICKER_TLS_KEY: '/tls/key.pem',
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
  assert.deepEqual(c.auth?.allowedGroups, ['photos-curators', 'admins']);
  assert.equal(c.auth?.idleMs, 30 * 60_000);
  assert.deepEqual(c.tls, { certFile: '/tls/cert.pem', keyFile: '/tls/key.pem' });
});

test('the login is on unless PICKER_AUTH=off', () => {
  const { PICKER_OIDC_ISSUER, PICKER_OIDC_CLIENT_SECRET, ...noOidc } = valid;
  assert.deepEqual(problemsOf(noOidc), ['PICKER_OIDC_ISSUER is required', 'PICKER_OIDC_CLIENT_SECRET is required']);
  const { PICKER_HEALTHZ_USER, PICKER_HEALTHZ_PASSWORD, ...dev } = noOidc;
  assert.equal(loadConfig({ ...dev, PICKER_AUTH: 'off' }).auth, null);
  assert.equal(loadConfig({ ...dev, PICKER_AUTH: 'off' }).healthz, null);
  assert.deepEqual(problemsOf({ ...valid, PICKER_AUTH: 'none' }), ['PICKER_AUTH must be oidc, off or off-any-host']);
});

test('the login is never off on a network address by accident', () => {
  const { PICKER_HEALTHZ_USER, PICKER_HEALTHZ_PASSWORD, ...dev } = valid;
  assert.deepEqual(problemsOf({ ...dev, PICKER_AUTH: 'off', PICKER_LISTEN: '0.0.0.0:2284' }), [
    'PICKER_AUTH=off needs a loopback PICKER_LISTEN',
  ]);
  assert.equal(loadConfig({ ...dev, PICKER_AUTH: 'off-any-host', PICKER_LISTEN: '0.0.0.0:2284' }).auth, null);
});

test('PICKER_PUBLIC_URL must be https except on loopback', () => {
  assert.deepEqual(problemsOf({ ...valid, PICKER_PUBLIC_URL: 'http://picker.lan' }), [
    'PICKER_PUBLIC_URL must be https (http only on loopback)',
  ]);
  assert.ok(loadConfig({ ...valid, PICKER_PUBLIC_URL: 'http://127.0.0.1:2284' }).auth);
});

test('PICKER_OIDC_LOGOUT_URL is optional and https', () => {
  assert.equal(loadConfig(valid).auth?.logoutUrl, null);
  assert.equal(loadConfig({ ...valid, PICKER_OIDC_LOGOUT_URL: 'https://auth.example.org/logout' }).auth?.logoutUrl?.href, 'https://auth.example.org/logout');
  assert.deepEqual(problemsOf({ ...valid, PICKER_OIDC_LOGOUT_URL: 'http://auth.example.org/logout' }), ['PICKER_OIDC_LOGOUT_URL must be an https URL']);
  assert.deepEqual(problemsOf({ ...valid, PICKER_OIDC_LOGOUT_URL: 'nope' }), ['PICKER_OIDC_LOGOUT_URL must be an https URL']);
});

test('session idle time and TLS files', () => {
  assert.equal(loadConfig({ ...valid, PICKER_SESSION_IDLE: '2h' }).auth?.idleMs, 2 * 3_600_000);
  assert.deepEqual(problemsOf({ ...valid, PICKER_SESSION_IDLE: '30' }), ['PICKER_SESSION_IDLE must be a duration like 30m']);
  assert.deepEqual(loadConfig({ ...valid, PICKER_TLS_CERT: '/c.pem', PICKER_TLS_KEY: '/k.pem' }).tls, {
    certFile: '/c.pem',
    keyFile: '/k.pem',
  });
  const { PICKER_TLS_KEY, ...certOnly } = valid;
  assert.ok(problemsOf(certOnly).includes('PICKER_TLS_CERT and PICKER_TLS_KEY go together'));
});

test('an https PICKER_PUBLIC_URL needs the picker to serve https itself', () => {
  const { PICKER_TLS_CERT, PICKER_TLS_KEY, ...plain } = valid;
  assert.deepEqual(problemsOf(plain), ['PICKER_PUBLIC_URL is https: the picker must serve https itself (PICKER_TLS_CERT, PICKER_TLS_KEY)']);
  assert.equal(loadConfig({ ...plain, PICKER_PUBLIC_URL: 'http://127.0.0.1:2284' }).tls, null);
});

test('PICKER_LISTEN accepts host:port and [ipv6]:port', () => {
  assert.deepEqual(loadConfig({ ...valid, PICKER_LISTEN: '0.0.0.0:8080' }).listen, { host: '0.0.0.0', port: 8080 });
  assert.deepEqual(loadConfig({ ...valid, PICKER_LISTEN: '[::1]:2284' }).listen, { host: '::1', port: 2284 });
});

test('reports every missing variable at once', () => {
  const problems = problemsOf({});
  // TLS is optional on its own (only an https PICKER_PUBLIC_URL needs it).
  for (const name of Object.keys(valid).filter((n) => !n.startsWith('PICKER_TLS_'))) {
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
    assert.ok(!msg.includes(valid.PICKER_OIDC_CLIENT_SECRET));
    assert.ok(!msg.includes(valid.PICKER_HEALTHZ_PASSWORD));
  }
});

test('/healthz basic auth is required with the login on', () => {
  const { PICKER_HEALTHZ_PASSWORD, ...noPassword } = valid;
  assert.deepEqual(problemsOf(noPassword), ['PICKER_HEALTHZ_PASSWORD is required']);
  assert.deepEqual(problemsOf({ ...valid, PICKER_HEALTHZ_USER: 'a:b' }), ['PICKER_HEALTHZ_USER must not contain ":"']);
  assert.deepEqual(loadConfig(valid).healthz, { user: 'probe', password: 'secret-healthz-password' });
});
