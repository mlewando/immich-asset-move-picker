# Agent guide — immich-asset-move-picker

Read `README.md` (what the app does, requirements, configuration) and `CONTEXT.md` (glossary)
first.

## Working rules
- Commit only when asked. No `Co-Authored-By` trailer.
- Write every number as a numeral (`3`, never "three"), in code comments, docs and commits.
- Terse replies. Define jargon before offering options; give a recommendation, not a survey.
- Verify claims against real code/data, not web inference. Quote `file:line` as evidence.
- Smallest fix that works; no speculative abstractions.
- Comments explain why, in plain words; no references to plans, tickets or conversations.

## Design constraints
- Supports an explicit list of tested Immich versions (`SUPPORTED_IMMICH_VERSIONS` in
  `src/immich/guard.ts`, stated as a range in `README.md`); the upgrade guard makes the app
  read-only on anything else. Add a version only after `npm run test:int` passes against it.
- All knowledge of Immich (API, database schema, file layout, quirks) stays in `src/immich/`;
  the rest of the app uses only `src/immich/index.ts`.
- Nothing of the picker lives in Immich's database: its only writes there are `asset.visibility`
  (archive ⇄ timeline) and deleting a member's album whose photos are all moved (as Immich's own
  delete does). Everything else goes through Immich's API as the family account. Its own state is
  the SQLite job queue.
- Never delete a photo that has no other copy. Every job step is safe to repeat.
- The settings, API key permissions and database grants in `README.md` are what deployments rely
  on: changing them is a breaking change; say so.

## Dev/test
- Never run against a real Immich installation. Real uploads/archives happen only in the local
  throwaway Immich (`npm run dev:up` + `npm run dev:seed`, a supported version, picked by `IMMICH_VERSION`).
- Unit tests: `npm test` (fakes for the Immich interface, DB and API).
- Integration: `npm run test:int` against the local Immich.
- Never print secrets (API keys, DB passwords).
