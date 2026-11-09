// Seeds the throwaway local Immich (dev/compose.yml): 2 members with photos, the family account
// with the picker's API key, and the picker's DB role. Idempotent: re-run any time.
// Writes dev/.env.local for `npm run dev:app`. Dev-only passwords below are not secrets.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV = dirname(fileURLToPath(import.meta.url));
const DATA = join(DEV, '.data');
const FIXTURES = join(DATA, 'fixtures');
const COMPOSE = ['compose', '-f', join(DEV, 'compose.yml')];
const API = 'http://127.0.0.1:2283/api';
const IMMICH_IMAGE = 'ghcr.io/immich-app/immich-server:v3.3.5';
const PASSWORD = 'password123';
const PICKER_DB = { user: 'immich_picker', password: 'picker-dev' };

// Exactly the permissions the picker needs (see README), so the tests catch a missing one.
const FAMILY_KEY_NAME = 'family-picker';
const FAMILY_KEY_PERMISSIONS = ['asset.upload', 'asset.update', 'asset.delete', 'stack.create', 'user.read'];

type Photo = { file: string; at: string };
const USERS = {
  admin: { email: 'admin@example.test', name: 'Admin' },
  anna: { email: 'anna@example.test', name: 'Anna' },
  bob: { email: 'bob@example.test', name: 'Bob' },
  family: { email: 'family-photos@example.test', name: 'Family Photos', storageLabel: 'family-photos' },
} as const;

