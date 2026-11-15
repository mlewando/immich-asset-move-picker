// Expired proxy session handling. When the authenticating proxy's session runs out, every
// background request (fetch, <img>, <video>) gets a 401 or a redirect to the login page. If each
// of them followed that redirect, a grid of hundreds of tiles would start hundreds of logins at
// once and the identity provider would rate-limit them. Instead, background requests fail fast and
// the page reloads once: that single top-level navigation does the 1 login round-trip.

export function makeSession({ fetch, reload }) {
  let reloading = false;
  let probe = null;

  // A redirect is only visible as 'opaqueredirect' with { redirect: 'manual' }.
  const isExpired = (res) => res.status === 401 || res.type === 'opaqueredirect';

  const expired = () => {
    if (reloading) return;
    reloading = true;
    reload();
  };

  // An <img>/<video> error doesn't say why it failed, so ask a cheap endpoint. All errors that
  // arrive while a probe is in flight share it: a failing grid causes 1 probe, not hundreds.
  const check = () => {
    if (reloading) return Promise.resolve();
    probe ??= fetch('/api/status', { redirect: 'manual' })
      .then((res) => {
        if (isExpired(res)) expired();
      })
      .catch(() => {})
      .finally(() => {
        probe = null;
      });
    return probe;
  };

  return { isExpired, expired, check };
}

export const session = makeSession({
  fetch: (...args) => globalThis.fetch(...args),
  reload: () => globalThis.location.reload(),
});
