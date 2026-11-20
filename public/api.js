// Thin wrappers over the picker's API (src/server.ts).
import { expiry } from './expiry.js';

// Every write carries the CSRF token (GET /api/csrf), fetched before the 1st write and again
// when the server no longer accepts it (its cookie gone, e.g. after a browser restart). `failed`:
// the token a write was refused with; writes refused together share 1 new token, else each fetch
// would replace the cookie the other's token belongs to.
let csrf = null;
const csrfToken = (failed) => {
  if (!csrf || (failed && csrf === failed)) {
    csrf = request('GET', '/api/csrf').then(
      (r) => r.token,
      (err) => {
        csrf = null;
        throw err;
      },
    );
  }
  return csrf;
};

// poll: a timed background request, not the user's doing. It carries X-Picker-Poll, so the
// server doesn't count it as activity and an open but unused tab still goes idle.
async function request(method, url, body, { poll = false, failedToken = null } = {}) {
  const headers = { accept: 'application/json' };
  const token = method === 'GET' ? null : csrfToken(failedToken);
  if (token) headers['csrf-token'] = await token;
  if (poll) headers['x-picker-poll'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (expiry.isExpired(res)) {
    if (poll) expiry.endedUnseen();
    else expiry.expired();
    throw new Error('Session expired, reloading');
  }
  const data = await res.json().catch(() => null);
  if (res.status === 403 && token && !failedToken && /csrf/i.test(data?.error ?? '')) {
    return request(method, url, body, { poll, failedToken: token });
  }
  if (!res.ok) throw new Error(data?.error ?? `${url}: HTTP ${res.status}`);
  return data;
}
const get = (url, opts) => request('GET', url, undefined, opts);

export const api = {
  status: (opts) => get('/api/status', opts),
  members: () => get('/api/members'),
  // filter: { album, from, to } (each optional; from/to YYYY-MM-DD)
  memberAssets: (id, filter = {}, opts) => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
    return get(`/api/members/${id}/assets${q ? `?${q}` : ''}`, opts);
  },
  memberAlbums: (id) => get(`/api/members/${id}/albums`),
  familyAssets: (opts) => get('/api/family/assets', opts),
  jobs: (opts) => get('/api/jobs', opts),
  // 1 page of a queue section ('active' | 'failed' | 'done') → { jobs, next }; after: the previous page's next.
  jobList: ({ section, after, onlyFailures }, opts) => {
    const q = new URLSearchParams({ section });
    if (after != null) q.set('after', String(after));
    if (onlyFailures) q.set('onlyFailures', 'true');
    return get(`/api/jobs/list?${q}`, opts);
  },
  jobEvents: (id, opts) => get(`/api/jobs/${id}/events`, opts),
  move: (memberId, assetIds) => request('POST', '/api/moves', { memberId, assetIds }),
  giveBack: (assetIds) => request('POST', '/api/givebacks', { assetIds }),
  retryJob: (id) => request('POST', `/api/jobs/${id}/retry`),
  // → { next }: where the browser goes now (the provider's logout, or the signed-out page).
  signOut: () => request('POST', '/oauth2/sign_out'),
};

export const media = {
  thumbnail: (id) => `/media/${id}/thumbnail`,
  preview: (id) => `/media/${id}/preview`,
  video: (id) => `/media/${id}/video`,
};
