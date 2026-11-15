// Thin wrappers over the picker's API (src/server.ts).
import { session } from './session.js';

async function request(method, url, body) {
  const headers = { accept: 'application/json' };
  // Every mutating request carries X-Picker: 1 (a cross-site form post can't set it).
  if (method !== 'GET') headers['x-picker'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // A login redirect followed by fetch fails CORS; catch it here and reload instead.
    redirect: 'manual',
  });
  if (session.isExpired(res)) {
    session.expired();
    throw new Error('Session expired, reloading');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `${url}: HTTP ${res.status}`);
  return data;
}
const get = (url) => request('GET', url);

export const api = {
  status: () => get('/api/status'),
  members: () => get('/api/members'),
  // filter: { album, from, to } (each optional; from/to YYYY-MM-DD)
  memberAssets: (id, filter = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
    return get(`/api/members/${id}/assets${q ? `?${q}` : ''}`);
  },
  memberAlbums: (id) => get(`/api/members/${id}/albums`),
  familyAssets: () => get('/api/family/assets'),
  moves: () => get('/api/moves'),
  move: (memberId, assetIds) => request('POST', '/api/moves', { memberId, assetIds }),
  giveBack: (assetIds) => request('POST', '/api/givebacks', { assetIds }),
  retryMove: (id) => request('POST', `/api/moves/${id}/retry`),
};

export const media = {
  thumbnail: (id) => `/media/${id}/thumbnail`,
  preview: (id) => `/media/${id}/preview`,
  video: (id) => `/media/${id}/video`,
};
