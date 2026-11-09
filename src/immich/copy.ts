// copyToFamily: put a member's asset into the family account. Safe to repeat (resume after a
// crash or a failure).
//   - refuses anything that isn't an uploaded asset on a member's timeline right now;
//   - a live photo: its video first, then the still linked to it (Immich then hides the video);
//   - a stack: picked by its primary, moves whole; the family copies are stacked again, same
//     primary first;
//   - the family account already has these bytes (an earlier move, another member's copy, put
//     there by hand, or this move before a crash) → that asset, no upload;
//   - carries the metadata the member edited in Immich, unless the family copy has edits of its
//     own (then they are kept; a repeat after a crash sees our own edit and skips too).
import type { ImmichApi, MetadataPatch } from './api.ts';
import type { Db } from './db.ts';

export type SourceAsset = {
  id: string;
  ownerId: string;
  originalPath: string;
  originalFileName: string;
  fileCreatedAt: Date;
  fileModifiedAt: Date;
  checksum: Buffer;
  checksumAlgorithm: string;
  visibility: string;
  status: string;
  deletedAt: Date | null;
  libraryId: string | null;
  livePhotoVideoId: string | null;
  stackId: string | null;
  // Edited in Immich: see EDITED_SQL.
  edited: boolean;
  exif: {
    description: string | null;
    dateTimeOriginal: Date | null;
    timeZone: string | null;
    latitude: number | null;
    longitude: number | null;
    rating: number | null;
  };
};

export type FamilyAsset = { id: string; livePhotoVideoId: string | null };

export type CopyDeps = {
  familyId: () => Promise<string>;
  source(id: string): Promise<SourceAsset | null>;
  // A stack's live members, primary first.
  stack(stackId: string): Promise<{ primaryAssetId: string; memberIds: string[] } | null>;
  // A live family asset with these bytes, or null.
  familyAssetWithBytes(familyId: string, checksum: Buffer): Promise<FamilyAsset | null>;
  // These ids are exactly 1 stack, with ids[0] its primary.
  isStack(ids: string[]): Promise<boolean>;
  editedInImmich(assetId: string): Promise<boolean>;
  openFile(immichPath: string): Promise<Blob>;
  api: Pick<ImmichApi, 'upload' | 'updateMetadata' | 'linkLivePhoto' | 'createStack'>;
};

/** familyAssetId: the copy of the picked asset; originals: what to archive afterwards. */
export type CopyResult = { familyAssetId: string; originals: string[] };

export async function copyToFamily(deps: CopyDeps, assetId: string): Promise<CopyResult> {
  const src = await deps.source(assetId);
  if (!src) throw new Error('asset no longer exists');
  const familyId = await deps.familyId();
  if (!src.stackId) return { familyAssetId: await copyOne(deps, familyId, src), originals: [src.id] };

  const stack = await deps.stack(src.stackId);
  if (!stack || stack.primaryAssetId !== src.id) throw new Error("part of a stack: move the stack by its primary photo");
  const members: SourceAsset[] = [];
  for (const id of stack.memberIds) {
    const m = id === src.id ? src : await deps.source(id);
    if (!m) throw new Error('a stack member no longer exists');
    members.push(m);
  }
  // Checked for all before copying any, so a refused member writes nothing.
  for (const m of members) refuseUnmovable(m, familyId);
  const copies: string[] = [];
  for (const m of members) copies.push(await copyOne(deps, familyId, m));
  if (copies.length > 1 && !(await deps.isStack(copies))) await deps.api.createStack(copies);
  return { familyAssetId: copies[0]!, originals: members.map((m) => m.id) };
}

