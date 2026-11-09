// Test doubles.
//   - fakeImmich: the app-facing Immich interface (src/immich/index.ts), backed by plain data.
//   - fakeDb / fakeApi: internals of src/immich/, for the guard's unit tests. The fake DB answers
//     the guard's queries from an in-memory picture of the schema, which tests mutate.
import type { ImmichApi, ServerVersion } from '../src/immich/api.ts';
import type { Db } from '../src/immich/db.ts';
import { EXPECTED_COLUMNS, EXPECTED_ENUMS, EXPECTED_WRITES } from '../src/immich/guard.ts';
import type { Album, GridItem, MediaKind, Member } from '../src/immich/index.ts';
import type { ServerImmich } from '../src/server.ts';

export const FAMILY_ID = '00000000-0000-4000-8000-00000000fa01';

export function fakeImmich(data: {
  members?: Member[];
  timelines?: Record<string, GridItem[]>; // by owner id (FAMILY_ID for the family's)
  albums?: Record<string, Album[]>; // by member id
  media?: Record<string, string>; // `${assetId}/${kind}` → local path
  names?: Record<string, string>;
  ping?: { db: string; api: string };
  down?: Error; // every read throws it
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
  };
}

// --- src/immich/ internals (guard) -------------------------------------------------------------
export type FakeSchema = {
  columns: Record<string, string[]>;
  enums: Record<string, string[]>;
  updatable: Set<string>; // "table.column" the role may UPDATE
};

export const healthySchema = (): FakeSchema => ({
  columns: structuredClone(EXPECTED_COLUMNS),
  enums: structuredClone(EXPECTED_ENUMS),
  updatable: new Set(EXPECTED_WRITES.map(([t, c]) => `${t}.${c}`)),
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
      throw new Error(`fakeDb: unexpected query ${sql}`);
    },
    async close() {},
  };
}

export function fakeApi(version: ServerVersion | Error = { major: 3, minor: 3, patch: 5 }): Pick<ImmichApi, 'getServerVersion'> {
  return {
    async getServerVersion() {
      if (version instanceof Error) throw version;
      return version;
    },
  };
}
