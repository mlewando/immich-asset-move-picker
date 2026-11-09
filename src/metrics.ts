// Metrics as a node_exporter textfile, PICKER_METRICS_DIR/immich_picker.prom, written atomically
// (temp file in the same dir + rename) after every worker change and at least every 60 s.
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type MetricsState = {
  guardOk: boolean;
  failed: number;
  pending: number; // queued or running
  oldestPendingAt: string | null; // ISO
  linkMismatchTotal: number;
};

export const METRICS_FILE = 'immich_picker.prom';

export function renderMetrics(s: MetricsState, now: Date): string {
  const nowS = Math.floor(now.getTime() / 1000);
  const age = s.oldestPendingAt ? Math.max(0, nowS - Math.floor(Date.parse(s.oldestPendingAt) / 1000)) : 0;
  const metric = (name: string, type: string, help: string, value: number) =>
    `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}\n`;
  return [
    metric('immich_picker_guard_ok', 'gauge', '1 when the Immich version and schema are the tested ones, else 0 (read-only).', s.guardOk ? 1 : 0),
    metric('immich_picker_moves_failed', 'gauge', 'Jobs (moves and give backs) that failed and wait for a Retry.', s.failed),
    metric('immich_picker_moves_pending', 'gauge', 'Jobs (moves and give backs) queued or running.', s.pending),
    metric('immich_picker_oldest_pending_age_seconds', 'gauge', 'Age of the oldest queued or running job (0 when none).', age),
    metric('immich_picker_link_mismatch_total', 'counter', 'Pairs not hard-linked because the files differ.', s.linkMismatchTotal),
    metric('immich_picker_last_write_timestamp_seconds', 'gauge', 'When this file was written (Unix time).', nowS),
  ].join('');
}

export async function writeMetrics(dir: string, text: string): Promise<void> {
  // Dot-prefixed temp name: node_exporter only reads *.prom.
  const tmp = join(dir, `.${METRICS_FILE}.${process.pid}.tmp`);
  await writeFile(tmp, text, { mode: 0o644 });
  await rename(tmp, join(dir, METRICS_FILE));
}