function refuseUnmovable(src: SourceAsset, familyId: string): void {
  if (src.ownerId === familyId) throw new Error('asset already belongs to the family account');
  if (src.deletedAt || src.status !== 'active') throw new Error('asset is in the trash');
  if (src.libraryId) throw new Error('asset is in an external library');
  if (src.visibility !== 'timeline') throw new Error(`asset is not on the member's timeline (it is ${src.visibility})`);
  if (src.checksumAlgorithm !== 'sha1') throw new Error(`unexpected checksum algorithm ${src.checksumAlgorithm}`);
}

/** 1 asset (+ its live-photo video) → its family copy's id. */
async function copyOne(deps: CopyDeps, familyId: string, src: SourceAsset): Promise<string> {
  refuseUnmovable(src, familyId);

  let videoId: string | undefined;
  if (src.livePhotoVideoId) {
    const video = await deps.source(src.livePhotoVideoId);
    if (!video || video.deletedAt || video.status !== 'active' || video.ownerId !== src.ownerId) {
      throw new Error("the live photo's video no longer exists");
    }
    videoId = (await deps.familyAssetWithBytes(familyId, video.checksum))?.id ?? (await upload(deps, video));
  }

  const existing = await deps.familyAssetWithBytes(familyId, src.checksum);
  let id: string;
  if (existing) {
    id = existing.id;
    if (videoId && existing.livePhotoVideoId !== videoId) await deps.api.linkLivePhoto(id, videoId);
  } else {
    id = await upload(deps, src, videoId);
  }

  const patch = carriedMetadata(src);
  if (Object.keys(patch).length && !(await deps.editedInImmich(id))) await deps.api.updateMetadata(id, patch);
  return id;
}

async function upload(deps: CopyDeps, src: SourceAsset, livePhotoVideoId?: string): Promise<string> {
  const { id, status } = await deps.api.upload({
    file: await deps.openFile(src.originalPath),
    fileName: src.originalFileName,
    fileCreatedAt: src.fileCreatedAt,
    fileModifiedAt: src.fileModifiedAt,
    ...(livePhotoVideoId ? { livePhotoVideoId } : {}),
  });
  // 'duplicate' = the family account already has these bytes. If not as a live asset, they are
  // in its trash (Immich counts trashed assets): stop, or the original would be archived with its
  // only family copy in the trash.
  if (status === 'duplicate' && (await deps.familyAssetWithBytes(await deps.familyId(), src.checksum))?.id !== id) {
    throw new Error(`the family account has ${src.originalFileName} in its trash: restore it or empty the trash, then Retry`);
  }
  return id;
}

/**
 * The description, date (+ time zone), location and rating the source shows, when they may
 * differ from the file (= edited in Immich). Not edited → nothing to send: the family copy has
 * the same bytes, so Immich reads the same values. Edited → send all 5 (unchanged ones are
 * identical anyway).
 */
export function carriedMetadata(src: Pick<SourceAsset, 'exif' | 'edited'>): MetadataPatch {
  if (!src.edited) return {};
  const { exif } = src;
  const patch: MetadataPatch = { description: exif.description ?? '' };
  if (exif.dateTimeOriginal) {
    patch.dateTimeOriginal = exif.dateTimeOriginal.toISOString();
    if (exif.timeZone) patch.timeZone = exif.timeZone;
  }
  if (exif.latitude !== null && exif.longitude !== null) {
    patch.latitude = exif.latitude;
    patch.longitude = exif.longitude;
  }
  // Immich v3 rejects 0; "unrated" is null.
  patch.rating = exif.rating ? exif.rating : null;
  return patch;
}

// "Edited in Immich", verified on v3.3.5: an edit locks the properties, a job then writes them to
// an XMP sidecar and unlocks them again. So: has a sidecar, or still has locked properties (an
// edit whose sidecar job hasn't run yet). Needs alias a (asset) and e (its asset_exif).
const EDITED_SQL = `(EXISTS (SELECT 1 FROM public.asset_file f WHERE f."assetId" = a.id AND f.type = 'sidecar')
                     OR coalesce(cardinality(e."lockedProperties"), 0) > 0)`;
