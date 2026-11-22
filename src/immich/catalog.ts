// Read side: what the grids show, straight from Immich's DB (read-only grants).
import type { Db } from './db.ts';

// hasPhotos: at least 1 photo on the member's timeline (the page starts on such a member). It can
// be true while the grid is empty: every photo waits in an unfinished move, or the only ones are
// a stack's whose primary is off the timeline.
export type Member = { id: string; name: string; email: string; hasPhotos: boolean };

export type GridItem = {
  id: string;
  type: 'image' | 'video';
  // Immich's localDateTime: the wall-clock time where the photo was taken, encoded as UTC.
  localDateTime: string;
  day: string; // YYYY-MM-DD of localDateTime, the grid's grouping key
  fileName: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  livePhotoVideoId: string | null; // set → LIVE badge; play /media/<this>/video
  stack: { id: string; size: number } | null; // only the stack's primary is listed
  edited: boolean; // Immich edits (crop/rotate/mirror): a move does not carry them
  inFamily?: boolean; // member timeline: same bytes already in the family account
  noOrigin?: boolean; // family timeline: no original to give back to
};

export type MediaKind = 'thumbnail' | 'preview' | 'video';

type Row = {
  id: string;
  type: string;
  localDateTime: Date;
  originalFileName: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  livePhotoVideoId: string | null;
  isEdited: boolean;
  stackId: string | null;
  stackSize: number | null;
  inFamily?: boolean;
  hasOrigin?: boolean;
};

// from/to: the first and last day (YYYY-MM-DD, localDateTime) of the member's photos in it.
export type Album = { id: string; name: string; count: number; from: string; to: string };

/** Member timeline filter: 1 album, and/or a day range (YYYY-MM-DD, inclusive, localDateTime). */
export type TimelineFilter = { albumId?: string; from?: string; to?: string };

// On a timeline (asset a): an uploaded asset (never an external-library file), not archived,
// trashed, locked or hidden (hidden = live-photo video halves).
const ON_TIMELINE = `a.visibility = 'timeline' AND a."deletedAt" IS NULL AND a.status = 'active' AND a."libraryId" IS NULL`;

// A timeline: the owner's assets on it. Of a stack only the primary.
const TIMELINE_SQL = (extraColumns: string, extraWhere = '') => `
  SELECT a.id, a.type, a."localDateTime", a."originalFileName", a.width, a.height, a.duration,
         a."livePhotoVideoId", a."isEdited", a."stackId",
         CASE WHEN a."stackId" IS NOT NULL THEN
           (SELECT count(*)::int FROM asset s
             WHERE s."stackId" = a."stackId" AND s."deletedAt" IS NULL AND s.status = 'active')
         END AS "stackSize"
         ${extraColumns}
    FROM asset a
   WHERE a."ownerId" = $1
     AND ${ON_TIMELINE}
     AND (a."stackId" IS NULL
          OR EXISTS (SELECT 1 FROM stack st WHERE st.id = a."stackId" AND st."primaryAssetId" = a.id))
     ${extraWhere}
   ORDER BY a."localDateTime" DESC, a.id`;

// $3 album id, $4 from, $5 to (each null = no filter). A stack is in the album when any of its
// members is. localDateTime is the wall-clock time encoded as UTC, so its UTC date is the day.
const FILTER_SQL = `
     AND ($3::uuid IS NULL OR EXISTS (
           SELECT 1 FROM album_asset aa JOIN album al ON al.id = aa."albumId" AND al."deletedAt" IS NULL
            WHERE aa."albumId" = $3::uuid
              AND (aa."assetId" = a.id
                   OR (a."stackId" IS NOT NULL
                       AND aa."assetId" IN (SELECT s.id FROM asset s WHERE s."stackId" = a."stackId")))))
     AND ($4::date IS NULL OR (a."localDateTime" AT TIME ZONE 'UTC')::date >= $4::date)
     AND ($5::date IS NULL OR (a."localDateTime" AT TIME ZONE 'UTC')::date <= $5::date)`;

function toGridItem(r: Row): GridItem {
  const iso = r.localDateTime.toISOString();
  return {
    id: r.id,
    type: r.type === 'VIDEO' ? 'video' : 'image',
    localDateTime: iso,
    day: iso.slice(0, 10),
    fileName: r.originalFileName,
    width: r.width,
    height: r.height,
    durationMs: r.duration,
    livePhotoVideoId: r.livePhotoVideoId,
    stack: r.stackId ? { id: r.stackId, size: r.stackSize ?? 1 } : null,
    edited: r.isEdited,
  };
}

export function members(db: Db, familyId: string): Promise<Member[]> {
  return db.query<Member>(
    `SELECT u.id, u.name, u.email,
            EXISTS (SELECT 1 FROM asset a WHERE a."ownerId" = u.id AND ${ON_TIMELINE}) AS "hasPhotos"
       FROM "user" u
      WHERE u."deletedAt" IS NULL AND u.id <> $1
      ORDER BY u.name, u.email`,
    [familyId],
  );
}

