// The picker's only door to Immich. Everything that knows Immich's API, database schema, file
// layout or quirks lives in src/immich/; the rest of the app sees just this interface, in the
// picker's own terms. Adapting to a new Immich version = change this folder (+ its guard lists
// and integration tests), nothing else.
//
// Acts as the family account: its id is the owner of the family API key (GET /api/users/me).
import { openAsBlob } from 'node:fs';
import { access } from 'node:fs/promises';
import type { Config } from '../config.ts';
import * as albums from './albums.ts';
import type { FamilyAlbum, SourceAlbum } from './albums.ts';
import { createImmichApi } from './api.ts';
import * as catalog from './catalog.ts';
import type { Album, GridItem, MediaKind, Member, TimelineFilter } from './catalog.ts';
import { copyToFamily, sqlCopyDeps, type CopyResult } from './copy.ts';
import { createDb } from './db.ts';
import { transient } from './errors.ts';
import { checkGuard, GUARD_QUERY_TIMEOUT_MS, type GuardResult } from './guard.ts';
import { deleteFromFamily, prepareGiveBack, type GiveBackPlan } from './giveback.ts';
import { linkToFamily, sqlLinkPairs, type LinkResult } from './link.ts';
import { mapImmichPath } from './paths.ts';
import { missingThumbnails } from './thumbnails.ts';
import { setVisibility, type VisibilityResult } from './visibility.ts';

export type { Album, GridItem, MediaKind, Member, TimelineFilter } from './catalog.ts';
export type { FamilyAlbum, SourceAlbum } from './albums.ts';
export type { CopyResult } from './copy.ts';
export { isTransient, transient } from './errors.ts';
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
  /**
   * Local path of an asset's file to show; 'pending' for a thumbnail or preview Immich is still to
   * make (a new upload); null when unknown, locked, trashed or missing on disk.
   */
  mediaFile(assetId: string, kind: MediaKind): Promise<string | 'pending' | null>;
  /** Original file names, for messages (unknown ids are left out). */
  fileNames(assetIds: string[]): Promise<Map<string, string>>;
  /** Names of the albums (anyone's) holding any of these assets, sorted. */
  albumsOf(assetIds: string[]): Promise<string[]>;
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
   * picked asset's family copy, the originals to archive, how many files they are (a live
   * photo's video included) and how many of those it uploaded.
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
  /**
   * The originals whose family copy Immich hasn't made a thumbnail and preview for yet (it does
   * that after an upload, in its own job queue). 1 query, however many originals.
   */
  missingThumbnails(originalIds: string[]): Promise<Set<string>>;
  /** Give back, last step: force-deletes these family assets (gone ones are skipped). */
  deleteFromFamily(familyAssetIds: string[]): Promise<void>;

  // --- Albums
  /** The family account's albums to move into, the most recently updated first. */
  familyAlbums(): Promise<FamilyAlbum[]>;
  /**
   * The family album named so (case-insensitive, trimmed), created when there is none. created:
   * whether it is new.
   */
  familyAlbumNamed(name: string): Promise<{ id: string; name: string; created: boolean }>;
  /** Family assets into a family album; safe to repeat. 'gone' = the album no longer exists. */
  addToFamilyAlbum(albumId: string, familyAssetIds: string[]): Promise<'added' | 'gone'>;
  /** A member's album as the delete rule sees it (see SourceAlbum); null when it is gone. */
  sourceAlbum(albumId: string): Promise<SourceAlbum | null>;
  /** Deletes the album when nothing in it is on a timeline (checked as it deletes); whether it did. */
  deleteSourceAlbum(albumId: string): Promise<boolean>;

  // --- Health
  /**
   * Upgrade guard: supported Immich version, schema and grants. quick: already read-only, so a
   * slow Immich isn't given longer to answer (see VERSION_RECHECK_MS).
   */
  check(opts?: { quick?: boolean }): Promise<GuardResult>;
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
  // The guard's own connection: busy timeline queries can't keep it waiting for one, and a hung
  // query of its own times out (a slow timeline query on `db` must not).
  const guardDb = createDb(cfg.db, { max: 1, queryTimeoutMs: GUARD_QUERY_TIMEOUT_MS });
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
      // E.g. Storage Template Migration moved it meanwhile: a retry re-reads the path from the DB.
      const code = (err as NodeJS.ErrnoException).code;
      const e = new Error(`original file not readable (${code ?? (err as Error).message}): ${local}`);
      throw code === 'ENOENT' ? transient(e) : e;
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
      if (!immichPath || immichPath === 'pending') return immichPath;
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
    albumsOf: (ids) => catalog.albumsOf(db, ids),

    copyToFamily: (assetId) => copyToFamily(copyDeps, assetId),
    archive: (ids) => setVisibility(db, ids, 'archive'),
    restore: (ids) => setVisibility(db, ids, 'timeline'),
    prepareGiveBack: async (id) => prepareGiveBack(db, await familyId(), id),
    deleteFromFamily: async (ids) => deleteFromFamily(db, api, await familyId(), ids),
    linkToFamily: (ids) =>
      linkToFamily({ pairs: sqlLinkPairs(db, familyId), localPath: (p) => mapImmichPath(p, cfg.library) }, ids),
    missingThumbnails: async (ids) => missingThumbnails(db, await familyId(), ids),

    familyAlbums: async () => albums.familyAlbums(db, await familyId()),
    async familyAlbumNamed(name) {
      const wanted = name.trim();
      if (!wanted) throw new Error('album name is empty');
      const existing = (await albums.familyAlbums(db, await familyId())).find(
        (a) => a.name.trim().toLowerCase() === wanted.toLowerCase(),
      );
      if (existing) return { id: existing.id, name: existing.name, created: false };
      return { id: await api.createAlbum(wanted), name: wanted, created: true };
    },
    addToFamilyAlbum: async (albumId, ids) => albums.addToAlbum({ db, api, familyId: await familyId() }, albumId, ids),
    sourceAlbum: (albumId) => albums.sourceAlbum(db, albumId),
    deleteSourceAlbum: (albumId) => albums.deleteSourceAlbum(db, albumId),

    check: (opts) => checkGuard({ api, db: guardDb, quick: opts?.quick }),
    async ping() {
      const [dbState, apiState] = await Promise.all([probe(() => db.query('SELECT 1')), probe(() => api.getServerVersion())]);
      return { db: dbState, api: apiState };
    },
    close: async () => {
      await Promise.all([db.close(), guardDb.close()]);
    },
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
