import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOidc } from './auth.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { createImmich, type GuardResult } from './immich/index.ts';
import { renderMetrics, writeMetrics } from './metrics.ts';
import { openQueue } from './queue.ts';
import { buildApp } from './server.ts';
import { openSessions } from './sessions.ts';
import { createWorker, LINK_MISMATCH } from './worker.ts';

function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}
const config = loadConfigOrExit();

// The closures below log through `app`, which is built further down once its parts exist. They
// only run after the start, when `app` is set.

const immich = createImmich({
  immich: config.immich,
  db: config.db,
  library: config.library,
  log: { error: (m) => app.log.error(m) },
});
// 0700: the session file in it holds refresh tokens. chmod too: mkdir's mode doesn't apply to a
// directory that already exists (a mounted volume).
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
chmodSync(config.dataDir, 0o700);
const queue = openQueue(join(config.dataDir, 'queue.db'));

// Upgrade guard: checked on start and by the worker before each queued job.
let guard: GuardResult | undefined;
let lastGuardOk: boolean | undefined;
const runGuard = async (): Promise<GuardResult> => {
  guard = await immich.check();
  if (guard.ok !== lastGuardOk) {
    if (guard.ok) app.log.info('guard ok: Immich version and schema as expected');
    else app.log.error({ problems: guard.problems }, 'guard FAILED, read-only mode');
    lastGuardOk = guard.ok;
  }
  return guard;
};

// Metrics file: rewritten after every worker change and every 60 s. Writes are chained so 2
// never overlap; a failed write is logged and the next one tries again.
let metricsChain = Promise.resolve();
const publishMetrics = (): void => {
  metricsChain = metricsChain.then(async () => {
    const counts = queue.counts();
    const text = renderMetrics(
      {
        guardOk: guard?.ok ?? false,
        failed: counts.failed,
        pending: counts.pending + counts.running,
        oldestPendingAt: queue.oldestPendingAt(),
        linkMismatchTotal: queue.counter(LINK_MISMATCH),
      },
      new Date(),
    );
    await writeMetrics(config.metricsDir, text).catch((err: Error) => app.log.error(`metrics write failed: ${err.message}`));
  });
};

const worker = createWorker({
  queue,
  immich,
  guard: async () => {
    const g = await runGuard();
    publishMetrics();
    return g;
  },
  log: { info: (m) => app.log.info(m), error: (m) => app.log.error(m) },
  onChange: publishMetrics,
});

const auth = config.auth
  ? { config: config.auth, oidc: createOidc(config.auth), sessions: openSessions(join(config.dataDir, 'sessions.db')) }
  : null;
const app = await buildApp(
  { immich, guard: () => guard, queue, worker },
  {
    logger: true,
    auth,
    // Read once: a renewed certificate takes effect on restart (jobs resume where they stopped).
    https: config.tls && { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) },
    healthz: config.healthz,
  },
);
if (!config.auth) app.log.warn('PICKER_AUTH=off: no login, every request is let in');

await app.listen({ host: config.listen.host, port: config.listen.port });
void runGuard()
  .catch((err: Error) => app.log.error(`guard check failed: ${err.message}`))
  .finally(publishMetrics);

// Resume whatever a previous run left unfinished (its recorded step says where).
const resumed = queue.resetRunning();
if (resumed) app.log.info(`${resumed} interrupted move(s) back to pending`);
worker.kick();

// Done jobs' history is kept PICKER_JOB_HISTORY_DAYS (0 = forever): checked on start, then daily.
const DAY_MS = 24 * 3_600_000;
let lastPrune = 0;
const prune = (): void => {
  if (!config.jobHistoryDays || Date.now() - lastPrune < DAY_MS) return;
  lastPrune = Date.now();
  try {
    const n = queue.prune(new Date(Date.now() - config.jobHistoryDays * DAY_MS));
    if (n) app.log.info(`${n} done job(s) older than ${config.jobHistoryDays} days removed with their history`);
  } catch (err) {
    app.log.error(`pruning job history failed: ${(err as Error).message}`);
  }
};
prune();

// Recover from a paused guard or an unreachable DB/Immich without a restart.
setInterval(() => {
  worker.kick();
  publishMetrics();
  prune();
}, 60_000).unref();

const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`${signal}: shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  await app.close();
  await worker.idle(); // a move stopped mid-way resumes from its recorded step on next start
  await metricsChain;
  queue.close();
  auth?.sessions.close();
  await immich.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
