# immich-asset-move-picker

A small web app for moving photos from family members' private [Immich](https://immich.app)
accounts into 1 shared family account, without storing anything twice.

Pick photos in a member's timeline and click **Move to family**. Each photo is copied into the
family account (with the description, date, location and rating edited in Immich), the original is
archived in the member's account, and the 2 files are hard-linked so the photo takes no extra
space. **Give back** undoes it: the original returns to the member's timeline and the family
copy is deleted. Live photos and stacks move as a whole: the selection, the message after
**Move to family** and the move's history say how many files that is. A move is done once Immich
has made the family copy's thumbnail and preview; until then the picker shows it as processing
thumbnails. A big batch may wait hours for Immich's queue; a move fails only when Immich made no
move's thumbnails for 30 min (Retry checks again, nothing is moved twice).

Nothing is ever deleted that has no other copy, and every step can be resumed after a failure.
A failure that usually passes on its own (Immich not answering or restarting, a file moved by
Storage Template Migration meanwhile) is tried again after 1, 5 and 15 min (at once when Immich
comes back after being unreachable) before the job waits for **Retry**. While Immich can't be
reached the picker is read-only and its jobs are paused: once paused it checks every 10 s and goes
on by itself once Immich answers, or at once with **Check again**. The **Queue** page shows every
job with its photo, state and history: each step, wait, failure and retry. A photo whose exact
bytes the family account already has is not copied again, and its history says so.

The picker opens on the member last viewed in the browser; the 1st time, on the 1st member with
photos on the timeline.

> Works only with **Immich v3.4.1**.
> It writes to Immich's database and library directly, so on any other version (or schema) it
> stays read-only until it has been tested and updated. Each release's notes repeat its range.

## Requirements
- **Immich v3.4.1**, with the library reachable as
  files.
- An **API key of the family account** with the permissions `asset.upload`, `asset.update`,
  `asset.delete`, `stack.create` and `user.read`.
- A **Postgres role** in Immich's database with the grants in [`dev/picker-db.sql`](dev/picker-db.sql):
  read access, plus updating `asset.visibility` (archive/unarchive). Nothing else is created
  in Immich's database.
