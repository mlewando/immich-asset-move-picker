// The login session's end, seen from the page.
// - Expired: every background request (fetch, <img>, <video>) gets a 401. A grid of hundreds of
//   tiles must not start hundreds of logins, so they fail fast and the page reloads once: that
//   single top-level navigation does the 1 login.
// - Kept alive: the session ends after some idle time. The page's timed polls don't count (they
//   carry X-Picker-Poll), and looking at a photo in the viewer sends nothing, so while the user
//   clicks, types or scrolls the page pings the server (at most once per PING_MS).
// - Ended while nobody uses the tab: a poll's 401 doesn't reload (that would log an unused tab
//   straight back in while the provider's own session lasts). The next click, key or scroll does.

export const PING_MS = 60_000;

export function makeExpiry({ fetch, reload, now = () => Date.now() }) {
  let reloading = false;
  let ended = false;
  let probe = null;
  let lastPing = -Infinity;

  const isExpired = (res) => res.status === 401;

  const expired = () => {
    if (reloading) return;
    reloading = true;
    reload();
  };

  // An <img>/<video> error doesn't say why it failed, so ask a cheap endpoint. All errors that
  // arrive while a probe is in flight share it: a failing grid causes 1 probe, not hundreds.
  const check = () => {
    if (reloading) return Promise.resolve();
    probe ??= fetch('/api/status')
      .then((res) => {
        if (isExpired(res)) expired();
      })
      .catch(() => {})
      .finally(() => {
        probe = null;
      });
    return probe;
  };

  // A poll found the session gone: wait for the user.
  const endedUnseen = () => {
    ended = true;
  };

  // The user did something: keep the session alive (the ping also notices an expired one).
  const active = () => {
    if (ended) return expired();
    const t = now();
    if (t - lastPing < PING_MS) return;
    lastPing = t;
    check();
  };

  return { isExpired, expired, endedUnseen, check, active };
}

export const expiry = makeExpiry({
  fetch: (...args) => globalThis.fetch(...args),
  reload: () => globalThis.location.reload(),
});

export function keepAlive(target = globalThis) {
  for (const type of ['pointerdown', 'keydown', 'wheel']) target.addEventListener(type, expiry.active, { passive: true });
}
