// Hard link: after a move, each original's file name points to the family copy's file, so the
// photo is stored once. The family copy is the family asset with the original's bytes
// (checksum). Live photos: the still and its video are both linked.
//
// Per pair, before linking: both files exist and are regular files (lstat: never a symlink),
// same size, and the family file's sha1 equals the original's checksum. Already the same inode
// → nothing to do (resume). Then link(family, <original dir>/.picker-<uuid>.tmp) and rename it
// over the original's name: atomic, the original name never disappears. Both names must be on
// the same filesystem, so the whole library is 1 mount (else link fails with EXDEV).
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Db } from './db.ts';

export type LinkPair = {
  originalId: string;
  originalPath: string; // Immich path
  checksum: Buffer; // sha1 of the original's bytes
  familyPath: string | null; // Immich path of the family asset with these bytes, if any
};

export type LinkResult = { id: string; path: string } & (
  | { result: 'linked' | 'already' }
  | { result: 'mismatch' | 'failed'; reason: string }
);

export type LinkDeps = {
  pairs(originalIds: string[]): Promise<LinkPair[]>;
  // Immich path → local path, or null when outside the mapped library.
  localPath(immichPath: string): string | null;
};

export async function linkToFamily(deps: LinkDeps, originalIds: string[]): Promise<LinkResult[]> {
  const out: LinkResult[] = [];
  for (const p of await deps.pairs(originalIds)) {
    const r = { id: p.originalId, path: p.originalPath };
    try {
      out.push({ ...r, ...(await linkPair(deps, p)) });
    } catch (err) {
      out.push({ ...r, result: 'failed', reason: describe(err, p) });
    }
  }
  return out;
}

type Outcome = { result: 'linked' | 'already' } | { result: 'mismatch' | 'failed'; reason: string };

async function linkPair(deps: LinkDeps, p: LinkPair): Promise<Outcome> {
  if (!p.familyPath) return { result: 'failed', reason: 'no family copy with the same bytes' };
  const original = deps.localPath(p.originalPath);
  const family = deps.localPath(p.familyPath);
  if (!original || !family) return { result: 'failed', reason: 'file outside the mapped library' };

  const [o, f] = await Promise.all([lstat(original), lstat(family)]);
  if (!o.isFile() || !f.isFile()) return { result: 'mismatch', reason: 'not a regular file' };
  if (o.dev === f.dev && o.ino === f.ino) return { result: 'already' };
  if (o.size !== f.size) return { result: 'mismatch', reason: `size differs (original ${o.size}, family ${f.size} bytes)` };
  const sha1 = await sha1Of(family);
  if (!sha1.equals(p.checksum)) {
    return { result: 'mismatch', reason: `family file's sha1 ${sha1.toString('hex')} ≠ original's ${p.checksum.toString('hex')}` };
  }

  const tmp = join(dirname(original), `.picker-${randomUUID()}.tmp`);
  await link(family, tmp);
  try {
    await rename(tmp, original);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return { result: 'linked' };
}

function sha1Of(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest()));
  });
}

function describe(err: unknown, p: LinkPair): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    // E.g. Storage Template Migration moved it meanwhile: Retry re-reads the paths.
    return 'file not found (moved by Storage Template Migration? Retry re-reads the paths)';
  }
  if (code === 'EXDEV') return 'original and family file are on different filesystems (mount the whole library share once)';
  return `${code ?? (err as Error).message} (${p.originalPath})`;
}

export function sqlLinkPairs(db: Db, familyId: () => Promise<string>): LinkDeps['pairs'] {
  return async (originalIds) => {
    if (!originalIds.length) return [];
    // The originals plus their live-photo videos; each with the family asset holding its bytes.
    return db.query<LinkPair>(
      `SELECT o.id AS "originalId", o."originalPath", o.checksum, f."originalPath" AS "familyPath"
         FROM public.asset o
         LEFT JOIN LATERAL (
           SELECT "originalPath" FROM public.asset f
            WHERE f.checksum = o.checksum AND f."ownerId" = $2 AND f."libraryId" IS NULL
              AND f."deletedAt" IS NULL AND f.status = 'active'
            LIMIT 1) f ON true
        WHERE o.id = ANY($1::uuid[])
           OR o.id IN (SELECT "livePhotoVideoId" FROM public.asset WHERE id = ANY($1::uuid[]))
        ORDER BY o."originalPath"`,
      [originalIds, await familyId()],
    );
  };
}