- The Immich **library mounted read-write as 1 mount** (hard links don't work across mounts), and
  Immich's thumbnails directory (read-only is enough).
- An **OpenID Connect provider** (e.g. Authelia): the picker is its client and logs users in
  itself, no auth proxy needed. Register a confidential client with:
  - redirect URI `<PICKER_PUBLIC_URL>/oauth2/callback`;
  - scopes `openid profile email groups offline_access`, with `email` and `groups` available
    from UserInfo;
  - grant types `authorization_code` and `refresh_token`, PKCE `S256`, and
    `client_secret_basic`.

  Only members of `PICKER_OIDC_ALLOWED_GROUPS` get in, and only with a refresh token. A session
  lasts as long as the user is active: it ends after `PICKER_SESSION_IDLE` without a request, and
  at the latest 12 hours after the login. Every 5 minutes a refresh re-reads the user from the
  provider, so someone disabled or removed from the groups is out within 5 minutes; if the
  provider stays unreachable for 30 minutes past that, the session ends too. Sign out (in the
  sidebar) ends the session and revokes its refresh token; the provider's own session ends only if
  `PICKER_OIDC_LOGOUT_URL` sends the browser to its logout page, else the next visit logs
  straight back in. A login refused because the account may not use the picker says so and
  offers another account through the same logout page; without `PICKER_OIDC_LOGOUT_URL` it can
  only tell the user to sign out at the provider.

## Running
```sh
docker run -d --name immich-picker --network host \
  --env-file picker.env \
  -v /srv/immich-library:/library \
  -v /var/lib/immich/data/thumbs:/data/thumbs:ro \
  -v /var/lib/node_exporter:/metrics \
  -v /var/lib/picker:/var/lib/picker \
  ghcr.io/mlewando/immich-asset-move-picker:<version>
```
Then open `PICKER_PUBLIC_URL`. `GET /healthz` returns 200 when the database and Immich are
reachable. It needs no login session but HTTP basic auth (`PICKER_HEALTHZ_USER`/`_PASSWORD`),
because it names internal errors.

| Variable | Meaning |
|---|---|
| `IMMICH_API_URL` | e.g. `http://127.0.0.1:2283/api` |
| `IMMICH_FAMILY_API_KEY` | the family account's API key |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | Immich's Postgres, as the picker's role |
| `PICKER_LIBRARY_MOUNT` | where the library is mounted, e.g. `/library` |
| `PICKER_LIBRARY_SUBDIRS` | library subdirectories, e.g. `upload,library,backups,encoded-video` (Immich's `/data/<subdir>/…` → `<mount>/<subdir>/…`) |
| `PICKER_THUMBS_DIR` | Immich's thumbnails directory (default `/data/thumbs`) |
| `PICKER_DATA_DIR` | the app's own state: the SQLite job queue and login sessions; no backup needed |
| `PICKER_JOB_HISTORY_DAYS` | days a done job and its history stay on the Queue page, default `90`; `0` keeps them all |
| `PICKER_METRICS_DIR` | where to write `immich_picker.prom` |
| `PICKER_LISTEN` | default `127.0.0.1:2284` |
| `PICKER_PUBLIC_URL` | where browsers reach the picker, e.g. `https://picker.example.org` |
| `PICKER_OIDC_ISSUER` | the provider's issuer URL, e.g. `https://auth.example.org` |
| `PICKER_OIDC_CLIENT_ID` `PICKER_OIDC_CLIENT_SECRET` | the picker's client at the provider |
| `PICKER_OIDC_ALLOWED_GROUPS` | comma-separated; a user must be in at least 1 |
| `PICKER_SESSION_IDLE` | idle time that ends a session, default `30m` (`s`/`m`/`h`); a change applies to logins after it |
| `PICKER_OIDC_LOGOUT_URL` | optional, https: where Sign out sends the browser next, the provider's logout page (Authelia: `https://auth.example.org/logout?rd=<encoded PICKER_PUBLIC_URL/signed-out>`); default the picker's own signed-out page |
| `PICKER_HEALTHZ_USER` `PICKER_HEALTHZ_PASSWORD` | basic auth for `/healthz`; required unless `PICKER_AUTH=off` |
| `PICKER_TLS_CERT` `PICKER_TLS_KEY` | PEM files: serve HTTPS (read on start; restart after renewal). Required when `PICKER_PUBLIC_URL` is https: the session cookie is then Secure and is set only on HTTPS requests |
| `PICKER_AUTH` | `off` disables the login (local development only; needs a loopback `PICKER_LISTEN`); `off-any-host` also allows other listen addresses (a dev container); default `oidc` |

After moving, run *Administration → Jobs → Storage Template Migration* in Immich so the family
copies are filed into their folders (the app reminds you).

## Metrics
`immich_picker.prom`, a node_exporter textfile, rewritten after every job and every 60 s:
`immich_picker_guard_ok`, `immich_picker_moves_failed`, `immich_picker_moves_pending`,
`immich_picker_oldest_pending_age_seconds`, `immich_picker_link_mismatch_total` (files not
linked because they differ) and `immich_picker_last_write_timestamp_seconds`.

## Development
Needs Node 24 and Docker. Everything runs against a throwaway local Immich (v3.4.1, the newest
supported) with test users (`anna`, `bob`, `family-photos`, password `password123`).
```sh
npm install
npm run dev:up      # start the local Immich: http://127.0.0.1:2283
npm run dev:seed    # users, photos, API key, DB role → dev/.env.local
npm run dev:app     # the app on http://127.0.0.1:2284
npm run check       # type-check
npm test            # unit tests
npm run test:int    # integration tests against the local Immich
npm run dev:reset   # wipe the local Immich
```
To try the page alone, `npm run dev:ui` serves it on http://127.0.0.1:2285 with made-up
members, photos and a queue with a job in every state, and no Docker
([`dev/ui.ts`](dev/ui.ts)). A stand-in worker walks new moves through their steps; some fail
once and retry, some are refused. http://127.0.0.1:2285/dev lists other scenarios (empty queue,
empty accounts, long queues, thumbnails Immich is still making, paused, read-only); each link
starts it afresh.
To test another Immich version (before adding it to the supported ones), start over with it
(Immich can't downgrade its database): `npm run dev:reset`, then `export IMMICH_VERSION=v3.4.2`,
`npm run dev:up`, `npm run dev:seed`, `npm run test:int`.
`npm run dev:app` runs without a login. To try the real one, a local Authelia (the homelab's
version, the same picker client and group policy) runs next to Immich:
```sh
npm run dev:auth      # Authelia on https://auth.localhost:9091 (users curator, outsider)
npm run dev:app:auth  # the app on http://127.0.0.1:2284, login on
```
The browser warns once about Authelia's certificate (a local CA in `dev/.data/authelia/tls`).
`curator` gets in; `outsider` is not in `photos-curators`, so Authelia refuses it.
Node runs the TypeScript sources directly; the only build step is the page's CSS (Tailwind).

CI type-checks, runs the unit tests and builds the image on every push and pull request. To
release, run `npm version patch` (or `minor`/`major`: it bumps `package.json`, commits and tags
`vX.Y.Z`), then `git push origin main --follow-tags`. The tag publishes
`ghcr.io/mlewando/immich-asset-move-picker:X.Y.Z` and creates a GitHub Release whose notes list
the changes since the previous release and the image's digest.

**Code layout:** `src/immich/` is the only code that knows Immich (its API, database schema, file
layout and the upgrade guard) behind 1 interface, `src/immich/index.ts`. Supporting a new Immich
version means checking its changes against that folder, passing `npm run test:int` against it,
and adding it to `SUPPORTED_IMMICH_VERSIONS` in `src/immich/guard.ts` and to the range above. The rest: `src/queue.ts` (job queue),
`src/worker.ts` (move and give-back steps), `src/server.ts` (HTTP API), `src/auth.ts` (OIDC
login; sessions by `@fastify/session` with the SQLite store in `src/session-store.ts`, the
provider's tokens apart in `src/oidc-credentials.ts`), `public/` (the page,
Preact + htm).
