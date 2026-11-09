// Give back: a family asset goes back to the member(s) it came from.
//   1. plan: the family files to delete (the asset, a live photo's video; a stack whole, picked by
//      its primary) and the originals to put back on the timeline. Nothing records which
//      original belongs to which copy: an original is another account's live, uploaded asset
//      with the same bytes (checksum). Every family file must have such a twin, or nothing
//      happens: the picker never deletes a photo that has no other copy.
//   2. restore the originals first (if deleting then fails, the member briefly sees the photo in
//      both places: safe; the reverse order could hide it);
//   3. delete the family files with force (skips the trash, so a later move doesn't hit a trashed
//      duplicate). Thanks to the hard link, the original's name keeps the data.
// Both writes are safe to repeat: the plan is recorded with step 'restored'.
import type { ImmichApi } from './api.ts';
import type { Db } from './db.ts';

export type GiveBackPlan = { familyIds: string[]; originals: string[] };

export type PlanFile = {
  id: string;
  fileName: string;
  isVideoHalf: boolean; // a live photo's video: deleted with its still, never restored itself
  twins: { id: string; visibility: string }[]; // other accounts' live assets with the same bytes
};

/** The decision, from the facts SQL gathered (unit-tested). */
export function planGiveBack(files: PlanFile[]): GiveBackPlan {
  const orphan = files.find((f) => f.twins.length === 0);
  if (orphan) throw new Error(`no original of ${orphan.fileName} in any member's account: giving it back would delete its only copy`);
  // Archived originals go back; ones already on a timeline (a member never moved it, or a repeat
  // after a crash) are left as they are. Hidden/locked ones stay so.
  const originals = files
    .filter((f) => !f.isVideoHalf)
    .flatMap((f) => f.twins.filter((t) => t.visibility === 'archive' || t.visibility === 'timeline').map((t) => t.id));
  return { familyIds: files.map((f) => f.id), originals: [...new Set(originals)] };
}

const LIVE = (a: string) => `${a}."deletedAt" IS NULL AND ${a}.status = 'active' AND ${a}."libraryId" IS NULL`;

export async function prepareGiveBack(db: Db, familyId: string, assetId: string): Promise<GiveBackPlan> {
  const [a] = await db.query<{ ownerId: string; visibility: string; stackId: string | null; primary: string | null; live: boolean }>(
    `SELECT a."ownerId", a.visibility, a."stackId", st."primaryAssetId" AS primary, (${LIVE('a')}) AS live
       FROM public.asset a LEFT JOIN public.stack st ON st.id = a."stackId"
      WHERE a.id = $1`,
    [assetId],
  );
  if (!a || !a.live) throw new Error('family asset no longer exists');
  if (a.ownerId !== familyId) throw new Error('not a family account asset');
  if (a.visibility !== 'timeline') throw new Error(`family asset is not on the family timeline (it is ${a.visibility})`);
  if (a.stackId && a.primary !== assetId) throw new Error('part of a stack: give the stack back by its primary photo');

  // The family files: the asset or its whole stack, plus their live-photo videos.
  const files = await db.query<{ id: string; fileName: string; isVideoHalf: boolean; twins: { id: string; visibility: string }[] }>(
    `WITH picked AS (
       SELECT a.id FROM public.asset a
        WHERE ${LIVE('a')} AND (a.id = $1 OR ($2::uuid IS NOT NULL AND a."stackId" = $2::uuid))),
     files AS (
       SELECT id, false AS "isVideoHalf" FROM picked
       UNION
       SELECT v.id, true FROM public.asset s JOIN public.asset v ON v.id = s."livePhotoVideoId"
        WHERE s.id IN (SELECT id FROM picked) AND ${LIVE('v')})
     SELECT f.id, a."originalFileName" AS "fileName", f."isVideoHalf",
            coalesce((SELECT json_agg(json_build_object('id', o.id, 'visibility', o.visibility) ORDER BY o.id)
                        FROM public.asset o
                       WHERE o.checksum = a.checksum AND o."ownerId" <> $3 AND ${LIVE('o')}), '[]') AS twins
       FROM files f JOIN public.asset a ON a.id = f.id
      ORDER BY f."isVideoHalf", a."originalFileName"`,
    [assetId, a.stackId, familyId],
  );
  return planGiveBack(files);
}

/** Force-deletes the family assets that still exist (a repeat skips the gone ones). */
export async function deleteFromFamily(db: Db, api: Pick<ImmichApi, 'deleteAssets'>, familyId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const existing = (
    // A force-deleted asset is 'deleted' until Immich's job removes the row: already done.
    await db.query<{ id: string }>(
      `SELECT id FROM public.asset WHERE id = ANY($1::uuid[]) AND "ownerId" = $2 AND status <> 'deleted'`,
      [ids, familyId],
    )
  ).map((r) => r.id);
  if (existing.length) await api.deleteAssets(existing);
}
