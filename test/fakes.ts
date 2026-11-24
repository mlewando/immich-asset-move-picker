// Test doubles.
//   - fakeImmich: the app-facing Immich interface (src/immich/index.ts), backed by plain data.
//   - fakeDb / fakeApi: internals of src/immich/, for the guard's unit tests. The fake DB answers
//     the guard's queries from an in-memory picture of the schema, which tests mutate.
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { ImmichApi, ServerVersion } from '../src/immich/api.ts';
import type { Db } from '../src/immich/db.ts';
import {
  EXPECTED_COLUMNS, EXPECTED_ENUMS, EXPECTED_TABLE_WRITES, EXPECTED_WRITES, REQUIRED_KEY_PERMISSIONS,
} from '../src/immich/guard.ts';
import type { Album, FamilyAlbum, GridItem, MediaKind, Member, SourceAlbum } from '../src/immich/index.ts';
import { openQueue } from '../src/queue.ts';
import type { ServerDeps, ServerImmich } from '../src/server.ts';

export const FAMILY_ID = '00000000-0000-4000-8000-00000000fa01';

export function fakeImmich(data: {
  members?: Member[];
  timelines?: Record<string, GridItem[]>; // by owner id (FAMILY_ID for the family's)
  albums?: Record<string, Album[]>; // by member id
  media?: Record<string, string>; // `${assetId}/${kind}` → local path, or 'pending' (not made yet)
  names?: Record<string, string>;
  ping?: { db: string; api: string };
  down?: Error; // every read throws it
  familyAlbums?: FamilyAlbum[];
  sourceAlbums?: Record<string, SourceAlbum>; // by album id
} = {}): ServerImmich & { calls: string[] } {
  const calls: string[] = [];
  const up = () => {
    if (data.down) throw data.down;
  };
  return {
    calls,
    async members() {
      up();
      calls.push('members');
      return data.members ?? [];
    },
    async memberTimeline(id, filter = {}) {
      up();
      calls.push(`memberTimeline ${id} ${JSON.stringify(filter)}`);
      return data.timelines?.[id] ?? [];
    },
    async memberAlbums(id) {
      up();
      return data.albums?.[id] ?? [];
    },
    async familyTimeline() {
      up();
      return data.timelines?.[FAMILY_ID] ?? [];
    },
    async mediaFile(assetId, kind: MediaKind) {
      return data.media?.[`${assetId}/${kind}`] ?? null;
    },
    async fileNames(ids) {
      return new Map(ids.filter((id) => data.names?.[id]).map((id) => [id, data.names![id]!]));
    },
    async ping() {
      return data.ping ?? { db: 'ok', api: 'ok' };
    },
    async familyAlbums() {
      up();
      return data.familyAlbums ?? [];
    },
    async familyAlbumNamed(name) {
      up();
      const albums = (data.familyAlbums ??= []);
      const found = albums.find((a) => a.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (found) return { id: found.id, name: found.name, created: false };
      calls.push(`createAlbum ${name.trim()}`);
      const id = `00000000-0000-4000-8000-${String(albums.length + 1).padStart(12, '0')}`;
      albums.unshift({ id, name: name.trim(), count: 0, from: null, to: null, coverId: null, updatedAt: new Date().toISOString() });
      return { id, name: name.trim(), created: true };
    },
    async sourceAlbum(id) {
      up();
      return data.sourceAlbums?.[id] ?? null;
    },
  };
}

// --- src/immich/ internals (guard) -------------------------------------------------------------
export type FakeSchema = {
  columns: Record<string, string[]>;
  enums: Record<string, string[]>;
  updatable: Set<string>; // "table.column" the role may UPDATE
  tableGrants: Set<string>; // "PRIVILEGE table" the role has on a whole table
};

export const healthySchema = (): FakeSchema => ({
  columns: structuredClone(EXPECTED_COLUMNS),
  enums: structuredClone(EXPECTED_ENUMS),
  updatable: new Set(EXPECTED_WRITES.map(([t, c]) => `${t}.${c}`)),
  tableGrants: new Set(EXPECTED_TABLE_WRITES.map(([t, p]) => `${p} ${t}`)),
});

export function fakeDb(schema: FakeSchema = healthySchema(), opts: { down?: boolean } = {}): Db {
  return {
    async query<R extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
      if (opts.down) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      if (sql.includes('information_schema.columns')) {
        return Object.entries(schema.columns).flatMap(([table_name, cols]) =>
          cols.map((column_name) => ({ table_name, column_name })),
        ) as unknown as R[];
      }
      if (sql.includes('pg_enum')) {
        return Object.entries(schema.enums).map(([typname, labels]) => ({ typname, labels })) as unknown as R[];
      }
      if (sql.includes('has_column_privilege')) {
        const [tables, cols] = params as [string[], string[]];
        return tables.map((t, i) => ({ t, c: cols[i], ok: schema.updatable.has(`${t}.${cols[i]}`) })) as unknown as R[];
      }
      if (sql.includes('has_table_privilege')) {
        const [tables, privs] = params as [string[], string[]];
        return tables.map((t, i) => ({ t, p: privs[i], ok: schema.tableGrants.has(`${privs[i]} ${t}`) })) as unknown as R[];
      }
      throw new Error(`fakeDb: unexpected query ${sql}`);
    },
    async close() {},
  };
}

export function fakeApi(
  version: ServerVersion | Error = { major: 3, minor: 4, patch: 1 },
  permissions: string[] | Error = [...REQUIRED_KEY_PERMISSIONS],
): Pick<ImmichApi, 'getServerVersion' | 'getMyPermissions'> {
  return {
    async getServerVersion() {
      if (version instanceof Error) throw version;
      return version;
    },
    async getMyPermissions() {
      if (permissions instanceof Error) throw permissions;
      return permissions;
    },
  };
}

/** The family key's permissions, for an api built by hand in a test. */
export const keyOk = { getMyPermissions: async () => [...REQUIRED_KEY_PERMISSIONS] };

export function fakeWorker() {
  let kicks = 0;
  let rechecks = 0;
  const state = () => ({ running: false, paused: false, pausedReason: [] as string[] });
  return {
    kick: () => void kicks++,
    state,
    recheck: async () => (rechecks++, state()),
    kicks: () => kicks,
    rechecks: () => rechecks,
  };
}

/** Healthy server deps (no guard check yet, empty queue), with `over` replacing any of them. */
export const serverDeps = (over: Partial<ServerDeps> = {}): ServerDeps => ({
  immich: fakeImmich(),
  guard: () => undefined,
  queue: openQueue(':memory:'),
  worker: fakeWorker(),
  ...over,
});

/** A write as the page sends it: with the token and cookie GET /api/csrf hands out. */
export async function withCsrf(app: FastifyInstance, req: InjectOptions): Promise<InjectOptions> {
  const cookies = (req.cookies ?? {}) as Record<string, string>;
  const res = await app.inject({ url: '/api/csrf', cookies });
  const secret = res.cookies.find((c) => c.name.endsWith('picker_csrf'));
  if (!secret) throw new Error(`no CSRF cookie (GET /api/csrf → ${res.statusCode})`);
  return {
    ...req,
    headers: { ...req.headers, 'csrf-token': (res.json() as { token: string }).token },
    cookies: { ...cookies, [secret.name]: secret.value },
  };
}
