// copyToFamily's decisions (src/immich/copy.ts) over an in-memory Immich. The SQL behind it is
// covered by test/integration/move.int.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MetadataPatch, UploadInput } from '../src/immich/api.ts';
import { carriedMetadata, copyToFamily, type CopyDeps, type SourceAsset } from '../src/immich/copy.ts';

const MEMBER = '00000000-0000-4000-8000-0000000a0001';
const FAMILY = '00000000-0000-4000-8000-00000000fa01';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const NO_EXIF: SourceAsset['exif'] = { description: '', dateTimeOriginal: null, timeZone: null, latitude: null, longitude: null, rating: null };
function source(over: Partial<SourceAsset> = {}): SourceAsset {
  const id = over.id ?? uuid();
  return {
    id, ownerId: MEMBER, originalPath: `/data/upload/u1/${id}`, originalFileName: `${id}.jpg`,
    fileCreatedAt: new Date('2026-07-01T09:12:00Z'), fileModifiedAt: new Date('2026-07-01T09:13:00Z'),
    checksum: Buffer.from(uuid()), checksumAlgorithm: 'sha1', visibility: 'timeline', status: 'active',
    deletedAt: null, libraryId: null, livePhotoVideoId: null, stackId: null, edited: false, exif: NO_EXIF,
    ...over,
  };
}

type Fam = { id: string; checksum: Buffer; edited: boolean; livePhotoVideoId: string | null; stackId: string | null };

// In-memory Immich: member sources + stacks, family assets + stacks; side effects in order.
function world(...sources: SourceAsset[]) {
  const calls: string[] = [];
  const family: Fam[] = [];
  const stacks = new Map<string, string[]>(); // stack id → member ids, primary first
  const familyStacks = new Map<string, string[]>();
  const failNext: { upload?: Error; updateMetadata?: Error } = {};
  const trash: Buffer[] = []; // checksums in the family account's trash
  const name = (id: string) => sources.find((s) => s.id === id)?.originalFileName ?? id;
  const deps: CopyDeps = {
    familyId: async () => FAMILY,
    source: async (id) => structuredClone(sources.find((s) => s.id === id) ?? null),
    stack: async (id) => (stacks.has(id) ? { primaryAssetId: stacks.get(id)![0]!, memberIds: [...stacks.get(id)!] } : null),
    familyAssetWithBytes: async (_f, checksum) => {
      const f = family.find((x) => x.checksum.equals(checksum));
      return f ? { id: f.id, livePhotoVideoId: f.livePhotoVideoId } : null;
    },
    isStack: async (ids) => [...familyStacks.values()].some((m) => m.join() === ids.join()),
    editedInImmich: async (id) => family.find((f) => f.id === id)?.edited ?? false,
    openFile: async (p) => new Blob([p]),
    api: {
      async upload(input: UploadInput) {
        if (failNext.upload) throw failNext.upload;
        const src = sources.find((s) => s.originalFileName === input.fileName)!;
        if (trash.some((c) => c.equals(src.checksum))) {
          calls.push(`upload:${input.fileName}:duplicate`);
          return { id: 'fam-trashed', status: 'duplicate' as const };
        }
        const id = `fam-${src.id}`;
        family.push({ id, checksum: src.checksum, edited: false, livePhotoVideoId: input.livePhotoVideoId ?? null, stackId: null });
        calls.push(`upload:${input.fileName}${input.livePhotoVideoId ? `+${input.livePhotoVideoId}` : ''}`);
        return { id, status: 'created' as const };
      },
      async updateMetadata(id: string, patch: MetadataPatch) {
        if (failNext.updateMetadata) throw failNext.updateMetadata;
        family.find((f) => f.id === id)!.edited = true; // Immich locks the edited properties
        calls.push(`metadata:${id}:${JSON.stringify(patch)}`);
      },
      async linkLivePhoto(stillId: string, videoId: string) {
        family.find((f) => f.id === stillId)!.livePhotoVideoId = videoId;
        calls.push(`link:${stillId}+${videoId}`);
      },
      async createStack(ids: string[]) {
        familyStacks.set(uuid(), ids);
        calls.push(`stack:${ids.join(',')}`);
      },
    },
  };
  return { deps, calls, family, stacks, familyStacks, failNext, trash, name };
}

