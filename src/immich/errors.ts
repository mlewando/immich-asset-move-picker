// Which failures are expected to pass on their own, so a job tries again later instead of
// waiting for the curator's Retry.
import { ImmichError } from './api.ts';

// Network trouble talking to Immich's API or database.
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

/** Marks an error as transient (see isTransient). */
export function transient<E extends Error>(err: E): E {
  return Object.assign(err, { transient: true });
}

/**
 * True for a failure that a later try usually gets past: no answer from Immich (network error,
 * timeout), Immich restarting (HTTP 502, 503, 504), a dropped database connection, or a file that
 * Storage Template Migration moved meanwhile (the next try reads the new path).
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof ImmichError) return err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504;
  const e = err as { transient?: unknown; code?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (e.transient === true) return true;
  if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return true;
  // node-postgres, when the server or the network drops the connection.
  return typeof e.message === 'string' && /Connection terminated|connection timeout/i.test(e.message);
}
