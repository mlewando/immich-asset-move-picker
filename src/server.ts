import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { isSafeMethod, registerAuth, type AuthDeps } from './auth.ts';
import type { GuardResult, Immich, MediaKind } from './immich/index.ts';
import type { Kind, Queue } from './queue.ts';
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
  queue: Pick<Queue, 'enqueue' | 'retry' | 'counts' | 'failed'>;
  worker: Pick<Worker, 'kick' | 'state'>;
};

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
// URL file name → browser module on disk (the names index.html's import map uses).
const VENDOR = {
  'preact.mjs': fileURLToPath(import.meta.resolve('preact')),
  'preact-hooks.mjs': fileURLToPath(import.meta.resolve('preact/hooks')),
  'htm.mjs': fileURLToPath(import.meta.resolve('htm')),
};

// Response schemas double as an allow-list: Fastify's serializer drops any field not listed.
const nullable = (type: string) => ({ type: [type, 'null'] });
const memberSchema = {
  type: 'object',
  required: ['id', 'name', 'email'],
  properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } },
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
  // handler: 1. the login (auth.ts; routes marked `config: { public: true }` skip it), 2. X-Picker.
  app.decorateRequest('user', null);
  if (opts.auth) await registerAuth(app, opts.auth);
  // Every mutating request must carry X-Picker: 1 (a cross-site form post can't set it).
  app.addHook('onRequest', async (req, reply) => {
    if (!isSafeMethod(req.method) && req.headers['x-picker'] !== '1') {
      return reply.code(403).send({ error: 'missing X-Picker header' });
    }
  });

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

  // Defence in depth for the page: only our own scripts/media, plus the 1 inline import map.
  const csp = contentSecurityPolicy();
  app.addHook('onSend', async (_req, reply) => {
    reply.header('content-security-policy', csp);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

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

  // 200 when the DB and Immich are reachable, even when the guard fails (the app stays up,
  // read-only). It names internal errors, so outside dev it needs its own basic auth (probes have
  // no login session).
  // The last guard result, or "not checked yet" before the 1st check.
  const guardState = () => deps.guard() ?? { ok: false, problems: ['not checked yet'] };

  const healthzAuth = opts.healthz ? basicAuth(opts.healthz) : [];
  app.get('/healthz', { config: { public: true }, onRequest: healthzAuth }, async (_req, reply) => {
    const { db, api: immich } = await deps.immich.ping();
    const { ok, problems } = guardState();
    return reply.code(db === 'ok' && immich === 'ok' ? 200 : 503).send({ db, immich, guard: { ok, problems } });
  });

  app.get('/api/status', async () => {
    const { ok, problems } = guardState();
    return { readOnly: !ok, problems };
  });

  app.get('/api/members', { schema: { response: { 200: { type: 'array', items: memberSchema } } } }, async () =>
    deps.immich.members(),
  );
  // Only a live member is a picking source, never the family account.
  const isMember = async (id: string) => (await deps.immich.members()).some((m) => m.id === id);

  const day = { type: 'string', format: 'date' } as const; // YYYY-MM-DD

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
      return deps.immich.memberTimeline(req.params.id, { albumId: album, from, to });
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
              required: ['id', 'name', 'count'],
              properties: { id: { type: 'string' }, name: { type: 'string' }, count: { type: 'integer' } },
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
    async () => deps.immich.familyTimeline(),
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
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } },
    },
    async (req, reply) => {
      if (!deps.queue.retry(req.params.id)) return reply.code(404).send({ error: 'no failed job with that id' });
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
      // Range (video seeking), content type, ETag and Last-Modified come from @fastify/send.
      return reply.sendFile(basename(local), dirname(local), { maxAge: '1h', cacheControl: true });
    },
  );

  return app;
}

/** A route hook that admits only 1 user and password (HTTP basic auth, compared in constant time). */
function basicAuth(creds: { user: string; password: string }) {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const expected = digest(`${creds.user}:${creds.password}`);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.headers.authorization ?? '');
    if (m && timingSafeEqual(digest(Buffer.from(m[1]!, 'base64').toString('utf8')), expected)) return;
    return reply.code(401).header('www-authenticate', 'Basic realm="picker healthz"').send({ error: 'unauthorized' });
  };
}

// script-src allows our files plus the import map in index.html, pinned by its hash.
function contentSecurityPolicy(): string {
  const page = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page)?.[1];
  if (importMap === undefined) throw new Error('public/index.html: import map not found');
  const hash = createHash('sha256').update(importMap).digest('base64');
  return [
    "default-src 'none'",
    `script-src 'self' 'sha256-${hash}'`,
    "style-src 'self'",
    "img-src 'self'",
    "media-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
