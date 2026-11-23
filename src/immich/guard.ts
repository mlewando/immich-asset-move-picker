// Upgrade guard: the picker writes to Immich's DB/files behind its back, so it only runs
// against Immich versions and a schema it was tested with. Any mismatch → read-only.
// The lists below are everything src/immich/ relies on; update them with the queries.
import type { ImmichApi } from './api.ts';
import type { Db } from './db.ts';
import { isTransient } from './errors.ts';

// A busy Immich (e.g. its nightly jobs) may not answer in the usual 5 s: before going read-only,
// ask once more and wait this long. Not when already read-only (`quick`): then a check is about
// coming back soon, and a long wait would only delay that.
export const VERSION_RECHECK_MS = 15_000;

// The guard's database queries are small catalog reads. One with no answer by then (Postgres
// frozen, connection dead) fails the check instead of holding up every check after it.
export const GUARD_QUERY_TIMEOUT_MS = 5_000;

// Each version tested on its own (integration tests against it), not a semver range: a later
// patch of an older minor sorts inside a range like "3.3.5 to 3.4.1" but is untested.
export const SUPPORTED_IMMICH_VERSIONS: readonly string[] = ['3.4.1', '3.4.2'];

// Columns the picker reads. information_schema.columns lists only columns the current role has a
// privilege on, so a missing GRANT shows up here too.
export const EXPECTED_COLUMNS: Record<string, string[]> = {
  asset: [
    'id', 'ownerId', 'type', 'originalPath', 'originalFileName', 'fileCreatedAt', 'fileModifiedAt',
    'localDateTime', 'checksum', 'checksumAlgorithm', 'livePhotoVideoId', 'stackId', 'libraryId',
    'isExternal', 'visibility', 'status', 'deletedAt', 'duplicateId', 'isEdited', 'duration',
    'width', 'height', 'isOffline', 'createdAt',
  ],
  asset_file: ['assetId', 'type', 'path', 'isEdited'],
  asset_exif: [
    'assetId', 'description', 'dateTimeOriginal', 'timeZone', 'latitude', 'longitude', 'rating',
    'livePhotoCID', 'lockedProperties',
  ],
  stack: ['id', 'primaryAssetId', 'ownerId'],
  album: ['id', 'albumName', 'deletedAt'],
  album_asset: ['albumId', 'assetId'],
  user: ['id', 'name', 'email', 'deletedAt'],
};

// Exact value lists: a new value means changed semantics the picker doesn't know about.
export const EXPECTED_ENUMS: Record<string, string[]> = {
  asset_visibility_enum: ['archive', 'timeline', 'hidden', 'locked'],
  assets_status_enum: ['active', 'trashed', 'deleted'],
  asset_checksum_algorithm_enum: ['sha1', 'sha1-path'],
};

// Columns the picker's role must be able to UPDATE (visibility.ts): asset.visibility, and the
// asset_face columns Immich's trigger asset_face_update_asset_state copies it into (the trigger
// runs as the caller).
export const EXPECTED_WRITES: [table: string, column: string][] = [
  ['asset', 'visibility'],
  ['asset_face', 'ownerId'],
  ['asset_face', 'assetVisibility'],
  ['asset_face', 'assetDeletedAt'],
];

export type GuardResult = { ok: boolean; problems: string[]; checkedAt: Date };

export async function checkGuard(deps: {
  api: Pick<ImmichApi, 'getServerVersion'>;
  db: Db;
  now?: () => Date;
  quick?: boolean;
}): Promise<GuardResult> {
  const problems: string[] = [];
  await Promise.all([
    checkVersion(deps.api, problems, deps.quick ?? false),
    checkSchema(deps.db, problems),
  ]);
  return { ok: problems.length === 0, problems, checkedAt: (deps.now ?? (() => new Date()))() };
}

async function checkVersion(api: Pick<ImmichApi, 'getServerVersion'>, problems: string[], quick: boolean): Promise<void> {
  try {
    const v = await api.getServerVersion().catch((err: unknown) => {
      if (quick || !isTransient(err)) throw err;
      return api.getServerVersion(VERSION_RECHECK_MS);
    });
    const actual = `${v.major}.${v.minor}.${v.patch}`;
    if (!SUPPORTED_IMMICH_VERSIONS.includes(actual)) {
      problems.push(`Immich version ${actual} not supported (supported: ${SUPPORTED_IMMICH_VERSIONS.join(', ')})`);
    }
  } catch (err) {
    problems.push(`Immich version check failed: ${(err as Error).message}`);
  }
}

async function checkSchema(db: Db, problems: string[]): Promise<void> {
  try {
    const cols = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [Object.keys(EXPECTED_COLUMNS)],
    );
    const have = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      const missing = columns.filter((c) => !have.has(`${table}.${c}`));
      if (missing.length) {
        problems.push(`public.${table}: missing or not granted: ${missing.join(', ')}`);
      }
    }

    const enums = await db.query<{ typname: string; labels: string[] }>(
      `SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = 'public' AND t.typname = ANY($1::text[])
        GROUP BY t.typname`,
      [Object.keys(EXPECTED_ENUMS)],
    );
    const byName = new Map(enums.map((e) => [e.typname, e.labels]));
    for (const [name, expected] of Object.entries(EXPECTED_ENUMS)) {
      const actual = byName.get(name);
      if (!actual) problems.push(`enum public.${name} missing`);
      else if (actual.join(',') !== expected.join(',')) {
        problems.push(`enum public.${name} is [${actual.join(', ')}], expected [${expected.join(', ')}]`);
      }
    }

    // The picker's only write: asset.visibility, plus what Immich's trigger copies it into.
    const writes = await db.query<{ t: string; c: string; ok: boolean }>(
      `SELECT t, c, has_column_privilege(format('public.%I', t), c, 'UPDATE') AS ok
         FROM unnest($1::text[], $2::text[]) AS w(t, c)`,
      [EXPECTED_WRITES.map(([t]) => t), EXPECTED_WRITES.map(([, c]) => c)],
    );
    const denied = writes.filter((w) => !w.ok).map((w) => `${w.t}.${w.c}`);
    if (denied.length) problems.push(`no UPDATE grant on: ${denied.join(', ')}`);
  } catch (err) {
    problems.push(`schema check failed: ${(err as Error).message}`);
  }
}