export async function memberTimeline(db: Db, memberId: string, familyId: string, filter: TimelineFilter = {}): Promise<GridItem[]> {
  // inFamily: Immich keeps checksums unique per owner, so this hits its (owner, checksum) index.
  const rows = await db.query<Row>(
    TIMELINE_SQL(
      `, EXISTS (SELECT 1 FROM asset f
          WHERE f."ownerId" = $2 AND f.checksum = a.checksum AND f."libraryId" IS NULL
            AND f."deletedAt" IS NULL AND f.status = 'active') AS "inFamily"`,
      FILTER_SQL,
    ),
    [memberId, familyId, filter.albumId ?? null, filter.from ?? null, filter.to ?? null],
  );
  return rows.map((r) => ({ ...toGridItem(r), inFamily: r.inFamily === true }));
}

/**
 * Albums (anyone's) holding at least 1 asset of this member's timeline; count = those assets.
 * Newest first, by the member's latest photo in each.
 */
export function memberAlbums(db: Db, memberId: string): Promise<Album[]> {
  const day = (agg: string) => `to_char(${agg}(a."localDateTime" AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
  return db.query<Album>(
    `SELECT al.id, al."albumName" AS name, count(DISTINCT a.id)::int AS count,
            ${day('min')} AS "from", ${day('max')} AS "to"
       FROM album al
       JOIN album_asset aa ON aa."albumId" = al.id
       JOIN asset a ON a.id = aa."assetId"
      WHERE al."deletedAt" IS NULL AND a."ownerId" = $1
        AND ${ON_TIMELINE}
      GROUP BY al.id, al."albumName"
      ORDER BY max(a."localDateTime") DESC, lower(al."albumName"), al.id`,
    [memberId],
  );
}

/** Names of the albums (anyone's) holding any of these assets, sorted. */
export async function albumsOf(db: Db, assetIds: string[]): Promise<string[]> {
  if (!assetIds.length) return [];
  const rows = await db.query<{ name: string }>(
    `SELECT DISTINCT al."albumName" AS name
       FROM album al
       JOIN album_asset aa ON aa."albumId" = al.id
      WHERE aa."assetId" = ANY($1::uuid[]) AND al."deletedAt" IS NULL
      ORDER BY name`,
    [assetIds],
  );
  return rows.map((r) => r.name);
}

export async function familyTimeline(db: Db, familyId: string): Promise<GridItem[]> {
  // An original = another account's archived, still existing asset with the same bytes (which
  // original belongs to which copy is never stored). Uses Immich's index on asset.checksum.
  const rows = await db.query<Row>(
    TIMELINE_SQL(`, EXISTS (SELECT 1 FROM asset o
                 WHERE o.checksum = a.checksum AND o."ownerId" <> $1 AND o."libraryId" IS NULL
                   AND o.visibility = 'archive' AND o."deletedAt" IS NULL AND o.status = 'active') AS "hasOrigin"`),
    [familyId],
  );
  return rows.map((r) => ({ ...toGridItem(r), noOrigin: r.hasOrigin !== true }));
}

// A thumbnail or preview Immich hasn't made this long after the upload never will be (it
// failed); before that it is still in Immich's job queue.
const MAKING_WINDOW = '24 hours';

/**
 * Immich path of the file to show; 'pending' for a thumbnail or preview Immich is still to make
 * (a new upload); null for an unknown/locked/deleted asset or no such file.
 */
export async function mediaPath(db: Db, assetId: string, kind: MediaKind): Promise<string | 'pending' | null> {
  // Any visibility but locked (Immich's PIN-protected folder): archived originals and hidden
  // live-photo videos must still be viewable.
  const [asset] = await db.query<{ type: string; originalPath: string; isEdited: boolean; recent: boolean }>(
    `SELECT type, "originalPath", "isEdited", "createdAt" > now() - interval '${MAKING_WINDOW}' AS recent FROM asset
      WHERE id = $1 AND "libraryId" IS NULL AND "deletedAt" IS NULL AND status = 'active'
        AND visibility <> 'locked'`,
    [assetId],
  );
  if (!asset) return null;
  if (kind === 'video') {
    if (asset.type !== 'VIDEO') return null;
    // Immich transcodes only what browsers can't play; otherwise the original is the video.
    const [encoded] = await db.query<{ path: string }>(
      `SELECT path FROM asset_file WHERE "assetId" = $1 AND type = 'encoded_video' LIMIT 1`,
      [assetId],
    );
    return encoded?.path ?? asset.originalPath;
  }
  // An edited asset has 2 thumbnails/previews; show the one Immich shows (the edited one).
  const [file] = await db.query<{ path: string }>(
    `SELECT path FROM asset_file WHERE "assetId" = $1 AND type = $2
      ORDER BY ("isEdited" = $3) DESC LIMIT 1`,
    [assetId, kind, asset.isEdited],
  );
  return file?.path ?? (asset.recent ? 'pending' : null);
}

export async function fileNames(db: Db, assetIds: string[]): Promise<Map<string, string>> {
  if (!assetIds.length) return new Map();
  const rows = await db.query<{ id: string; originalFileName: string }>(
    `SELECT id, "originalFileName" FROM asset WHERE id = ANY($1::uuid[])`,
    [assetIds],
  );
  return new Map(rows.map((r) => [r.id, r.originalFileName]));
}
