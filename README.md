# immich-asset-move-picker

A small web app for moving photos from family members' private [Immich](https://immich.app)
accounts into 1 shared family account, without storing anything twice.

Pick photos in a member's timeline and click **Move to family**. Each photo is copied into the
family account (with the description, date, location and rating edited in Immich), the original is
archived in the member's account, and the 2 files are hard-linked so the photo takes no extra
space. **Give back** undoes it: the original returns to the member's timeline and the family
copy is deleted. Live photos and stacks move as a whole.

Nothing is ever deleted that has no other copy, and every step can be resumed after a failure.

> Works only with **Immich v3.3.5**. It writes to Immich's database and library directly, so on
> any other version (or schema) it stays read-only until it has been tested and updated.

## Requirements
- **Immich v3.3.5**, with the library reachable as files.
- An **API key of the family account** with the permissions `asset.upload`, `asset.update`,
  `asset.delete`, `stack.create` and `user.read`.
- A **Postgres role** in Immich's database with the grants in [`dev/picker-db.sql`](dev/picker-db.sql):
  read access, plus updating `asset.visibility` (archive/unarchive). Nothing else is created
  in Immich's database.
- The Immich **library mounted read-write as 1 mount** (hard links don't work across mounts), and
  Immich's thumbnails directory (read-only is enough).
- An **authenticating reverse proxy** in front: the app has no login of its own. It logs the
  user from `X-Forwarded-Email` when present.

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
Then open `http://127.0.0.1:2284` through your proxy. `GET /healthz` returns 200 when the database
and Immich are reachable.

| Variable | Meaning |
|---|---|
| `IMMICH_API_URL` | e.g. `http://127.0.0.1:2283/api` |
| `IMMICH_FAMILY_API_KEY` | the family account's API key |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | Immich's Postgres, as the picker's role |
| `PICKER_LIBRARY_MOUNT` | where the library is mounted, e.g. `/library` |
| `PICKER_LIBRARY_SUBDIRS` | library subdirectories, e.g. `upload,library,backups,encoded-video` (Immich's `/data/<subdir>/…` → `<mount>/<subdir>/…`) |
| `PICKER_THUMBS_DIR` | Immich's thumbnails directory (default `/data/thumbs`) |
| `PICKER_DATA_DIR` | the app's own state, a small SQLite job queue; no backup needed |
| `PICKER_METRICS_DIR` | where to write `immich_picker.prom` |
| `PICKER_LISTEN` | default `127.0.0.1:2284` |

After moving, run *Administration → Jobs → Storage Template Migration* in Immich so the family
copies are filed into their folders (the app reminds you).

## Metrics
`immich_picker.prom`, a node_exporter textfile, rewritten after every job and every 60 s:
`immich_picker_guard_ok`, `immich_picker_moves_failed`, `immich_picker_moves_pending`,
`immich_picker_oldest_pending_age_seconds`, `immich_picker_link_mismatch_total` (files not
linked because they differ) and `immich_picker_last_write_timestamp_seconds`.

## Development
Needs Node 24 and Docker. Everything runs against a throwaway local Immich v3.3.5 with test
users (`anna`, `bob`, `family-photos`, password `password123`).
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
Node runs the TypeScript sources directly; the only build step is the page's CSS (Tailwind).

CI type-checks, runs the unit tests and builds the image on every push and pull request. A
release is a tag: pushing `vX.Y.Z` publishes `ghcr.io/mlewando/immich-asset-move-picker:X.Y.Z`.

**Code layout:** `src/immich/` is the only code that knows Immich (its API, database schema, file
layout and the upgrade guard) behind 1 interface, `src/immich/index.ts`. Supporting a new Immich
version means changing that folder and its tests. The rest: `src/queue.ts` (job queue),
`src/worker.ts` (move and give-back steps), `src/server.ts` (HTTP API), `public/` (the page,
Preact + htm).