const beach: SourceAsset['exif'] = {
  description: 'Beach', dateTimeOriginal: new Date('2026-07-01T07:12:00Z'), timeZone: 'Europe/Warsaw',
  latitude: 54.5, longitude: 18.5, rating: 4,
};

test('plain photo: uploaded, edited metadata carried, original listed', async () => {
  const s = source({ originalFileName: 'a.jpg', edited: true, exif: beach });
  const w = world(s);
  assert.deepEqual(await copyToFamily(w.deps, s.id), { familyAssetId: `fam-${s.id}`, originals: [s.id] });
  assert.deepEqual(w.calls, [
    'upload:a.jpg',
    `metadata:fam-${s.id}:{"description":"Beach","dateTimeOriginal":"2026-07-01T07:12:00.000Z","timeZone":"Europe/Warsaw","latitude":54.5,"longitude":18.5,"rating":4}`,
  ]);
});

test('not edited in Immich → upload only', async () => {
  const s = source({ originalFileName: 'a.jpg', exif: beach });
  const w = world(s);
  await copyToFamily(w.deps, s.id);
  assert.deepEqual(w.calls, ['upload:a.jpg']);
});

test('family already has the bytes → that asset, no upload; its own edits kept', async () => {
  const s = source({ edited: true, exif: beach });
  const w = world(s);
  w.family.push({ id: 'fam-edited', checksum: s.checksum, edited: true, livePhotoVideoId: null, stackId: null });
  assert.equal((await copyToFamily(w.deps, s.id)).familyAssetId, 'fam-edited');
  assert.deepEqual(w.calls, []);

  // Unedited family copy (e.g. uploaded by hand) gets the member's edits.
  const s2 = source({ edited: true, exif: beach });
  const w2 = world(s2);
  w2.family.push({ id: 'fam-plain', checksum: s2.checksum, edited: false, livePhotoVideoId: null, stackId: null });
  assert.equal((await copyToFamily(w2.deps, s2.id)).familyAssetId, 'fam-plain');
  assert.equal(w2.calls.length, 1);
  assert.match(w2.calls[0]!, /^metadata:fam-plain:/);
});

test("bytes only in the family account's trash → refused (Immich answers 'duplicate' with the trashed asset)", async () => {
  const s = source({ originalFileName: 'shared.jpg' });
  const w = world(s);
  w.trash.push(s.checksum);
  await assert.rejects(copyToFamily(w.deps, s.id), /family account has shared\.jpg in its trash/);
  assert.deepEqual(w.calls, ['upload:shared.jpg:duplicate']);
});

test('safe to repeat: a failure after the upload → the repeat reuses the copy, carries metadata once', async () => {
  const s = source({ originalFileName: 'b.jpg', edited: true, exif: { ...NO_EXIF, description: 'x' } });
  const w = world(s);
  w.failNext.updateMetadata = new Error('Immich PUT /assets → HTTP 500');
  await assert.rejects(copyToFamily(w.deps, s.id), /HTTP 500/);
  delete w.failNext.updateMetadata;

  await copyToFamily(w.deps, s.id);
  assert.equal(w.family.length, 1, 'no 2nd copy');
  assert.deepEqual(w.calls, ['upload:b.jpg', `metadata:fam-${s.id}:{"description":"x","rating":null}`]);

  await copyToFamily(w.deps, s.id); // 3rd run (crash before the step was recorded)
  assert.equal(w.calls.length, 2, 'nothing written again');
});

test('live photo: video first, then the still linked to it; only the still is an original', async () => {
  const video = source({ originalFileName: 'm.mp4', visibility: 'hidden' });
  const still = source({ originalFileName: 's.jpg', livePhotoVideoId: video.id });
  const w = world(still, video);
  assert.deepEqual(await copyToFamily(w.deps, still.id), { familyAssetId: `fam-${still.id}`, originals: [still.id] });
  assert.deepEqual(w.calls, ['upload:m.mp4', `upload:s.jpg+fam-${video.id}`]);

  // Repeat (crash before the step was recorded): both found, already linked → nothing.
  await copyToFamily(w.deps, still.id);
  assert.equal(w.calls.length, 2);
});

