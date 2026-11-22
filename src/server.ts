import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyBasicAuth from '@fastify/basic-auth';
import fastifyCookie from '@fastify/cookie';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { cookieNaming, isSafeMethod, registerAuth, type AuthDeps } from './auth.ts';
import type { GridItem, GuardResult, Immich, MediaKind } from './immich/index.ts';
import type { Kind, ListedJob, Queue, Section } from './queue.ts';
import type { Worker } from './worker.ts';

// The HTTP layer only reads from Immich; writes happen in the worker.
export type ServerImmich = Pick<
  Immich,
  'members' | 'memberTimeline' | 'memberAlbums' | 'familyTimeline' | 'mediaFile' | 'fileNames' | 'ping'
>;

export type ServerDeps = {
  immich: ServerImmich;
  // Last guard result (checked on start and before each job).
  guard: () => GuardResult | undefined;
  queue: Pick<
    Queue,
    'enqueue' | 'retry' | 'counts' | 'failed' | 'unfinishedAssetIds' | 'unfinishedAtStep' | 'retrying' | 'list' | 'events'
  >;
  worker: Pick<Worker, 'kick' | 'state'>;
};

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
// URL file name → browser module on disk (the names index.html's import map uses).
const VENDOR = {
  'preact.mjs': fileURLToPath(import.meta.resolve('preact')),
  'preact-hooks.mjs': fileURLToPath(import.meta.resolve('preact/hooks')),
  'htm.mjs': fileURLToPath(import.meta.resolve('htm')),
};
// The page's font (Overpass, as in Immich's web app), Latin with Polish and other accents; the
// @font-face rules are in styles/app.css.
const font = (file: string) => fileURLToPath(import.meta.resolve(`@fontsource-variable/overpass/files/${file}`));
const FONTS = {
  'overpass-latin.woff2': font('overpass-latin-wght-normal.woff2'),
  'overpass-latin-ext.woff2': font('overpass-latin-ext-wght-normal.woff2'),
};

// Response schemas double as an allow-list: Fastify's serializer drops any field not listed.
const nullable = (type: string) => ({ type: [type, 'null'] });
const memberSchema = {
  type: 'object',
  required: ['id', 'name', 'email', 'hasPhotos'],
  properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, hasPhotos: { type: 'boolean' } },
} as const;
const gridItemSchema = {
  type: 'object',
  required: ['id', 'type', 'localDateTime', 'day', 'fileName', 'edited'],
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['image', 'video'] },
    localDateTime: { type: 'string' },
    day: { type: 'string' },
    fileName: { type: 'string' },
    width: nullable('integer'),
    height: nullable('integer'),
    durationMs: nullable('integer'),
    livePhotoVideoId: nullable('string'),
    stack: {
      type: ['object', 'null'],
      properties: { id: { type: 'string' }, size: { type: 'integer' } },
    },
    edited: { type: 'boolean' },
    inFamily: { type: 'boolean' },
    noOrigin: { type: 'boolean' },
  },
} as const;
const errorSchema = { type: 'object', properties: { error: { type: 'string' } } } as const;
const uuidParam = { type: 'string', format: 'uuid' } as const;
const memberParams = { type: 'object', required: ['id'], properties: { id: uuidParam } } as const;
const assetIds = { type: 'array', minItems: 1, maxItems: 10_000, uniqueItems: true, items: uuidParam } as const;
const jobParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } as const;
const listedJobSchema = {
  type: 'object',
  required: ['id', 'kind', 'status', 'step', 'attempts', 'sourceAssetId', 'thumbAssetId', 'createdAt', 'updatedAt', 'failures'],
  properties: {
    id: { type: 'integer' },
    kind: { type: 'string', enum: ['move', 'giveback'] },
    status: { type: 'string', enum: ['pending', 'running', 'done', 'failed'] },
    step: { type: 'string' },
    error: nullable('string'),
    attempts: { type: 'integer' },
    retryAt: nullable('string'),
    waitingSince: nullable('string'),
    sourceAssetId: { type: 'string' },
    thumbAssetId: { type: 'string' },
    fileName: nullable('string'),
    memberId: nullable('string'),
    requestedBy: nullable('string'),
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    failures: { type: 'integer' },
  },
} as const;

