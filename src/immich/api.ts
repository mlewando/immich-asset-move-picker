// Minimal Immich REST client, acting as the family account (its API key). Internal to
// src/immich/; the rest of the app uses the Immich interface (index.ts).

export type ServerVersion = { major: number; minor: number; patch: number };

export type UploadInput = {
  file: Blob;
  fileName: string;
  fileCreatedAt: Date;
  fileModifiedAt: Date;
  // Live photo still: the family copy of its video (uploaded first). Immich then hides the video.
  livePhotoVideoId?: string;
};

// PUT /api/assets (bulk, 1 id): the metadata a move carries over. The bulk endpoint, unlike the
// single one, takes an IANA timeZone next to dateTimeOriginal.
export type MetadataPatch = {
  description?: string;
  dateTimeOriginal?: string;
  timeZone?: string;
  latitude?: number;
  longitude?: number;
  rating?: number | null;
};

export type ImmichApi = {
  getServerVersion(): Promise<ServerVersion>;
  // The family account's user id (the key acts as it; needs user.read).
  getMyUserId(): Promise<string>;
  // 'duplicate' = the family account already has these bytes; id is then that asset.
  upload(input: UploadInput): Promise<{ id: string; status: 'created' | 'duplicate' }>;
  updateMetadata(assetId: string, patch: MetadataPatch): Promise<void>;
  // Links a still to its video (PUT /api/assets/:id); for a still that existed unlinked.
  linkLivePhoto(stillId: string, videoId: string): Promise<void>;
  // POST /api/stacks: first id becomes the primary; stacks the ids are primaries of are merged in.
  createStack(assetIds: string[]): Promise<void>;
  // DELETE /api/assets with force: gone at once, not in the trash (Give back).
  deleteAssets(assetIds: string[]): Promise<void>;
};

export class ImmichError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ImmichError';
    this.status = status;
  }
}

export function createImmichApi(
  apiUrl: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): ImmichApi {
  const call = async (method: string, path: string, body?: BodyInit, opts: { json?: boolean; timeoutMs?: number } = {}) => {
    const headers: Record<string, string> = { 'x-api-key': apiKey, accept: 'application/json' };
    if (opts.json) headers['content-type'] = 'application/json';
    const res = await fetchFn(`${apiUrl}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) {
      // Immich's error body is a short JSON message; never contains the key.
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new ImmichError(`Immich ${method} ${path} → HTTP ${res.status}${text ? `: ${text}` : ''}`, res.status);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  };

  return {
    async getServerVersion() {
      const v = (await call('GET', '/server/version')) as Partial<ServerVersion>;
      if (typeof v.major !== 'number' || typeof v.minor !== 'number' || typeof v.patch !== 'number') {
        throw new Error('Immich GET /server/version → unexpected body');
      }
      return { major: v.major, minor: v.minor, patch: v.patch };
    },

    async getMyUserId() {
      const me = (await call('GET', '/users/me')) as { id?: unknown };
      if (typeof me.id !== 'string') throw new Error('Immich GET /users/me → unexpected body');
      return me.id;
    },

    async upload({ file, fileName, fileCreatedAt, fileModifiedAt, livePhotoVideoId }) {
      const form = new FormData();
      form.append('assetData', file, fileName);
      form.append('fileCreatedAt', fileCreatedAt.toISOString());
      form.append('fileModifiedAt', fileModifiedAt.toISOString());
      form.append('filename', fileName);
      if (livePhotoVideoId) form.append('livePhotoVideoId', livePhotoVideoId);
      // Videos can be large and the NAS slow: allow 30 min for the whole upload.
      const r = (await call('POST', '/assets', form, { timeoutMs: 30 * 60_000 })) as { id?: unknown; status?: unknown };
      if (typeof r.id !== 'string' || (r.status !== 'created' && r.status !== 'duplicate')) {
        throw new Error('Immich POST /assets → unexpected body');
      }
      return { id: r.id, status: r.status };
    },

    async updateMetadata(assetId, patch) {
      await call('PUT', '/assets', JSON.stringify({ ids: [assetId], ...patch }), { json: true, timeoutMs: 30_000 });
    },

    async linkLivePhoto(stillId, videoId) {
      await call('PUT', `/assets/${stillId}`, JSON.stringify({ livePhotoVideoId: videoId }), { json: true, timeoutMs: 30_000 });
    },

    async createStack(assetIds) {
      await call('POST', '/stacks', JSON.stringify({ assetIds }), { json: true, timeoutMs: 30_000 });
    },

    async deleteAssets(assetIds) {
      await call('DELETE', '/assets', JSON.stringify({ ids: assetIds, force: true }), { json: true, timeoutMs: 30_000 });
    },
  };
}
