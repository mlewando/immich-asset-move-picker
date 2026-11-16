// Thin wrappers over the picker's API (src/server.ts).
import { expiry } from './expiry.js';

// poll: a timed background request, not the user's doing. It carries X-Picker-Poll, so the
// server doesn't count it as activity and an open but unused tab still goes idle.
async function request(method, url, body, { poll = false } = {}) {
  const headers = { accept: 'application/json' };
  // Every mutating request carries X-Picker: 1 (a cross-site form post can't set it).
  if (method !== 'GET') headers['x-picker'] = '1';
  if (poll) headers['x-picker-poll'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (expiry.isExpired(res)) {
    if (poll) expiry.endedUnseen();
    else expiry.expired();
    throw new Error('Session expired, reloading');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `${url}: HTTP ${res.status}`);
  return data;
}
const get = (url, opts) => request('GET', url, undefined, opts);

export const api = {
  status: (opts) => get('/api/status', opts),
  members: () => get('/api/members'),
  // filter: { album, from, to } (each optional; from/to YYYY-MM-DD)
  memberAssets: (id, filter = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
    return get(`/api/members/${id}/assets${q ? `?${q}` : ''}`);
  },
  memberAlbums: (id) => get(`/api/members/${id}/albums`),
  familyAssets: () => get('/api/family/assets'),
  jobs: (opts) => get('/api/jobs', opts),
  move: (memberId, assetIds) => request('POST', '/api/moves', { memberId, assetIds }),
  giveBack: (assetIds) => request('POST', '/api/givebacks', { assetIds }),
  retryJob: (id) => request('POST', `/api/jobs/${id}/retry`),
};

export const media = {
  thumbnail: (id) => `/media/${id}/thumbnail`,
  preview: (id) => `/media/${id}/preview`,
  video: (id) => `/media/${id}/video`,
};