type AppOptions = {
  logger?: boolean;
  // Login (OIDC). Without it every request is let in: only with PICKER_AUTH=off (dev, tests).
  auth?: AuthDeps | null;
  // Serve HTTPS with this certificate (PEM), e.g. when the network reaches the picker directly.
  https?: { key: Buffer; cert: Buffer } | null;
  // Basic-auth credentials for /healthz; without them it is open (dev, tests).
  healthz?: { user: string; password: string } | null;
};

export async function buildApp(deps: ServerDeps, opts: AppOptions = {}): Promise<FastifyInstance> {
  // With the https option Fastify types the instance as an https server's; nothing here depends
  // on which, so it is used as the plain type.
  const app = Fastify({
    logger: opts.logger ?? false,
    // A grid view fires hundreds of thumbnail requests; log errors, not every request.
    logController: new LogController({ disableRequestLogging: true }),
    ...(opts.https ? { https: opts.https } : {}),
  }) as unknown as FastifyInstance;

  // Every request passes these onRequest hooks, in this order, before its route's schema check and
  // handler: 1. the security headers (helmet), 2. the login (auth.ts; routes marked
  // `config: { public: true }` skip it), 3. the CSRF token on writes.
  app.decorateRequest('user', null);
  // First, so every route uses them, the login routes too: no internals in a 5xx, errors as
  // { error }.
  app.setErrorHandler((err: { statusCode?: number; message: string; headers?: Record<string, string> }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (err.headers) reply.headers(err.headers); // e.g. Content-Range on a 416 from sendFile
    if (status >= 500) {
      req.log.error({ err }, `${req.method} ${req.url} failed`);
      return reply.code(status).send({ error: 'internal error' }); // no internals to the browser
    }
    return reply.code(status).send({ error: err.message });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));
  // Signs the login-in-progress and CSRF cookies. With the login on, a key derived from the one in
  // sessions.db, so a restart doesn't void the open pages' CSRF cookies; else 1 per process.
  const cookieSecret = opts.auth
    ? createHash('sha256').update(`picker cookies:${opts.auth.sessions.cookieSecret}`).digest()
    : randomBytes(32);
  await app.register(fastifyCookie, { secret: cookieSecret });
  const { secure, prefix } = cookieNaming(opts.auth?.config.publicUrl);
  // Defence in depth for the page: only our own scripts/media, plus the 1 inline import map; no
  // framing, no referrer. upgrade-insecure-requests only when the picker is reached over https:
  // on plain http (dev, tests) it would send the page's own requests to an https that isn't there.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: { useDefaults: false, directives: { ...cspDirectives(), upgradeInsecureRequests: secure ? [] : null } },
    referrerPolicy: { policy: 'no-referrer' },
    // Browsers keep to https for this host for a year (they ignore the header on plain http).
    strictTransportSecurity: { maxAge: 365 * 24 * 3600, includeSubDomains: true },
  });
  if (opts.auth) await registerAuth(app, opts.auth);
  // Every write carries a token from GET /api/csrf in its csrf-token header, checked against a
  // secret in a signed cookie. Another site can't read the token, and a cross-origin request
  // can't set the header without a CORS preflight the picker never allows.
  await app.register(fastifyCsrf, {
    cookieKey: `${prefix}picker_csrf`,
    cookieOpts: { path: '/', httpOnly: true, sameSite: 'strict', secure, signed: true },
    getToken: (req) => req.headers['csrf-token'] as string | undefined,
  });
  app.addHook('onRequest', (req, reply, done) => (isSafeMethod(req.method) ? done() : app.csrfProtection(req, reply, done)));

  // Serves the page (public/, no directory listing, files registered at startup) and provides
  // reply.sendFile() for media. Dotfiles (the hard-link step's .picker-*.tmp names) are never
  // sent: 'ignore' answers them as 404.
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    wildcard: false,
    dotfiles: 'ignore',
    // max-age=0: browsers revalidate the page files on every load (cheap, via ETag). Without a
    // Cache-Control header they cache heuristically and keep running an old app.js after an
    // update. Media and vendor files pass their own longer max-age.
    cacheControl: true,
    maxAge: 0,
  });

  // The page's own URLs (client-side routes) all load the same index.html.
  const page = (_req: unknown, reply: FastifyReply) => reply.sendFile('index.html');
  app.get('/family', page);
  app.get('/queue', page);
  app.get('/members/:id', { schema: { params: memberParams } }, page);

  // Browser builds of the UI libraries, straight from node_modules (no CDN, no build step).
  app.get<{ Params: { file: keyof typeof VENDOR } }>(
    '/vendor/:file',
    { schema: { params: { type: 'object', properties: { file: { type: 'string', enum: Object.keys(VENDOR) } } } } },
    (req, reply) => {
      const path = VENDOR[req.params.file];
      return reply.sendFile(basename(path), dirname(path), { maxAge: '1d', cacheControl: true });
    },
  );
  app.get<{ Params: { file: keyof typeof FONTS } }>(
    '/fonts/:file',
    // No login needed: the pages shown without one (signed out, login refused) use the font too.
    { config: { public: true }, schema: { params: { type: 'object', properties: { file: { type: 'string', enum: Object.keys(FONTS) } } } } },
    (req, reply) => {
      const path = FONTS[req.params.file];
      return reply.sendFile(basename(path), dirname(path), { maxAge: '30d', cacheControl: true });
    },
  );


  // 200 when the DB and Immich are reachable, even when the guard fails (the app stays up,
  // read-only). It names internal errors, so outside dev it needs its own basic auth (probes have
  // no login session).
  // The last guard result, or "not checked yet" before the 1st check.
  const guardState = () => deps.guard() ?? { ok: false, problems: ['not checked yet'] };

  if (opts.healthz) {
    const digest = (s: string) => createHash('sha256').update(s).digest();
    const expected = digest(`${opts.healthz.user}:${opts.healthz.password}`);
    await app.register(fastifyBasicAuth, {
      // Compared as digests of equal length, in constant time.
      validate: async (user, password) => {
        if (!timingSafeEqual(digest(`${user}:${password}`), expected)) throw new Error('unauthorized');
      },
      authenticate: { realm: 'picker healthz' },
    });
  }
  app.get('/healthz', { config: { public: true }, onRequest: opts.healthz ? app.basicAuth : [] }, async (_req, reply) => {
    const { db, api: immich } = await deps.immich.ping();
    const { ok, problems } = guardState();
    return reply.code(db === 'ok' && immich === 'ok' ? 200 : 503).send({ db, immich, guard: { ok, problems } });
  });

  // The token every write carries (see the CSRF hook above).
  app.get('/api/csrf', async (_req, reply) => ({ token: await reply.generateCsrf() }));

  // user: who is logged in (null with the login off: then the page shows no sign-out).
  app.get('/api/status', async (req) => {
    const { ok, problems } = guardState();
    return { readOnly: !ok, problems, user: req.user?.email ?? null };
  });

  app.get('/api/members', { schema: { response: { 200: { type: 'array', items: memberSchema } } } }, async () =>
    deps.immich.members(),
  );
  // Only a live member is a picking source, never the family account.
  const isMember = async (id: string) => (await deps.immich.members()).some((m) => m.id === id);

  const day = { type: 'string', format: 'date' } as const; // YYYY-MM-DD

  // An asset with an unfinished job stays out of the grids until the job is done: a move archives
  // the original only a few steps in, and a failed job is retried from the jobs list, not picked
  // again.
  const withoutQueued = (items: GridItem[], kind: Kind) => {
    const busy = deps.queue.unfinishedAssetIds(kind);
    return busy.size ? items.filter((i) => !busy.has(i.id)) : items;
  };

  app.get<{ Params: { id: string }; Querystring: { album?: string; from?: string; to?: string } }>(
    '/api/members/:id/assets',
    {
      schema: {
        params: memberParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { album: uuidParam, from: day, to: day },
        },
        response: { 200: { type: 'array', items: gridItemSchema }, 404: errorSchema },
      },
    },
    async (req, reply) => {
      if (!(await isMember(req.params.id))) return reply.code(404).send({ error: 'no such member' });
      const { album, from, to } = req.query;
      return withoutQueued(await deps.immich.memberTimeline(req.params.id, { albumId: album, from, to }), 'move');
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/members/:id/albums',
    {
      schema: {
        params: memberParams,
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'name', 'count', 'from', 'to'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                count: { type: 'integer' },
                from: { type: 'string' },
                to: { type: 'string' },
              },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!(await isMember(req.params.id))) return reply.code(404).send({ error: 'no such member' });
      return deps.immich.memberAlbums(req.params.id);
    },
  );

  app.get(
    '/api/family/assets',
    { schema: { response: { 200: { type: 'array', items: gridItemSchema } } } },
    async () => withoutQueued(await deps.immich.familyTimeline(), 'giveback'),
  );

  // --- Move to family and Give back: 1 queue of jobs -----------------------------------------
  app.get('/api/jobs', async () => {
    const counts = deps.queue.counts();
    const failed = deps.queue.failed();
    // File names for the failed list come from Immich (the queue only keeps ids).
    const names = await deps.immich.fileNames(failed.map((f) => f.sourceAssetId));
    return {
      pending: counts.pending,
      running: counts.running,
      done: counts.done,
      movesDone: deps.queue.counts('move').done, // for the Storage Template reminder
      // Moves copied and linked, waiting for Immich to make the family copy's thumbnails.
      processingThumbnails: deps.queue.unfinishedAtStep('linked'),
      // Pending after a transient failure, tried again on their own.
      retrying: deps.queue.retrying(),
      failed: failed.map((f) => ({
        id: f.id,
        kind: f.kind,
        sourceAssetId: f.sourceAssetId,
        fileName: names.get(f.sourceAssetId) ?? null,
        step: f.step,
        error: f.error,
        updatedAt: f.updatedAt,
      })),
      worker: deps.worker.state(),
    };
  });

  // The queue page: 1 page of a section, each job with the asset to show for it.
  app.get<{ Querystring: { section: Section; after?: number; onlyFailures?: boolean } }>(
    '/api/jobs/list',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['section'],
          additionalProperties: false,
          properties: {
            section: { type: 'string', enum: ['active', 'failed', 'done'] },
            after: { type: 'integer', minimum: 0 },
            onlyFailures: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['jobs', 'next'],
            properties: { jobs: { type: 'array', items: listedJobSchema }, next: nullable('integer') },
          },
        },
      },
    },
    async (req) => {
      const { section, after, onlyFailures } = req.query;
      const page = deps.queue.list(section, { after, onlyFailures });
      // A member's asset: it exists through every step, while a given-back family copy is deleted.
      const thumbOf = (j: ListedJob) => (j.kind === 'giveback' ? (j.originals?.[0] ?? j.sourceAssetId) : j.sourceAssetId);
      const names = await deps.immich.fileNames(page.jobs.map(thumbOf));
      return {
        next: page.next,
        jobs: page.jobs.map((j) => ({ ...j, thumbAssetId: thumbOf(j), fileName: names.get(thumbOf(j)) ?? null })),
      };
    },
  );

  app.get<{ Params: { id: number } }>(
    '/api/jobs/:id/events',
    {
      schema: {
        params: jobParams,
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              required: ['at', 'type', 'step'],
              properties: {
                at: { type: 'string' },
                type: { type: 'string' },
                step: { type: 'string' },
                message: nullable('string'),
                by: nullable('string'),
                outcome: nullable('string'),
              },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => deps.queue.events(req.params.id) ?? reply.code(404).send({ error: 'no such job' }),
  );

  // No new writes while the guard fails (or before its first check).
  const writable = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!deps.guard()?.ok) return reply.code(409).send({ error: 'read-only: the upgrade guard failed' });
  };

  // Queues the jobs and wakes the worker. No check here whether each asset can go: it could be
  // stale by the time the worker runs. The worker's Immich calls refuse what can't, and that job
  // is listed as failed with the reason.
  const queueJobs = (req: FastifyRequest, kind: Kind, ids: string[], memberId: string | null = null) => {
    const requestedBy = req.user?.email ?? null; // null when the login is off (local dev)
    const queued = deps.queue.enqueue(kind, ids, { memberId, requestedBy });
    const alreadyQueued = ids.length - queued.length;
    req.log.info({ by: requestedBy, kind, memberId, queued: queued.length, alreadyQueued }, `${kind} requested`);
    if (queued.length) deps.worker.kick();
    return { queued: queued.length, alreadyQueued };
  };

  app.post<{ Body: { memberId: string; assetIds: string[] } }>(
    '/api/moves',
    {
      preHandler: writable,
      schema: {
        body: {
          type: 'object',
          required: ['memberId', 'assetIds'],
          additionalProperties: false,
          properties: { memberId: uuidParam, assetIds },
        },
      },
    },
    async (req, reply) => {
      const { memberId, assetIds } = req.body;
      if (!(await isMember(memberId))) return reply.code(404).send({ error: 'no such member' });
      return reply.code(202).send(queueJobs(req, 'move', assetIds, memberId));
    },
  );

  // Give back: family assets (stacks by their primary) back to the members they came from.
  app.post<{ Body: { assetIds: string[] } }>(
    '/api/givebacks',
    {
      preHandler: writable,
      schema: { body: { type: 'object', required: ['assetIds'], additionalProperties: false, properties: { assetIds } } },
    },
    async (req, reply) => reply.code(202).send(queueJobs(req, 'giveback', req.body.assetIds)),
  );

  app.post<{ Params: { id: number } }>(
    '/api/jobs/:id/retry',
    {
      preHandler: writable,
      schema: { params: jobParams },
    },
    async (req, reply) => {
      if (!deps.queue.retry(req.params.id, req.user?.email ?? null)) return reply.code(404).send({ error: 'no failed job with that id' });
      req.log.info({ by: req.user?.email ?? null, job: req.params.id }, 'retry requested');
      deps.worker.kick();
      return reply.code(202).send({ retried: req.params.id });
    },
  );

  app.get<{ Params: { id: string; kind: MediaKind } }>(
    '/media/:id/:kind',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'kind'],
          properties: { id: uuidParam, kind: { type: 'string', enum: ['thumbnail', 'preview', 'video'] } },
        },
      },
    },
    async (req, reply) => {
      const local = await deps.immich.mediaFile(req.params.id, req.params.kind);
      if (!local) return reply.code(404).send({ error: 'no such media' });
      // Not made yet: the page shows that Immich is making it, and asks again (public/thumb.js).
      if (local === 'pending') {
        return reply.code(503).headers({ 'retry-after': '5', 'cache-control': 'no-store' }).send({ error: 'Immich is still making it' });
      }
      // Range (video seeking), content type, ETag and Last-Modified come from @fastify/send.
      return reply.sendFile(basename(local), dirname(local), { maxAge: '1h', cacheControl: true });
    },
  );

  return app;
}

// script-src allows our files plus the import map in index.html, pinned by its hash.
function cspDirectives() {
  const page = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page)?.[1];
  if (importMap === undefined) throw new Error('public/index.html: import map not found');
  const hash = createHash('sha256').update(importMap).digest('base64');
  return {
    defaultSrc: ["'none'"],
    scriptSrc: ["'self'", `'sha256-${hash}'`],
    styleSrc: ["'self'"],
    fontSrc: ["'self'"],
    imgSrc: ["'self'"],
    mediaSrc: ["'self'"],
    connectSrc: ["'self'"],
    baseUri: ["'none'"],
    formAction: ["'none'"],
    frameAncestors: ["'none'"],
  };
}
