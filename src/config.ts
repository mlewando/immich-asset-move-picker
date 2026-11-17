// Environment variables → validated config (listed in the README). Error messages name the
// variable, never its value: some are secrets.
import { isAbsolute } from 'node:path';
import { type AuthConfig, isLoopback } from './auth.ts';

export type Config = {
  listen: { host: string; port: number };
  immich: { apiUrl: string; familyApiKey: string };
  db: { host: string; port: number; database: string; user: string; password: string };
  // thumbsDir: where Immich's /data/thumbs is visible to the picker. Production mounts it at the
  // same path (the default); a native dev run points it into dev/.data.
  library: { mount: string; subdirs: string[]; thumbsDir: string };
  metricsDir: string;
  // The picker's own state: the job queue and the login sessions (SQLite). Not backed up: only
  // work in flight and who is logged in.
  dataDir: string;
  // null only with PICKER_AUTH=off or off-any-host (local dev): then every request is let in.
  auth: AuthConfig | null;
  tls: { certFile: string; keyFile: string } | null;
  // HTTP basic auth on /healthz (it names internal errors). Required with the login on.
  healthz: { user: string; password: string } | null;
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
  // A comma-separated list of at least 1 item.
  const list = (name: string, what: string): string[] => {
    const items = required(name)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (env[name]?.trim() && items.length === 0) problems.push(`${name} must list at least 1 ${what}`);
    return items;
  };
  const url = (name: string): URL | null => {
    const v = required(name);
    const u = v ? URL.parse(v) : null;
    if (v && !u) problems.push(`${name} must be a URL`);
    return u;
  };
  // `90s`, `30m`, `8h` → ms.
  const duration = (name: string, fallback: string): number => {
    const m = /^(\d+)([smh])$/.exec(env[name]?.trim() || fallback);
    const ms = m ? Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'] : 0;
    if (!ms) problems.push(`${name} must be a duration like 30m`);
    return ms;
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
  const subdirs = list('PICKER_LIBRARY_SUBDIRS', 'subdir');
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

  // The login is on unless switched off explicitly: a missing setting must never open the app.
  // `off` only listens on loopback, so a dev setting copied to a real host can't open it to the
  // network. `off-any-host` is for a dev container, whose port is published on loopback only.
  let auth: AuthConfig | null = null;
  const authMode = env.PICKER_AUTH?.trim() || 'oidc';
  if (!['oidc', 'off', 'off-any-host'].includes(authMode)) {
    problems.push('PICKER_AUTH must be oidc, off or off-any-host');
  }
  if (authMode === 'off' && m && !isLoopback(listen.host)) {
    problems.push('PICKER_AUTH=off needs a loopback PICKER_LISTEN');
  }
  if (authMode === 'oidc') {
    const issuer = url('PICKER_OIDC_ISSUER');
    const publicUrl = url('PICKER_PUBLIC_URL');
    // http would drop the Secure cookie flag and the __Host- prefix.
    if (publicUrl && publicUrl.protocol !== 'https:' && !isLoopback(publicUrl.hostname)) {
      problems.push('PICKER_PUBLIC_URL must be https (http only on loopback)');
    }
    const clientId = required('PICKER_OIDC_CLIENT_ID');
    const clientSecret = required('PICKER_OIDC_CLIENT_SECRET');
    const allowedGroups = list('PICKER_OIDC_ALLOWED_GROUPS', 'group');
    const idleMs = duration('PICKER_SESSION_IDLE', '30m');
    const logoutRaw = env.PICKER_OIDC_LOGOUT_URL?.trim();
    const logoutUrl = logoutRaw ? URL.parse(logoutRaw) : null;
    if (logoutRaw && logoutUrl?.protocol !== 'https:' && !(logoutUrl && isLoopback(logoutUrl.hostname))) {
      problems.push('PICKER_OIDC_LOGOUT_URL must be an https URL');
    }
    if (issuer && publicUrl) auth = { issuer, publicUrl, clientId, clientSecret, allowedGroups, idleMs, logoutUrl };
  }

  // /healthz has no login session (probes call it), so it gets its own basic-auth credentials.
  let healthz: Config['healthz'] = null;
  if (authMode === 'oidc' || env.PICKER_HEALTHZ_USER?.trim() || env.PICKER_HEALTHZ_PASSWORD?.trim()) {
    healthz = { user: required('PICKER_HEALTHZ_USER'), password: required('PICKER_HEALTHZ_PASSWORD') };
    if (healthz.user.includes(':')) problems.push('PICKER_HEALTHZ_USER must not contain ":"');
  }

  const certFile = env.PICKER_TLS_CERT?.trim() ?? '';
  const keyFile = env.PICKER_TLS_KEY?.trim() ?? '';
  if (Boolean(certFile) !== Boolean(keyFile)) problems.push('PICKER_TLS_CERT and PICKER_TLS_KEY go together');
  const tls = certFile && keyFile ? { certFile, keyFile } : null;
  // The session cookie is Secure then, and @fastify/session sets it only on an https request.
  if (auth?.publicUrl.protocol === 'https:' && !tls) {
    problems.push('PICKER_PUBLIC_URL is https: the picker must serve https itself (PICKER_TLS_CERT, PICKER_TLS_KEY)');
  }

  if (problems.length) throw new ConfigError(problems);
  return {
    listen,
    immich: { apiUrl, familyApiKey },
    db,
    library: { mount, subdirs, thumbsDir },
    metricsDir,
    dataDir,
    auth,
    tls,
    healthz,
  };
}
