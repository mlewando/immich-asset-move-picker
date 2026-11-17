// Wipes the local dev Immich: containers, Postgres volume, uploaded files, dev/.env.local, and the
// local Authelia (its secrets, certificate and users).
// Keeps generated fixtures (dev/.data/fixtures). Follow with `npm run dev:up && npm run dev:seed`.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV = dirname(fileURLToPath(import.meta.url));
execFileSync('docker', ['compose', '-f', join(DEV, 'compose.yml'), '--profile', 'app', '--profile', 'auth', 'down', '-v'], { stdio: 'inherit' });
for (const p of ['.data/immich', '.data/metrics', '.data/picker', '.data/picker-container', '.data/authelia', '.env.local']) {
  rmSync(join(DEV, p), { recursive: true, force: true });
}
console.log('reset done');
