-- The picker's Postgres login in Immich's database: a role and column grants, nothing else (no
-- schema, function or table of the picker). Production needs the same.
-- Run with psql variables u = role name, p = password.
--
--   reads:  assets (+ files, exif), stacks, albums (+ their assets), users' id/name/email;
--   writes: asset.visibility only (archive ⇄ timeline; the picker's code allows nothing else).
--           Immich's AFTER UPDATE trigger asset_face_update_asset_state runs as the caller and
--           copies the asset's state into asset_face, so those 3 asset_face columns need UPDATE
--           too (+ SELECT on "assetId" for the trigger's WHERE). Columns set by a BEFORE trigger
--           (updatedAt) need no grant.
SELECT format('CREATE ROLE %I LOGIN', :'u')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'u') \gexec
ALTER ROLE :"u" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'p';
GRANT USAGE ON SCHEMA public TO :"u";
GRANT SELECT ON public.asset, public.asset_file, public.asset_exif, public.stack,
  public.album, public.album_asset TO :"u";
GRANT SELECT (id, name, email, "deletedAt") ON public."user" TO :"u";
GRANT UPDATE (visibility) ON public.asset TO :"u";
GRANT SELECT ("assetId"), UPDATE ("ownerId", "assetVisibility", "assetDeletedAt") ON public.asset_face TO :"u";