const LIVE = `"deletedAt" IS NULL AND status = 'active'`;

export function sqlCopyDeps(db: Db): Pick<CopyDeps, 'source' | 'stack' | 'familyAssetWithBytes' | 'isStack' | 'editedInImmich'> {
  return {
    async source(id) {
      const [r] = await db.query(
        `SELECT a.id, a."ownerId", a."originalPath", a."originalFileName", a."fileCreatedAt",
                a."fileModifiedAt", a.checksum, a."checksumAlgorithm", a.visibility, a.status,
                a."deletedAt", a."libraryId", a."livePhotoVideoId", a."stackId",
                e.description, e."dateTimeOriginal", e."timeZone", e.latitude, e.longitude, e.rating,
                ${EDITED_SQL} AS edited
           FROM public.asset a LEFT JOIN public.asset_exif e ON e."assetId" = a.id
          WHERE a.id = $1`,
        [id],
      );
      if (!r) return null;
      const v = <T>(k: string) => (r[k] ?? null) as T;
      return {
        id: v('id'), ownerId: v('ownerId'), originalPath: v('originalPath'), originalFileName: v('originalFileName'),
        fileCreatedAt: v('fileCreatedAt'), fileModifiedAt: v('fileModifiedAt'), checksum: v('checksum'),
        checksumAlgorithm: v('checksumAlgorithm'), visibility: v('visibility'), status: v('status'),
        deletedAt: v('deletedAt'), libraryId: v('libraryId'), livePhotoVideoId: v('livePhotoVideoId'),
        stackId: v('stackId'), edited: r.edited === true,
        exif: {
          description: v('description'), dateTimeOriginal: v('dateTimeOriginal'), timeZone: v('timeZone'),
          latitude: v('latitude'), longitude: v('longitude'), rating: v('rating'),
        },
      };
    },

    async stack(stackId) {
      const rows = await db.query<{ primaryAssetId: string; id: string }>(
        `SELECT st."primaryAssetId", a.id FROM public.stack st
           JOIN public.asset a ON a."stackId" = st.id AND a."deletedAt" IS NULL AND a.status = 'active'
          WHERE st.id = $1
          ORDER BY (a.id = st."primaryAssetId") DESC, a."localDateTime", a.id`,
        [stackId],
      );
      if (!rows.length) return null;
      return { primaryAssetId: rows[0]!.primaryAssetId, memberIds: rows.map((r) => r.id) };
    },

    async familyAssetWithBytes(familyId, checksum) {
      const [r] = await db.query<FamilyAsset>(
        `SELECT id, "livePhotoVideoId" FROM public.asset
          WHERE "ownerId" = $1 AND checksum = $2 AND "libraryId" IS NULL AND ${LIVE}
          LIMIT 1`,
        [familyId, checksum],
      );
      return r ?? null;
    },

    async isStack(ids) {
      const [r] = await db.query<{ ok: boolean }>(
        `WITH c AS (SELECT DISTINCT "stackId" AS id FROM public.asset WHERE id = ANY($1::uuid[]))
         SELECT (SELECT count(*) FROM c) = 1
            AND (SELECT st."primaryAssetId" FROM public.stack st WHERE st.id = (SELECT id FROM c LIMIT 1)) = $3::uuid
            AND (SELECT count(*) FROM public.asset s
                  WHERE s."stackId" = (SELECT id FROM c LIMIT 1) AND s."deletedAt" IS NULL AND s.status = 'active') = $2
                AS ok`,
        [ids, ids.length, ids[0]],
      );
      return r?.ok === true;
    },

    async editedInImmich(assetId) {
      const [r] = await db.query<{ edited: boolean }>(
        `SELECT ${EDITED_SQL} AS edited FROM public.asset a LEFT JOIN public.asset_exif e ON e."assetId" = a.id WHERE a.id = $1`,
        [assetId],
      );
      return r?.edited === true;
    },
  };
}
