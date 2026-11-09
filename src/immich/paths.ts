// Immich stores file paths as its server sees them (/data/<subdir>/…). Map them to where the
// picker sees the same files: library subdirs under the 1 library mount, thumbs under
// thumbsDir. Anything else, or any path that isn't already normalized (.., //, ./), is refused.
import { posix } from 'node:path';
import type { Config } from '../config.ts';

export function mapImmichPath(immichPath: string, lib: Config['library']): string | null {
  if (!immichPath.startsWith('/data/') || posix.normalize(immichPath) !== immichPath) return null;
  const [, , subdir, ...rest] = immichPath.split('/');
  if (!subdir || rest.length === 0 || rest.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (subdir === 'thumbs') return posix.join(lib.thumbsDir, ...rest);
  if (lib.subdirs.includes(subdir)) return posix.join(lib.mount, subdir, ...rest);
  return null;
}
