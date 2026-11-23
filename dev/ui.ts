// The real page against made-up data: no Docker, no Immich, no Postgres. For trying the UI only.
//   - Immich: test/fakes.ts' fakeImmich with 3 members (1 without photos), a family timeline, albums
//     and SVG "photos".
//   - Queue: in memory, seeded per scenario (/dev lists them; /dev/scenario/<name> switches).
//   - Worker: a stand-in that walks queued jobs through their steps every 1.5 s; some fail on
//     their 1st try (automatic retry after 20 s), some are refused (wait for Retry).
//   - Login: always logged in as CURATOR (no provider); Sign out leads to /dev.
// Never listen on anything but loopback.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { notices, sendNotice, type Notice } from '../src/auth.ts';
import type { GridItem, GuardResult } from '../src/immich/index.ts';
import { openQueue, type Job, type Queue, type Step } from '../src/queue.ts';
import { buildApp, type ServerImmich } from '../src/server.ts';
import { FAMILY_ID } from '../test/fakes.ts';

const PORT = Number(process.env.PORT ?? 2285);
const MEDIA = join(import.meta.dirname, '.data', 'ui-media');
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const CURATOR = 'curator@example.test';

// --- photos ------------------------------------------------------------------------------------
const media: Record<string, string> = {};
const names: Record<string, string> = {};
mkdirSync(MEDIA, { recursive: true });
const svg = (id: string, label: string, hue: number, w: number, h: number) => {
  const file = join(MEDIA, `${id}.svg`);
  writeFileSync(
    file,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 60%)"/>` +
      `<stop offset="1" stop-color="hsl(${(hue + 60) % 360} 70% 35%)"/></linearGradient></defs>` +
      `<rect width="100%" height="100%" fill="url(#g)"/>` +
      `<text x="50%" y="50%" fill="white" font-family="sans-serif" font-size="${Math.round(w / 12)}" ` +
      `text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`,
  );
  media[`${id}/thumbnail`] = file;
  media[`${id}/preview`] = file;
};

