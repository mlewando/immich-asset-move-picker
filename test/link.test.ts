// Hard-link verification and linking (src/immich/link.ts) on real files in a temp dir.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { linkToFamily, type LinkPair } from '../src/immich/link.ts';

const root = mkdtempSync(join(tmpdir(), 'picker-link-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

// 1 original + 1 family file under root/upload/{member,family}; returns the pair.
function pair(original: string, family: string | null, over: Partial<LinkPair> = {}): LinkPair {
  const k = ++n;
  mkdirSync(join(root, 'upload/member'), { recursive: true });
  mkdirSync(join(root, 'upload/family'), { recursive: true });
  writeFileSync(join(root, `upload/member/${k}.jpg`), original);
  if (family !== null) writeFileSync(join(root, `upload/family/${k}.jpg`), family);
  return {
    originalId: `o${k}`,
    originalPath: `/data/upload/member/${k}.jpg`,
    checksum: createHash('sha1').update(original).digest(),
    familyPath: `/data/upload/family/${k}.jpg`,
    ...over,
  };
}
const local = (p: string) => join(root, p.replace(/^\/data\//, ''));
const run = (pairs: LinkPair[]) => linkToFamily({ pairs: async () => pairs, localPath: local }, pairs.map((p) => p.originalId));
const ino = (p: string) => statSync(local(p)).ino;

test('same bytes → original name now points to the family file (1 inode, 2 links); repeat = already', async () => {
  const p = pair('photo bytes', 'photo bytes');
  assert.deepEqual(await run([p]), [{ id: p.originalId, path: p.originalPath, result: 'linked' }]);
  assert.equal(ino(p.originalPath), ino(p.familyPath!));
  assert.equal(statSync(local(p.originalPath)).nlink, 2);
  assert.equal(readFileSync(local(p.originalPath), 'utf8'), 'photo bytes');
  assert.deepEqual(readdirSync(join(root, 'upload/member')).filter((f) => f.startsWith('.picker-')), [], 'no temp file left');

  assert.equal((await run([p]))[0]!.result, 'already');
});

test('different size or sha1 → mismatch, nothing changed', async () => {
  const size = pair('photo bytes', 'photo bytes!');
  const sha = pair('photo bytes', 'photo bytez');
  const before = [ino(size.originalPath), ino(sha.originalPath)];
  const [r1, r2] = await run([size, sha]);
  assert.deepEqual([r1!.result, r2!.result], ['mismatch', 'mismatch']);
  assert.match((r1 as { reason: string }).reason, /size differs \(original 11, family 12 bytes\)/);
  assert.match((r2 as { reason: string }).reason, /sha1 .* ≠ original's/);
  assert.deepEqual([ino(size.originalPath), ino(sha.originalPath)], before);
});

test('symlink is not a regular file → mismatch', async () => {
  const p = pair('x', 'x');
  rmSync(local(p.familyPath!));
  symlinkSync(local(p.originalPath), local(p.familyPath!));
  assert.equal((await run([p]))[0]!.result, 'mismatch');
});

test('missing file, no family copy, path outside the library → failed with a reason', async () => {
  const gone = pair('x', null);
  const none = pair('y', 'y', { familyPath: null });
  const outside = pair('z', 'z', { familyPath: '/etc/passwd' });
  const results = await linkToFamily(
    { pairs: async () => [gone, none, outside], localPath: (p) => (p.startsWith('/data/') ? local(p) : null) },
    ['ignored'],
  );
  assert.deepEqual(results.map((r) => [r.result, 'reason' in r ? r.reason : '']), [
    ['failed', 'file not found (moved by Storage Template Migration? Retry re-reads the paths)'],
    ['failed', 'no family copy with the same bytes'],
    ['failed', 'file outside the mapped library'],
  ]);
});
