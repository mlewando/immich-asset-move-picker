// Environment variables → validated config (listed in the README). Error messages name the
// variable, never its value: some are secrets.
import { isAbsolute } from 'node:path';

export type Config = {
  listen: { host: string; port: number };
  immich: { apiUrl: string; familyApiKey: string };
  db: { host: string; port: number; database: string; user: string; password: string };
  // thumbsDir: where Immich's /data/thumbs is visible to the picker. Production mounts it at the
  // same path (the default); a native dev run points it into dev/.data.
  library: { mount: string; subdirs: string[]; thumbsDir: string };
  metricsDir: string;
  // The picker's own state (the Move queue, SQLite). Not backed up: only work in flight.
  dataDir: string;
};

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid config:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const SUBDIR = /^[A-Za-z0-9._-]+$/;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];

  const required = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) problems.push(`${name} is required`);
    return v ?? '';
  };
  const port = (name: string, raw: string): number => {
    const n = Number(raw);
    if (raw !== '' && !(Number.isInteger(n) && n >= 1 && n <= 65535)) {
      problems.push(`${name} must be a port number 1-65535`);
    }
    return n;
  };

  // PICKER_LISTEN = host:port; host may be [ipv6].
  const listenRaw = env.PICKER_LISTEN?.trim() || '127.0.0.1:2284';
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(listenRaw);
  if (!m) problems.push('PICKER_LISTEN must be host:port');
  const listen = {
    host: (m?.[1] ?? '').replace(/^\[|\]$/g, ''),
    port: m ? port('PICKER_LISTEN', m[2] ?? '') : 0,
  };

  const apiUrl = required('IMMICH_API_URL').replace(/\/+$/, '');
  if (apiUrl && !URL.canParse(apiUrl)) problems.push('IMMICH_API_URL must be a URL');
  const familyApiKey = required('IMMICH_FAMILY_API_KEY');

  const db = {
    host: required('PGHOST'),
    port: port('PGPORT', required('PGPORT')),
    database: required('PGDATABASE'),
    user: required('PGUSER'),
    password: required('PGPASSWORD'),
  };

  const mount = required('PICKER_LIBRARY_MOUNT');
  if (mount && !isAbsolute(mount)) problems.push('PICKER_LIBRARY_MOUNT must be an absolute path');
  const subdirs = required('PICKER_LIBRARY_SUBDIRS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.PICKER_LIBRARY_SUBDIRS?.trim() && subdirs.length === 0) {
    problems.push('PICKER_LIBRARY_SUBDIRS must list at least 1 subdir');
  }
  for (const s of subdirs) {
    if (!SUBDIR.test(s) || s === '.' || s === '..') {
      problems.push(`PICKER_LIBRARY_SUBDIRS entry "${s}" must be a single directory name`);
    }
  }

  const thumbsDir = env.PICKER_THUMBS_DIR?.trim() || '/data/thumbs';
  if (!isAbsolute(thumbsDir)) problems.push('PICKER_THUMBS_DIR must be an absolute path');

  const metricsDir = required('PICKER_METRICS_DIR');
  if (metricsDir && !isAbsolute(metricsDir)) problems.push('PICKER_METRICS_DIR must be an absolute path');

  const dataDir = required('PICKER_DATA_DIR');
  if (dataDir && !isAbsolute(dataDir)) problems.push('PICKER_DATA_DIR must be an absolute path');

  if (problems.length) throw new ConfigError(problems);
  return {
    listen,
    immich: { apiUrl, familyApiKey },
    db,
    library: { mount, subdirs, thumbsDir },
    metricsDir,
    dataDir,
  };
}
