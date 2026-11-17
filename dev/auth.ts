// Local Authelia for trying the picker's real login: secrets, TLS certificate, users, the
// picker's env, then the container. Repeatable: what exists is kept. Dev-only, never real data.
//
//   npm run dev:auth       this script (Authelia on https://auth.localhost:9091)
//   npm run dev:app:auth   the picker with the login on (http://127.0.0.1:2284)
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV = dirname(fileURLToPath(import.meta.url));
const DATA = join(DEV, '.data', 'authelia');
const IMAGE = 'authelia/authelia:4.39.20';
const ISSUER = 'https://auth.localhost:9091';
const PASSWORD = 'password123';
// curator may use the picker; outsider logs in to Authelia but is not in photos-curators.
const USERS = {
  curator: { displayname: 'Curator', email: 'curator@example.test', groups: ['photos-curators'] },
  outsider: { displayname: 'Outsider', email: 'outsider@example.test', groups: ['family'] },
};

const authelia = (...args: string[]): string =>
  execFileSync('docker', ['run', '--rm', '-v', `${DATA}:/data`, IMAGE, 'authelia', ...args], { encoding: 'utf8' });
// `authelia crypto hash generate` prints "Digest: <hash>".
const digest = (password: string): string => {
  const m = /Digest: (\S+)/.exec(authelia('crypto', 'hash', 'generate', 'pbkdf2', '--password', password));
  if (!m) throw new Error('authelia printed no digest');
  return m[1]!;
};
const secret = () => randomBytes(32).toString('base64url');
const writeOnce = (path: string, make: () => string) => {
  if (!existsSync(path)) writeFileSync(path, make(), { mode: 0o600 });
};

for (const d of ['secrets', 'tls', 'oidc']) mkdirSync(join(DATA, d), { recursive: true });

console.log('secrets');
for (const name of ['session_secret', 'storage_encryption_key', 'oidc_hmac_secret', 'reset_password_jwt_secret']) {
  writeOnce(join(DATA, 'secrets', name), secret);
}
const clientSecretFile = join(DATA, 'secrets', 'picker_client_secret');
writeOnce(clientSecretFile, secret);
const clientSecret = readFileSync(clientSecretFile, 'utf8');
writeOnce(join(DATA, 'secrets', 'picker_client_secret_digest'), () => digest(clientSecret));

// A small CA and a certificate for auth.localhost signed by it: the picker trusts the CA
// (NODE_EXTRA_CA_CERTS), the browser asks once.
if (!existsSync(join(DATA, 'tls', 'public.crt'))) {
  console.log('TLS certificate for auth.localhost');
  authelia('crypto', 'certificate', 'rsa', 'generate', '--ca', '--common-name', 'picker dev CA', '--directory', '/data/tls',
    '--file.certificate', 'ca.public.crt', '--file.private-key', 'ca.private.pem');
  authelia('crypto', 'certificate', 'rsa', 'generate', '--common-name', 'auth.localhost', '--sans', 'auth.localhost',
    '--path.ca', '/data/tls', '--directory', '/data/tls');
}
if (!existsSync(join(DATA, 'oidc', 'private.pem'))) {
  console.log('OIDC signing key');
  authelia('crypto', 'pair', 'rsa', 'generate', '--directory', '/data/oidc');
}

if (!existsSync(join(DATA, 'users.yml'))) {
  console.log('users');
  const hash = digest(PASSWORD);
  const users = Object.entries(USERS)
    .map(([name, u]) => `  ${name}:\n    displayname: '${u.displayname}'\n    email: '${u.email}'\n    password: '${hash}'\n    groups: [${u.groups.map((g) => `'${g}'`).join(', ')}]`)
    .join('\n');
  writeFileSync(join(DATA, 'users.yml'), `users:\n${users}\n`, { mode: 0o600 });
}

// Loaded after dev/.env.local (npm run dev:app:auth), so these win over its PICKER_AUTH=off.
writeFileSync(
  join(DATA, 'picker.env'),
  `# Written by \`npm run dev:auth\`: the picker's login against the local Authelia.
PICKER_AUTH=oidc
PICKER_PUBLIC_URL=http://127.0.0.1:2284
PICKER_OIDC_ISSUER=${ISSUER}
PICKER_OIDC_CLIENT_ID=picker
PICKER_OIDC_CLIENT_SECRET=${clientSecret}
PICKER_OIDC_ALLOWED_GROUPS=photos-curators
PICKER_OIDC_LOGOUT_URL=${ISSUER}/logout
PICKER_HEALTHZ_USER=probe
PICKER_HEALTHZ_PASSWORD=${PASSWORD}
`,
  { mode: 0o600 },
);

execFileSync('docker', ['compose', '-f', join(DEV, 'compose.yml'), '--profile', 'auth', 'up', '-d', '--wait', 'authelia'], { stdio: 'inherit' });
console.log(`done
  Authelia: ${ISSUER}  (curator / outsider, password ${PASSWORD}; trust the certificate once)
  next: npm run dev:app:auth, then open http://127.0.0.1:2284`);
