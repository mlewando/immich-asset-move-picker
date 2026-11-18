// After a move, Immich makes the family copy's thumbnail and preview later, in its own job queue
// (hours behind for a big batch). An original's family copy (the family asset with its bytes) is
// ready once both files are in asset_file. Live-photo videos are not checked: they are hidden
// and shown through their still. 1 query for any number of originals.
import type { Db } from './db.ts';

/** The originals whose family copy has no thumbnail or preview yet (or no family copy at all). */
export async function missingThumbnails(db: Db, familyId: string, originalIds: string[]): Promise<Set<string>> {
  if (!originalIds.length) return new Set();
  const rows = await db.query<{ id: string }>(
    `SELECT o.id
       FROM public.asset o
       LEFT JOIN LATERAL (
         SELECT id FROM public.asset f
          WHERE f.checksum = o.checksum AND f."ownerId" = $2 AND f."libraryId" IS NULL
            AND f."deletedAt" IS NULL AND f.status = 'active'
          LIMIT 1) f ON true
      WHERE o.id = ANY($1::uuid[])
        AND (f.id IS NULL
             OR NOT EXISTS (SELECT 1 FROM public.asset_file t WHERE t."assetId" = f.id AND t.type = 'thumbnail')
             OR NOT EXISTS (SELECT 1 FROM public.asset_file t WHERE t."assetId" = f.id AND t.type = 'preview'))`,
    [originalIds, familyId],
  );
  return new Set(rows.map((r) => r.id));
}
