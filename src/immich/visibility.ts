// The picker's only write to Immich's database: archive ⇄ timeline of originals (Immich's API
// lets only an asset's owner do it). The role may update nothing but asset.visibility (+ the
// asset_face columns Immich's trigger copies it into: dev/picker-db.sql); the rest is enforced
// here: only these 2 targets, and only on live, uploaded assets that are archived or on the
// timeline (never hidden live-photo halves, locked, trashed or external-library assets).
import type { Db } from './db.ts';

export type VisibilityResult =
  | { id: string; result: 'changed' | 'unchanged' }
  | { id: string; result: 'refused'; reason: string };

export async function setVisibility(db: Db, ids: string[], target: 'archive' | 'timeline'): Promise<VisibilityResult[]> {
  if (target !== 'archive' && target !== 'timeline') throw new Error(`refusing visibility ${String(target)}`);
  if (!ids.length) return [];
  const changed = new Set(
    (
      await db.query<{ id: string }>(
        `UPDATE public.asset SET visibility = $2::asset_visibility_enum
          WHERE id = ANY($1::uuid[]) AND visibility IN ('archive', 'timeline') AND visibility <> $2::asset_visibility_enum
            AND "deletedAt" IS NULL AND status = 'active' AND "libraryId" IS NULL
          RETURNING id`,
        [ids, target],
      )
    ).map((r) => r.id),
  );
  const rest = ids.filter((id) => !changed.has(id));
  const state = new Map(
    (rest.length
      ? await db.query<{ id: string; visibility: string; status: string; deletedAt: Date | null; libraryId: string | null }>(
          `SELECT id, visibility, status, "deletedAt", "libraryId" FROM public.asset WHERE id = ANY($1::uuid[])`,
          [rest],
        )
      : []
    ).map((r) => [r.id, r]),
  );
  return ids.map((id): VisibilityResult => {
    if (changed.has(id)) return { id, result: 'changed' };
    const a = state.get(id);
    if (!a) return { id, result: 'refused', reason: 'asset no longer exists' };
    if (a.deletedAt || a.status !== 'active') return { id, result: 'refused', reason: 'asset is in the trash' };
    if (a.libraryId) return { id, result: 'refused', reason: 'asset is in an external library' };
    if (a.visibility === target) return { id, result: 'unchanged' };
    return { id, result: 'refused', reason: `asset is ${a.visibility}` };
  });
}
