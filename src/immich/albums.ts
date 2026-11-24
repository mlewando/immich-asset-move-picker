// Albums: the family account's, to move photos into (through Immich's API, as the family
// account), and a member's source album, deleted once its photos are moved (a direct delete in
// Immich's database: the family API key can't touch another user's album).
import type { ImmichApi } from './api.ts';
import type { Db } from './db.ts';

/**
 * A family album to move into. count, from/to (YYYY-MM-DD, localDateTime) and the cover are of
 * the photos shown in it (not trashed, not hidden live-photo videos); cover is Immich's album
 * thumbnail, else the newest photo. from/to/cover are null for an empty album.
 */
export type FamilyAlbum = {
  id: string;
  name: string;
  count: number;
  from: string | null;
  to: string | null;
  coverId: string | null;
  updatedAt: string;
};

// The album owner is the album_user row with role 'owner' (album has no owner column).
const OWNER = (al: string, user: string) =>
  `EXISTS (SELECT 1 FROM album_user ou WHERE ou."albumId" = ${al}.id AND ou.role = 'owner' AND ou."userId" = ${user})`;

/** Family albums, the most recently updated first. */
export function familyAlbums(db: Db, familyId: string): Promise<FamilyAlbum[]> {
  const day = (agg: string) => `to_char(${agg}(a."localDateTime" AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
  return db.query<FamilyAlbum>(
    `SELECT al.id, al."albumName" AS name, count(a.id)::int AS count,
            ${day('min')} AS "from", ${day('max')} AS "to",
            COALESCE(al."albumThumbnailAssetId", (array_agg(a.id ORDER BY a."localDateTime" DESC))[1]) AS "coverId",
            to_char(al."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
       FROM album al
       LEFT JOIN album_asset aa ON aa."albumId" = al.id
       LEFT JOIN asset a ON a.id = aa."assetId" AND a."deletedAt" IS NULL AND a.status = 'active'
                        AND a.visibility IN ('timeline', 'archive')
      WHERE al."deletedAt" IS NULL AND ${OWNER('al', '$1')}
      GROUP BY al.id
      ORDER BY al."updatedAt" DESC, al.id`,
    [familyId],
  );
}

/** Whether this is a live album of the family account. */
export async function isFamilyAlbum(db: Db, familyId: string, albumId: string): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 FROM album al WHERE al.id = $1 AND al."deletedAt" IS NULL AND ${OWNER('al', '$2')}`,
    [albumId, familyId],
  );
  return rows.length > 0;
}

// Immich's per-asset answers that mean "it is in the album": added now, or by an earlier try.
const IN_ALBUM = new Set(['duplicate']);

/**
 * Puts family assets into a family album. Safe to repeat. 'gone': the album no longer exists
 * (deleted in Immich meanwhile), nothing added. Throws on anything else Immich refuses.
 */
export async function addToAlbum(
  deps: { db: Db; api: Pick<ImmichApi, 'addToAlbum'>; familyId: string },
  albumId: string,
  assetIds: string[],
): Promise<'added' | 'gone'> {
  // Decided from the database, not from Immich's answer: Immich says HTTP 400 both for a missing
  // album and for a bad request.
  if (!(await isFamilyAlbum(deps.db, deps.familyId, albumId))) return 'gone';
  let results;
  try {
    results = await deps.api.addToAlbum(albumId, assetIds);
  } catch (err) {
    // Deleted between the look and the call.
    if (!(await isFamilyAlbum(deps.db, deps.familyId, albumId))) return 'gone';
    throw err;
  }
  const refused = results.filter((r) => !r.success && !IN_ALBUM.has(r.error ?? ''));
  if (refused.length) {
    throw new Error(`not added to the album: ${[...new Set(refused.map((r) => r.error ?? 'unknown'))].join(', ')}`);
  }
  return 'added';
}

/**
 * A source album as the delete rule sees it. blocking: its assets still on a timeline (or
 * locked), each with its stack's primary (a move is queued by the primary); everything else in it
 * is archived, a hidden live-photo video or trashed. sharedWith: names of the other users it is
 * shared with; links, comments: its shared links and comments/likes. null: no such album.
 */
export type SourceAlbum = {
  id: string;
  name: string;
  ownerName: string | null;
  blocking: { id: string; primaryId: string | null }[];
  sharedWith: string[];
  links: number;
  comments: number;
};

// Album $1's assets that keep it: live (not trashed) and on a timeline or locked.
const BLOCKING = `
  SELECT a.id, st."primaryAssetId" AS "primaryId"
    FROM album_asset aa
    JOIN asset a ON a.id = aa."assetId"
    LEFT JOIN stack st ON st.id = a."stackId"
   WHERE aa."albumId" = $1 AND a."deletedAt" IS NULL AND a.status = 'active'
     AND a.visibility IN ('timeline', 'locked')`;

export async function sourceAlbum(db: Db, albumId: string): Promise<SourceAlbum | null> {
  const [album] = await db.query<{ id: string; name: string; ownerName: string | null; links: number; comments: number }>(
    `SELECT al.id, al."albumName" AS name,
            (SELECT u.name FROM album_user ou JOIN "user" u ON u.id = ou."userId"
              WHERE ou."albumId" = al.id AND ou.role = 'owner' LIMIT 1) AS "ownerName",
            (SELECT count(*)::int FROM shared_link sl WHERE sl."albumId" = al.id) AS links,
            (SELECT count(*)::int FROM activity ac WHERE ac."albumId" = al.id) AS comments
       FROM album al WHERE al.id = $1 AND al."deletedAt" IS NULL`,
    [albumId],
  );
  if (!album) return null;
  const [blocking, shared] = await Promise.all([
    db.query<{ id: string; primaryId: string | null }>(BLOCKING, [albumId]),
    db.query<{ name: string }>(
      `SELECT u.name FROM album_user au JOIN "user" u ON u.id = au."userId"
        WHERE au."albumId" = $1 AND au.role <> 'owner' ORDER BY u.name`,
      [albumId],
    ),
  ]);
  return { ...album, blocking, sharedWith: shared.map((s) => s.name), links: album.links, comments: album.comments };
}

/**
 * Deletes a source album, as Immich's own album delete does (a plain DELETE: Immich's cascades
 * and audit triggers do the rest), and only while nothing in it is on a timeline: checked in the
 * same statement, so a photo put back meanwhile keeps it. Returns whether it was deleted.
 */
export async function deleteSourceAlbum(db: Db, albumId: string): Promise<boolean> {
  const rows = await db.query(
    `DELETE FROM album WHERE id = $1 AND NOT EXISTS (${BLOCKING}) RETURNING id`,
    [albumId],
  );
  return rows.length > 0;
}