// Fixture generation: [file, ffmpeg lavfi source + filters]. Each photo is a different frame /
// hue of ffmpeg's test pattern, so every file has its own checksum — except shared.jpg, which
// both members upload (the same bytes held by 2 members).
const FIXTURE_SPECS: Record<string, string[]> = Object.fromEntries([
  ...Array.from({ length: 10 }, (_, i) => [
    `photo-${i + 1}.jpg`,
    ['-f', 'lavfi', '-i', 'testsrc2=s=1600x1200:d=10', '-vf', `select=eq(n\\,${i * 7}),hue=h=${i * 36}`, '-frames:v', '1', '-q:v', '3'],
  ]),
  ['shared.jpg', ['-f', 'lavfi', '-i', 'mandelbrot=s=1600x1200', '-frames:v', '1', '-q:v', '3']],
  ['clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
  ...[1, 2, 3].map((i) => [
    `burst-${i}.jpg`,
    ['-f', 'lavfi', '-i', 'testsrc=s=1600x1200:d=5', '-vf', `select=eq(n\\,${i * 10})`, '-frames:v', '1', '-q:v', '3'],
  ]),
  ['live-still.jpg', ['-f', 'lavfi', '-i', 'smptebars=s=1600x1200', '-frames:v', '1', '-q:v', '3']],
  ['live-motion.mp4', ['-f', 'lavfi', '-i', 'smptebars=s=640x480:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
  ['family-only.jpg', ['-f', 'lavfi', '-i', 'rgbtestsrc=s=1600x1200', '-frames:v', '1', '-q:v', '3']],
]);

// Plain uploads. Special cases (stack, live photo, edit) are in seedSpecialCases().
const UPLOADS: Record<'anna' | 'bob' | 'family', Photo[]> = {
  anna: [
    { file: 'photo-1.jpg', at: '2026-07-01T09:12:00Z' },
    { file: 'photo-2.jpg', at: '2026-07-01T09:40:00Z' },
    { file: 'photo-3.jpg', at: '2026-07-01T18:05:00Z' },
    { file: 'clip.mp4', at: '2026-07-01T18:06:00Z' },
    { file: 'photo-4.jpg', at: '2026-07-02T11:00:00Z' },
    { file: 'photo-5.jpg', at: '2026-07-02T11:01:00Z' },
    { file: 'shared.jpg', at: '2026-07-03T15:30:00Z' },
    { file: 'photo-6.jpg', at: '2026-08-15T08:00:00Z' },
  ],
  bob: [
    { file: 'photo-7.jpg', at: '2026-07-01T10:00:00Z' },
    { file: 'photo-8.jpg', at: '2026-07-02T12:30:00Z' },
    { file: 'shared.jpg', at: '2026-07-03T15:30:00Z' },
    { file: 'photo-9.jpg', at: '2026-09-20T17:45:00Z' },
    { file: 'photo-10.jpg', at: '2026-09-20T17:46:00Z' },
  ],
  // family-only.jpg: put in the family account by hand → no origin. shared.jpg: also already in
  // the family account → members' copies get the "already in family" badge.
  family: [
    { file: 'family-only.jpg', at: '2026-06-01T12:00:00Z' },
    { file: 'shared.jpg', at: '2026-07-03T15:30:00Z' },
  ],
};

async function api<T>(method: string, path: string, opts: { token?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

const login = async (email: string): Promise<string> =>
  (await api<{ accessToken: string }>('POST', '/auth/login', { body: { email, password: PASSWORD } })).accessToken;

function generateFixtures(): void {
  mkdirSync(FIXTURES, { recursive: true });
  for (const [file, args] of Object.entries(FIXTURE_SPECS)) {
    if (existsSync(join(FIXTURES, file))) continue;
    console.log(`  generating ${file}`);
    execFileSync('docker', [
      'run', '--rm', '--entrypoint', 'ffmpeg', '-v', `${FIXTURES}:/out`, IMMICH_IMAGE,
      '-hide_banner', '-loglevel', 'error', '-y', ...args, `/out/${file}`,
    ], { stdio: 'inherit' });
  }
}

async function ensureUsers(adminToken: string): Promise<void> {
  const existing = await api<{ email: string }[]>('GET', '/admin/users', { token: adminToken });
  for (const u of [USERS.anna, USERS.bob, USERS.family]) {
    if (existing.some((e) => e.email === u.email)) continue;
    await api('POST', '/admin/users', { token: adminToken, body: { ...u, password: PASSWORD } });
    console.log(`  created ${u.email}`);
  }
}

// status 'duplicate' = this owner already has these bytes; id is then the existing asset.
async function upload(token: string, photo: Photo, extra: Record<string, string> = {}): Promise<{ id: string; status: string }> {
  const form = new FormData();
  const bytes = readFileSync(join(FIXTURES, photo.file));
  form.append('assetData', new Blob([bytes]), photo.file);
  form.append('fileCreatedAt', photo.at);
  form.append('fileModifiedAt', photo.at);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return api<{ id: string; status: string }>('POST', '/assets', { token, form });
}

// Anna gets 1 of each badge case: a 3-photo stack, a live photo, an edited (rotated) photo.
async function seedSpecialCases(token: string): Promise<void> {
  const burst = await Promise.all(
    [1, 2, 3].map((i) => upload(token, { file: `burst-${i}.jpg`, at: `2026-07-02T16:00:0${i}Z` })),
  );
  // Primary = first id. Re-stacking the same assets on a re-run just replaces the stack.
  await api('POST', '/stacks', { token, body: { assetIds: burst.map((b) => b.id) } });

  // Live photo the way the picker creates family copies: video first,
  // then the still with livePhotoVideoId.
  const at = '2026-07-03T09:00:00Z';
  const motion = await upload(token, { file: 'live-motion.mp4', at });
  await upload(token, { file: 'live-still.jpg', at }, { livePhotoVideoId: motion.id });

  const edited = await upload(token, { file: 'photo-5.jpg', at: '2026-07-02T11:01:00Z' });
  await api('PUT', `/assets/${edited.id}/edits`, {
    token,
    body: { edits: [{ action: 'rotate', parameters: { angle: 90 } }] },
  });
  console.log('  anna: stack, live photo, edited photo');
}

// Bob edits photo-9's metadata inside Immich (→ asset_exif.lockedProperties): the Move must
// carry these onto the family copy.
async function seedBobEdits(token: string): Promise<void> {
  const photo = await upload(token, { file: 'photo-9.jpg', at: '2026-09-20T17:45:00Z' });
  await api('PUT', '/assets', {
    token,
    body: {
      ids: [photo.id],
      description: 'Sunset at the lake',
      latitude: 54.3520,
      longitude: 18.6466,
      rating: 4,
      dateTimeOriginal: '2026-09-20T19:45:00+02:00',
      timeZone: 'Europe/Warsaw',
    },
  });
  console.log('  bob: photo-9 metadata edited in Immich');
}

// Anna's album "Summer trip": 2 photos + a non-primary stack member (the picker's album filter
// then shows the whole stack). Re-uploading returns the existing ids ('duplicate').
const ALBUM = 'Summer trip';
async function seedAlbum(token: string): Promise<void> {
  const files = [
    { file: 'photo-1.jpg', at: '2026-07-01T09:12:00Z' },
    { file: 'photo-2.jpg', at: '2026-07-01T09:40:00Z' },
    { file: 'burst-2.jpg', at: '2026-07-02T16:00:02Z' },
  ];
  const ids = (await Promise.all(files.map((f) => upload(token, f)))).map((r) => r.id);
  const albums = await api<{ id: string; albumName: string }[]>('GET', '/albums', { token });
  const existing = albums.find((a) => a.albumName === ALBUM);
  if (existing) await api('PUT', `/albums/${existing.id}/assets`, { token, body: { ids } });
  else await api('POST', '/albums', { token, body: { albumName: ALBUM, assetIds: ids } });
  console.log(`  anna: album "${ALBUM}"`);
}

async function familyApiKey(token: string): Promise<string> {
  // The secret is only shown at creation → replace the key on every run.
  const keys = await api<{ id: string; name: string }[]>('GET', '/api-keys', { token });
  for (const k of keys.filter((k) => k.name === FAMILY_KEY_NAME)) {
    await api('DELETE', `/api-keys/${k.id}`, { token });
  }
  const created = await api<{ secret: string }>('POST', '/api-keys', {
    token,
    body: { name: FAMILY_KEY_NAME, permissions: FAMILY_KEY_PERMISSIONS },
  });
  return created.secret;
}

function convergePickerDb(): void {
  execFileSync('docker', [
    ...COMPOSE, 'exec', '-T', 'database', 'psql', '-q', '-v', 'ON_ERROR_STOP=1',
    '-v', `u=${PICKER_DB.user}`, '-v', `p=${PICKER_DB.password}`,
    '-U', 'postgres', '-d', 'immich',
  ], { input: readFileSync(join(DEV, 'picker-db.sql')), stdio: ['pipe', 'inherit', 'inherit'] });
}

async function main(): Promise<void> {
  console.log('fixtures');
  generateFixtures();

  console.log('users');
  try {
    await api('POST', '/auth/admin-sign-up', { body: { ...USERS.admin, password: PASSWORD } });
    console.log(`  created ${USERS.admin.email}`);
  } catch (err) {
    if (!/HTTP 400/.test((err as Error).message)) throw err; // 400 = admin exists already
  }
  await ensureUsers(await login(USERS.admin.email));

  for (const who of ['anna', 'bob', 'family'] as const) {
    const token = await login(USERS[who].email);
    const results = await Promise.all(UPLOADS[who].map((p) => upload(token, p)));
    const created = results.filter((r) => r.status === 'created').length;
    console.log(`  ${who}: ${created} uploaded, ${results.length - created} already there`);
    if (who === 'anna') await seedSpecialCases(token);
    if (who === 'anna') await seedAlbum(token);
    if (who === 'bob') await seedBobEdits(token);
  }

  console.log('family API key + picker DB role');
  const familyKey = await familyApiKey(await login(USERS.family.email));
  convergePickerDb();

  mkdirSync(join(DATA, 'metrics'), { recursive: true });
  const env = {
    PICKER_LISTEN: '127.0.0.1:2284',
    IMMICH_API_URL: API,
    IMMICH_FAMILY_API_KEY: familyKey,
    PGHOST: '127.0.0.1',
    PGPORT: '55432',
    PGDATABASE: 'immich',
    PGUSER: PICKER_DB.user,
    PGPASSWORD: PICKER_DB.password,
    PICKER_LIBRARY_MOUNT: resolve(DATA, 'immich'),
    PICKER_LIBRARY_SUBDIRS: 'upload,library,backups,encoded-video',
    PICKER_THUMBS_DIR: resolve(DATA, 'immich', 'thumbs'),
    PICKER_METRICS_DIR: resolve(DATA, 'metrics'),
    PICKER_DATA_DIR: resolve(DATA, 'picker'),
  };
  writeFileSync(
    join(DEV, '.env.local'),
    `# Written by \`npm run dev:seed\` for the local dev Immich only.\n${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`,
    { mode: 0o600 },
  );
  console.log(`done → dev/.env.local
  Immich web: http://127.0.0.1:2283  (${Object.values(USERS).map((u) => u.email).join(', ')}; password ${PASSWORD})
  next: npm run dev:app   (or npm run dev:app:container)`);
}

await main();