test('live photo whose still the family already has, unlinked → video uploaded, still linked', async () => {
  const video = source({ originalFileName: 'm.mp4', visibility: 'hidden' });
  const still = source({ originalFileName: 's.jpg', livePhotoVideoId: video.id });
  const w = world(still, video);
  w.family.push({ id: 'fam-s', checksum: still.checksum, edited: false, livePhotoVideoId: null, stackId: null });
  await copyToFamily(w.deps, still.id);
  assert.deepEqual(w.calls, ['upload:m.mp4', `link:fam-s+fam-${video.id}`]);
});

test("live photo whose video is gone → refused, nothing written", async () => {
  const still = source({ livePhotoVideoId: uuid() });
  const w = world(still);
  await assert.rejects(copyToFamily(w.deps, still.id), /video no longer exists/);
  assert.deepEqual(w.calls, []);
});

test('stack: moves whole from its primary, re-stacked primary first; all are originals', async () => {
  const stackId = uuid();
  const [p, b, c] = ['p.jpg', 'b.jpg', 'c.jpg'].map((f) => source({ originalFileName: f, stackId }));
  const w = world(p!, b!, c!);
  w.stacks.set(stackId, [p!.id, b!.id, c!.id]);
  const r = await copyToFamily(w.deps, p!.id);
  assert.deepEqual(r, { familyAssetId: `fam-${p!.id}`, originals: [p!.id, b!.id, c!.id] });
  assert.deepEqual(w.calls, ['upload:p.jpg', 'upload:b.jpg', 'upload:c.jpg', `stack:fam-${p!.id},fam-${b!.id},fam-${c!.id}`]);

  // Repeat: copies found, stack already there → nothing.
  await copyToFamily(w.deps, p!.id);
  assert.equal(w.calls.length, 4);
});

test('stack: a non-primary pick is refused; 1 unmovable member refuses the whole stack, nothing written', async () => {
  const stackId = uuid();
  const p = source({ stackId });
  const b = source({ stackId, visibility: 'locked' });
  const w = world(p, b);
  w.stacks.set(stackId, [p.id, b.id]);
  await assert.rejects(copyToFamily(w.deps, b.id), /move the stack by its primary/);
  await assert.rejects(copyToFamily(w.deps, p.id), /it is locked/);
  assert.deepEqual(w.calls, []);
});

test('refuses, writing nothing: gone, family-owned, trashed, external, not on timeline', async () => {
  const cases: [string, Partial<SourceAsset> | null, RegExp][] = [
    ['gone', null, /no longer exists/],
    ['family-owned', { ownerId: FAMILY }, /already belongs to the family/],
    ['trashed', { status: 'trashed', deletedAt: new Date() }, /in the trash/],
    ['external', { libraryId: 'lib-1' }, /external library/],
    ['archived', { visibility: 'archive' }, /not on the member's timeline \(it is archive\)/],
    ['locked', { visibility: 'locked' }, /not on the member's timeline \(it is locked\)/],
  ];
  for (const [label, over, re] of cases) {
    const s = source(over ?? {});
    const w = over ? world(s) : world();
    await assert.rejects(copyToFamily(w.deps, s.id), re, label);
    assert.deepEqual(w.calls, [], `${label}: nothing written`);
  }
});

test('carriedMetadata: nothing unless edited; all 5 fields, no half location, rating 0 → null', () => {
  const all = {
    description: 'Beach', dateTimeOriginal: '2026-07-01T07:12:00.000Z', timeZone: 'Europe/Warsaw',
    latitude: 54.5, longitude: 18.5, rating: 4,
  };
  assert.deepEqual(carriedMetadata({ edited: false, exif: beach }), {}, 'not edited: the file has it all');
  assert.deepEqual(carriedMetadata({ edited: true, exif: beach }), all);
  const edited = (over: Partial<typeof beach>) => carriedMetadata({ edited: true, exif: { ...beach, ...over } });
  const without = (...keys: (keyof typeof all)[]) => Object.fromEntries(Object.entries(all).filter(([k]) => !keys.includes(k as keyof typeof all)));
  assert.deepEqual(edited({ latitude: null }), without('latitude', 'longitude'), 'no half location');
  assert.deepEqual(edited({ timeZone: null }), without('timeZone'));
  assert.deepEqual(edited({ dateTimeOriginal: null }), without('dateTimeOriginal', 'timeZone'));
  assert.deepEqual(edited({ description: null, rating: 0 }), { ...all, description: '', rating: null });
});