let next = 1;
const photo = (owner: string, day: string, extra: Partial<GridItem> = {}): GridItem => {
  const n = next++;
  const id = uuid(n);
  const portrait = n % 4 === 0;
  const [w, h] = portrait ? [600, 800] : [800, 600];
  const fileName = `${owner}_${String(n).padStart(4, '0')}.${extra.type === 'video' ? 'mp4' : 'jpg'}`;
  names[id] = fileName;
  svg(id, fileName, (n * 37) % 360, w, h);
  return {
    id,
    type: 'image',
    localDateTime: `${day}T${String(8 + (n % 12)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00.000Z`,
    day,
    fileName,
    width: w,
    height: h,
    durationMs: null,
    livePhotoVideoId: null,
    stack: null,
    files: 1,
    edited: false,
    ...extra,
  };
};
const run = (from: string, count: number) =>
  Array.from({ length: count }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

const ANNA = uuid(0xa001);
const BOB = uuid(0xb001);
// The admin sorts first and has no photos, as in a real installation.
const members = [
  { id: uuid(0xad01), name: 'Admin', email: 'admin@example.test' },
  { id: ANNA, name: 'Anna', email: 'anna@example.test' },
  { id: BOB, name: 'Bob', email: 'bob@example.test' },
];

// Anna's albums, each with the photos in it (so the album filter and the albums a moved photo
// was in, in its history, match what the grid shows).
const albumPhotos = new Map<string, { name: string; ids: Set<string> }>();
const inAlbum = (id: string, name: string, items: GridItem[]) => {
  const a = albumPhotos.get(id) ?? { name, ids: new Set<string>() };
  for (const i of items) a.ids.add(i.id);
  albumPhotos.set(id, a);
  return items;
};
const perDay = (days: string[], n: number) => days.flatMap((day) => Array.from({ length: n }, () => photo('anna', day)));
const october = run('2026-10-01', 8).flatMap((day, d) =>
  Array.from({ length: 6 }, (_, i) => {
    const k = d * 6 + i;
    if (k === 2) return photo('anna', day, { type: 'video', durationMs: 12_000 });
    if (k === 4) return photo('anna', day, { livePhotoVideoId: uuid(0xf001), files: 2 });
    if (k === 7) return photo('anna', day, { stack: { id: uuid(0xf002), size: 3 }, files: 3 });
    if (k === 9) return photo('anna', day, { edited: true });
    if (k === 11) return photo('anna', day, { inFamily: true });
    return photo('anna', day);
  }),
);
inAlbum(uuid(0xc002), 'Garden', october.filter((p) => p.day === '2026-10-02'));
inAlbum(uuid(0xc001), 'Holidays', october.filter((p, i) => p.day >= '2026-10-03' && i % 2 === 0));
inAlbum(uuid(0xc001), 'Holidays', october.filter((p) => p.day === '2026-10-02').slice(0, 2)); // in 2 albums
const anna = [
  ...october,
  ...inAlbum(uuid(0xc003), 'Żółw w zoo', perDay(['2026-08-14', '2026-09-02'], 4)),
  ...perDay(['2026-07-20'], 3), // in no album
  ...inAlbum(uuid(0xc004), 'Christmas', perDay(['2025-12-24', '2025-12-31', '2026-01-02'], 3)),
  ...inAlbum(uuid(0xc005), 'Birthday party', perDay(['2025-06-07'], 5)),
  ...inAlbum(uuid(0xc007), 'First day of school', perDay(['2024-09-02'], 3)),
  ...inAlbum(uuid(0xc006), 'Mountains', perDay(run('2024-07-01', 3), 4)),
].sort((a, b) => b.localDateTime.localeCompare(a.localDateTime));
const byId = new Map(anna.map((p) => [p.id, p]));
// Newest first, as Immich's query returns them.
const annaAlbums = [...albumPhotos].map(([id, a]) => {
  const days = [...a.ids].map((i) => byId.get(i)!.day).sort();
  return { id, name: a.name, count: a.ids.size, from: days[0]!, to: days.at(-1)! };
});
annaAlbums.sort((a, b) => b.to.localeCompare(a.to));
const albumsOf = (assetId: string) => [...albumPhotos.values()].filter((a) => a.ids.has(assetId)).map((a) => a.name).sort();
// What the real worker writes with 'copied': the files of a live photo or stack (how many were
// copied only at a 1st try, all or none here), and the albums the originals are in.
const copyNote = (q: Queue, job: Job) => {
  const notes: string[] = [];
  const photo = byId.get(job.sourceAssetId);
  const files = photo?.files ?? 1;
  if (files > 1) notes.push(q.events(job.id)?.length === 1 && !photo?.inFamily ? `${files} files copied` : `${files} files`);
  const a = albumsOf(job.sourceAssetId);
  if (a.length) notes.push(`In album${a.length > 1 ? 's' : ''}: ${a.join(', ')}`);
  return notes.length ? notes.join(' • ') : undefined;
};
// As the real worker: a photo the family account already has is not copied, and only a 1st try
// (nothing but 'queued' in the history) knows it was there before.
const copyOutcome = (q: Queue, job: Job) => {
  if (!byId.get(job.sourceAssetId)?.inFamily) return undefined;
  return q.events(job.id)?.length === 1 ? 'existing' : 'unknown';
};

const bob = run('2026-10-10', 3).flatMap((day) => Array.from({ length: 4 }, () => photo('bob', day)));
const family = run('2026-10-20', 3).flatMap((day, d) =>
  Array.from({ length: 5 }, (_, i) => photo('family', day, d === 2 && i === 4 ? { noOrigin: true } : {})),
);
// New uploads whose thumbnails Immich is still making, and some it never will (thumbnails scenario).
const fresh = run('2026-11-20', 1).flatMap((day) => Array.from({ length: 8 }, () => photo('family', day)));
// Photos only the long queues use (a photo can have 1 unfinished job only), on no timeline.
const bulk = run('2026-05-01', 40).flatMap((day) => Array.from({ length: 10 }, () => photo('anna', day)));

// --- scenarios -----------------------------------------------------------------------------------
type World = {
  timelines: Record<string, GridItem[]>;
  albums: boolean;
  queue: Queue;
  paused?: string[];
  guard?: GuardResult;
  // "Check again" finds Immich back after this many checks that still fail; never when not set.
  recheckFails?: number;
  pending?: Map<string, number>; // asset id → when its thumbnail is "made" (ms)
  broken?: Set<string>;
};
const allPhotos = () => ({ [ANNA]: anna, [BOB]: bob, [FAMILY_ID]: family });
const FETCH_FAILED = 'Immich POST /assets: fetch failed (UND_ERR_SOCKET other side closed)';
const MOVE_STEPS: Step[] = ['copied', 'archived', 'linked', 'thumbnailed'];
const later = (min: number) => new Date(Date.now() + min * 60_000);

/** Seeding helpers bound to 1 queue. */
function seeder(queue: Queue) {
  const claim = (kind: 'move' | 'giveback', assetId: string, memberId: string | null): Job => {
    queue.enqueue(kind, [assetId], { memberId, requestedBy: CURATOR });
    const job = queue.claimNext();
    if (!job || job.sourceAssetId !== assetId) throw new Error(`seed: could not claim ${assetId}`);
    return job;
  };
  const moveTo = (job: Job, upTo: number) => {
    for (const step of MOVE_STEPS.slice(0, upTo)) {
      queue.advance(job.id, {
        step,
        familyAssetId: step === 'copied' ? family[job.id % family.length]!.id : undefined,
        originals: step === 'copied' ? [job.sourceAssetId] : undefined,
        note: step === 'copied' ? copyNote(queue, job) : undefined,
        outcome: step === 'copied' ? copyOutcome(queue, job) : undefined,
        done: step === 'thumbnailed',
      });
    }
  };
  const giveBack = (job: Job, originalId: string) => {
    queue.advance(job.id, { step: 'restored', originals: [originalId], familyIds: [job.sourceAssetId] });
    queue.advance(job.id, { step: 'deleted', done: true });
  };
  return { claim, moveTo, giveBack };
}

/** A job in every state the Queue page shows. */
function everyState(queue: Queue) {
  const { claim, moveTo, giveBack } = seeder(queue);
  // Done: enough for "Load more"; every 7th failed (and was retried) on the way.
  for (let i = 0; i < 130; i++) {
    const job = claim('move', anna[i % anna.length]!.id, ANNA);
    if (i % 7 === 3) {
      queue.retryLater(job.id, FETCH_FAILED, new Date());
      queue.claimNext();
      moveTo(job, 2);
      queue.fail(job.id, 'not linked: file not found (a retry re-reads the paths)');
      queue.retry(job.id, CURATOR);
      queue.claimNext();
    }
    moveTo(job, 4);
  }
  for (let i = 0; i < 4; i++) giveBack(claim('giveback', family[i]!.id, null), anna[i]!.id);
  // The newest done: a photo the family account already had, moved at its 1st try and after a
  // failure (the 2 history lines of a copy step that uploaded nothing).
  const shared = anna.find((p) => p.inFamily)!;
  moveTo(claim('move', shared.id, ANNA), 4);
  {
    const job = claim('move', shared.id, ANNA);
    queue.retryLater(job.id, FETCH_FAILED, new Date());
    queue.claimNext();
    moveTo(job, 4);
  }

  // Failed: a refusal, a transient failure that kept failing, a refused give back.
  queue.fail(claim('move', bob[0]!.id, BOB).id, 'not moved: the photo is in the trash');
  {
    const job = claim('move', bob[1]!.id, BOB);
    moveTo(job, 1);
    for (let a = 0; a < 3; a++) {
      queue.retryLater(job.id, FETCH_FAILED, new Date());
      queue.claimNext();
    }
    queue.fail(job.id, 'Immich PUT /assets: no answer in 30 s');
  }
  queue.fail(claim('giveback', family[14]!.id, null).id, 'original not restored: no original with the same bytes');

  // In progress: retrying later, waiting for thumbnails, running (stays: the stand-in worker only
  // runs the jobs it claims), and a few queued for the stand-in worker to pick up.
  {
    const job = claim('move', bob[2]!.id, BOB);
    moveTo(job, 2);
    queue.retryLater(job.id, 'Immich GET /server/version: no answer in 15 s', later(4));
  }
  {
    const job = claim('move', bob[3]!.id, BOB);
    moveTo(job, 3);
    queue.wait(job.id);
  }
  moveTo(claim('move', bob[4]!.id, BOB), 1);
  queue.enqueue('move', bob.slice(5, 9).map((a) => a.id), { memberId: BOB, requestedBy: CURATOR });
}

const ERRORS = [
  'not moved: the photo is in the trash',
  'not moved: the photo is not on the timeline',
  'Immich PUT /assets: no answer in 30 s',
  'not linked: the files differ (size 2 104 331 ≠ 2 104 330)',
  'not moved: part of a stack whose other photos belong to someone else',
  FETCH_FAILED,
];

const SCENARIOS: Record<string, { about: string; open: string; build: () => World }> = {
  default: {
    about: 'Photos, albums and a job in every state',
    open: '/queue',
    build() {
      const queue = openQueue(':memory:');
      everyState(queue);
      return { timelines: allPhotos(), albums: true, queue };
    },
  },
  'empty-queue': {
    about: 'Photos, nothing ever queued',
    open: '/queue',
    build: () => ({ timelines: allPhotos(), albums: true, queue: openQueue(':memory:') }),
  },
  'empty-accounts': {
    about: 'Members and the family account without a single photo or album',
    open: `/members/${ANNA}`,
    build: () => ({ timelines: {}, albums: false, queue: openQueue(':memory:') }),
  },
  'long-in-progress': {
    about: '400 queued, some running, retrying or waiting for thumbnails',
    open: '/queue',
    build() {
      const queue = openQueue(':memory:');
      const { claim, moveTo } = seeder(queue);
      for (let i = 0; i < 6; i++) {
        const job = claim('move', anna[i]!.id, ANNA);
        moveTo(job, 1 + (i % 3));
        if (i % 3 === 1) queue.retryLater(job.id, FETCH_FAILED, later(2 + i));
        if (i % 3 === 2) queue.wait(job.id);
      }
      queue.enqueue('move', bulk.map((p) => p.id), { memberId: ANNA, requestedBy: CURATOR });
      return { timelines: allPhotos(), albums: true, queue };
    },
  },
  'long-failed': {
    about: '300 failed jobs, assorted reasons',
    open: '/queue',
    build() {
      const queue = openQueue(':memory:');
      const { claim, moveTo } = seeder(queue);
      for (let i = 0; i < 300; i++) {
        const job = claim('move', bulk[i]!.id, ANNA);
        moveTo(job, i % 3);
        queue.fail(job.id, ERRORS[i % ERRORS.length]!);
      }
      return { timelines: allPhotos(), albums: true, queue };
    },
  },
  thumbnails: {
    about: 'Family copies whose thumbnails Immich is still making (ready within 1 min), 2 it never made',
    open: '/family',
    build() {
      const queue = openQueue(':memory:');
      const now = Date.now();
      const pending = new Map(fresh.slice(0, 6).map((p, i) => [p.id, now + 15_000 + i * 8_000]));
      const broken = new Set([...fresh.slice(6).map((p) => p.id), bob[3]!.id]);
      const { claim, moveTo } = seeder(queue);
      for (let i = 0; i < 6; i++) {
        const job = claim('move', anna[i]!.id, ANNA);
        moveTo(job, 3);
        queue.wait(job.id);
      }
      return { timelines: { ...allPhotos(), [FAMILY_ID]: [...fresh, ...family] }, albums: true, queue, pending, broken };
    },
  },
  paused: {
    about: 'Immich unreachable: read-only, worker paused, jobs waiting; the 2nd "Check again" finds it back',
    open: '/queue',
    build() {
      const queue = openQueue(':memory:');
      queue.enqueue('move', bob.slice(0, 5).map((a) => a.id), { memberId: BOB, requestedBy: CURATOR });
      const problems = ['Immich version check failed: Immich GET /server/version: fetch failed (ECONNREFUSED)'];
      return {
        timelines: allPhotos(), albums: true, queue, paused: problems, recheckFails: 1,
        guard: { ok: false, problems, checkedAt: new Date() },
      };
    },
  },
  'read-only': {
    about: 'Upgrade guard failed: no Move or Give back; "Check again" changes nothing',
    open: `/members/${ANNA}`,
    build: () => ({
      timelines: allPhotos(),
      albums: true,
      queue: openQueue(':memory:'),
      guard: { ok: false, problems: ['Immich 3.5.0 is not a supported version (3.4.1)'], checkedAt: new Date() },
    }),
  },
};

let scenario = 'default';
let world = SCENARIOS[scenario]!.build();

// The app is built once; its Immich and queue follow the current scenario.
const immich: ServerImmich = {
  members: async () => members.map((m) => ({ ...m, hasPhotos: (world.timelines[m.id] ?? []).length > 0 })),
  memberTimeline: async (id, f = {}) =>
    (world.timelines[id] ?? []).filter(
      (i) => (!f.albumId || albumPhotos.get(f.albumId)?.ids.has(i.id)) && (!f.from || i.day >= f.from) && (!f.to || i.day <= f.to),
    ),
  memberAlbums: async (id) => (world.albums && id === ANNA ? annaAlbums : []),
  familyTimeline: async () => world.timelines[FAMILY_ID] ?? [],
  async mediaFile(id, kind) {
    if (world.broken?.has(id)) return null;
    const ready = world.pending?.get(id);
    if (ready && Date.now() < ready && kind !== 'video') return 'pending';
    return media[`${id}/${kind}`] ?? null;
  },
  fileNames: async (ids) => new Map(ids.filter((id) => names[id]).map((id) => [id, names[id]!])),
  ping: async () => ({ db: 'ok', api: 'ok' }),
};
const queue = new Proxy({} as Queue, {
  get: (_, k) => {
    const v: unknown = Reflect.get(world.queue, k);
    return typeof v === 'function' ? v.bind(world.queue) : v;
  },
});

// --- stand-in worker ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let running = false;
const work = async (q: Queue, job: Job) => {
  const { giveBack } = seeder(q);
  await sleep(1_500);
  if (job.id % 5 === 0 && job.attempts === 0) return q.retryLater(job.id, FETCH_FAILED, new Date(Date.now() + 20_000));
  if (job.id % 11 === 0) return q.fail(job.id, 'not moved: the photo is not on the timeline');
  if (job.kind === 'giveback') return giveBack(job, anna[job.id % anna.length]!.id);
  for (const [i, step] of MOVE_STEPS.entries()) {
    if (MOVE_STEPS.indexOf(job.step as Step) >= i) continue;
    if (step === 'thumbnailed') {
      q.wait(job.id);
      await sleep(4_000);
    }
    q.advance(job.id, {
      step,
      familyAssetId: step === 'copied' ? family[0]!.id : undefined,
      originals: step === 'copied' ? [job.sourceAssetId] : undefined,
      note: step === 'copied' ? copyNote(q, job) : undefined,
      outcome: step === 'copied' ? copyOutcome(q, job) : undefined,
      done: step === 'thumbnailed',
    });
    await sleep(1_500);
  }
};
const worker = {
  kick() {
    if (running || world.paused) return;
    running = true;
    const q = world.queue; // a scenario switch mid-job leaves the old queue to finish alone
    void (async () => {
      for (let job = q.claimNext(); job && q === world.queue && !world.paused; job = q.claimNext()) await work(q, job);
    })().finally(() => (running = false));
  },
  state: () => ({ running, paused: !!world.paused, pausedReason: world.paused ?? [] }),
  async recheck() {
    const w = world;
    await sleep(1_500);
    if (w === world && w.recheckFails !== undefined && w.recheckFails-- <= 0) {
      w.paused = undefined;
      w.guard = undefined;
      const found = worker.state();
      worker.kick();
      return found;
    }
    return worker.state();
  },
};
setInterval(() => worker.kick(), 5_000).unref();

const app = await buildApp(
  { immich, queue, worker, guard: () => world.guard ?? { ok: true, problems: [], checkedAt: new Date() } },
  { logger: true },
);
// Logged in, as the real login would leave it.
app.addHook('onRequest', async (req) => {
  req.user = { sub: 'dev', email: CURATOR, name: 'Curator', groups: [] };
});
app.post('/oauth2/sign_out', async () => ({ next: '/dev' }));

// The pages the real login shows outside the app, as it would send them. Their links lead back
// here instead of to a provider.
const DEV_LOGOUT = new URL(`http://127.0.0.1:${PORT}/dev`);
const LOGIN_PAGES: Record<string, () => Notice> = {
  'signed out': notices.signedOut,
  'login took too long': notices.stale,
  'login did not succeed': () => notices.failed(502),
  'refused by the provider': () => notices.refused(null, DEV_LOGOUT),
  'refused by the picker (not in an allowed group)': () => notices.refused('outsider@example.test', DEV_LOGOUT),
  'refused, no logout URL set': () => notices.refused('outsider@example.test', null),
  'account without an email': () => notices.noEmail(DEV_LOGOUT),
};

// The scenarios: a list, and a switch that starts it afresh and opens the page that shows it.
app.get('/dev', async (_req, reply) => {
  const rows = Object.entries(SCENARIOS)
    .map(
      ([name, s]) =>
        `<li class="py-2"><a class="text-sky-300" href="/dev/scenario/${name}">${name}</a>${name === scenario ? ' <strong>(current)</strong>' : ''}` +
        `<div class="text-sm text-neutral-400">${s.about}</div></li>`,
    )
    .join('');
  const pages = Object.keys(LOGIN_PAGES)
    .map((name) => `<li class="py-2"><a class="text-sky-300" href="/dev/login-page/${encodeURIComponent(name)}">${name}</a></li>`)
    .join('');
  return reply
    .type('text/html')
    .send(`<!doctype html><meta charset="utf-8"><title>Dev UI scenarios</title><link rel="stylesheet" href="/app.css">` +
      `<main class="p-6"><h1 class="text-base font-semibold">Dev UI scenarios</h1><ul class="divide-y divide-white/5">${rows}</ul>` +
      `<h2 class="mt-6 text-base font-semibold">Login pages</h2><ul class="divide-y divide-white/5">${pages}</ul></main>`);
});
app.get<{ Params: { name: string } }>('/dev/login-page/:name', async (req, reply) => {
  const notice = LOGIN_PAGES[req.params.name];
  if (!notice) return reply.code(404).send({ error: `no login page ${req.params.name}` });
  return sendNotice(reply, notice());
});
app.get<{ Params: { name: string } }>('/dev/scenario/:name', async (req, reply) => {
  const s = SCENARIOS[req.params.name];
  if (!s) return reply.code(404).send({ error: `no scenario ${req.params.name}` });
  scenario = req.params.name;
  world = s.build();
  worker.kick();
  return reply.redirect(s.open);
});

await app.listen({ host: '127.0.0.1', port: PORT });
console.log(`Dev UI: http://127.0.0.1:${PORT}/  •  scenarios: http://127.0.0.1:${PORT}/dev`);
worker.kick();
