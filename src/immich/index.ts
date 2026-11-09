// The picker's only door to Immich. Everything that knows Immich's API, database schema, file
// layout or quirks lives in src/immich/; the rest of the app sees just this interface, in the
// picker's own terms. Adapting to a new Immich version = change this folder (+ its guard lists
// and integration tests), nothing else.
//
// Acts as the family account: its id is the owner of the family API key (GET /api/users/me).
import { openAsBlob } from 'node:fs';
import { access } from 'node:fs/promises';
import type { Config } from '../config.ts';
import { createImmichApi } from './api.ts';
import * as catalog from './catalog.ts';
import type { Album, GridItem, MediaKind, Member, TimelineFilter } from './catalog.ts';
import { copyToFamily, sqlCopyDeps, type CopyResult } from './copy.ts';
import { createDb } from './db.ts';
import { checkGuard, type GuardResult } from './guard.ts';
import { deleteFromFamily, prepareGiveBack, type GiveBackPlan } from './giveback.ts';
import { linkToFamily, sqlLinkPairs, type LinkResult } from './link.ts';
import { mapImmichPath } from './paths.ts';
import { setVisibility, type VisibilityResult } from './visibility.ts';

export type { Album, GridItem, MediaKind, Member, TimelineFilter } from './catalog.ts';
export type { CopyResult } from './copy.ts';
export type { GiveBackPlan } from './giveback.ts';
export type { LinkResult } from './link.ts';
export type { GuardResult } from './guard.ts';
export type { VisibilityResult } from './visibility.ts';

export type Immich = {
  // --- Read
  /** Every user but the family account. */
  members(): Promise<Member[]>;
  /** A member's timeline; each item says whether the family account already has its bytes. */
  memberTimeline(memberId: string, filter?: TimelineFilter): Promise<GridItem[]>;
  /** Albums holding some of a member's timeline, to filter it by. */
  memberAlbums(memberId: string): Promise<Album[]>;
  /** The family account's timeline; each item says whether it has an original to give back to. */
  familyTimeline(): Promise<GridItem[]>;
  /** Local path of an asset's file to show, or null (unknown, locked, trashed, missing on disk). */
  mediaFile(assetId: string, kind: MediaKind): Promise<string | null>;
  /** Original file names, for messages (unknown ids are left out). */
  fileNames(assetIds: string[]): Promise<Map<string, string>>;
  /**
   * Give back, 1st step: for a family asset (a stack by its primary), the family files to delete
   * and the originals to restore. Refuses when any family file has no copy in a member's account:
   * the picker never deletes the only copy of a photo.
   */
  prepareGiveBack(familyAssetId: string): Promise<GiveBackPlan>;

  // --- Write. Each refuses (throws / 'refused') what it can't do, at the moment it acts.
  /**
   * A member's asset into the family account: a live photo with its video, a stack (picked by
   * its primary) whole and re-stacked, edited metadata included. Safe to repeat. Returns the
   * picked asset's family copy and the originals to archive.
   */
  copyToFamily(assetId: string): Promise<CopyResult>;
  /** Originals off the members' timelines (after a move). Already archived = 'unchanged'. */
  archive(assetIds: string[]): Promise<VisibilityResult[]>;
  /** Originals back on the members' timelines (give back). */
  restore(assetIds: string[]): Promise<VisibilityResult[]>;
  /**
   * Each original's file (and its live-photo video's) becomes a hard link to the family copy's
   * file, after verifying size + sha1, so the photo is stored once. 1 result per file;
   * 'mismatch' = the files differ.
   */
  linkToFamily(originalIds: string[]): Promise<LinkResult[]>;
  /** Give back, last step: force-deletes these family assets (gone ones are skipped). */
  deleteFromFamily(familyAssetIds: string[]): Promise<void>;

  // --- Health
  /** Upgrade guard: exact Immich version, schema and grants. */
  check(): Promise<GuardResult>;
  /** Reachability of Immich's database and API: 'ok' or 'error: …'. */
  ping(): Promise<{ db: string; api: string }>;
  close(): Promise<void>;
};

export function createImmich(cfg: {
  immich: Config['immich'];
  db: Config['db'];
  library: Config['library'];
  log?: { error(msg: string): void };
}): Immich {
  const db = createDb(cfg.db);
  const api = createImmichApi(cfg.immich.apiUrl, cfg.immich.familyApiKey);
  const log = cfg.log ?? { error: (m: string) => console.error(m) };

  // Fetched once; a failure (Immich down at boot) is retried on the next call.
  let familyIdPromise: Promise<string> | undefined;
  const familyId = (): Promise<string> => {
    familyIdPromise ??= api.getMyUserId().catch((err: unknown) => {
      familyIdPromise = undefined;
      throw err;
    });
    return familyIdPromise;
  };

  const openFile = async (immichPath: string): Promise<Blob> => {
    const local = mapImmichPath(immichPath, cfg.library);
    if (!local) throw new Error(`original file outside the mapped library: ${immichPath}`);
    try {
      return await openAsBlob(local);
    } catch (err) {
      // E.g. Storage Template Migration moved it meanwhile: Retry re-reads the path from the DB.
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(`original file not readable (${code ?? (err as Error).message}): ${local}`);
    }
  };
  const copyDeps = { ...sqlCopyDeps(db), familyId, openFile, api };

  return {
    members: async () => catalog.members(db, await familyId()),
    memberTimeline: async (memberId, filter) => catalog.memberTimeline(db, memberId, await familyId(), filter),
    memberAlbums: (memberId) => catalog.memberAlbums(db, memberId),
    familyTimeline: async () => catalog.familyTimeline(db, await familyId()),
    async mediaFile(assetId, kind) {
      const immichPath = await catalog.mediaPath(db, assetId, kind);
      if (!immichPath) return null;
      const local = mapImmichPath(immichPath, cfg.library);
      if (!local) {
        log.error(`media ${assetId}: Immich path outside the mapped library: ${immichPath}`);
        return null;
      }
      try {
        await access(local);
      } catch {
        log.error(`media ${assetId}: file missing on disk: ${local}`);
        return null;
      }
      return local;
    },
    fileNames: (ids) => catalog.fileNames(db, ids),

    copyToFamily: (assetId) => copyToFamily(copyDeps, assetId),
    archive: (ids) => setVisibility(db, ids, 'archive'),
    restore: (ids) => setVisibility(db, ids, 'timeline'),
    prepareGiveBack: async (id) => prepareGiveBack(db, await familyId(), id),
    deleteFromFamily: async (ids) => deleteFromFamily(db, api, await familyId(), ids),
    linkToFamily: (ids) =>
      linkToFamily({ pairs: sqlLinkPairs(db, familyId), localPath: (p) => mapImmichPath(p, cfg.library) }, ids),

    check: () => checkGuard({ api, db }),
    async ping() {
      const [dbState, apiState] = await Promise.all([probe(() => db.query('SELECT 1')), probe(() => api.getServerVersion())]);
      return { db: dbState, api: apiState };
    },
    close: () => db.close(),
  };
}

async function probe(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
}
