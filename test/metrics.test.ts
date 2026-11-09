import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { METRICS_FILE, renderMetrics, writeMetrics } from '../src/metrics.ts';

const now = new Date('2026-11-09T12:00:00Z');
const values = (text: string) =>
  Object.fromEntries(text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' ') as [string, string]));

test('renders every metric with HELP/TYPE; age from the oldest pending move', () => {
  const text = renderMetrics(
    { guardOk: true, failed: 2, pending: 3, oldestPendingAt: '2026-11-09T11:59:00.000Z', linkMismatchTotal: 1 },
    now,
  );
  assert.deepEqual(values(text), {
    immich_picker_guard_ok: '1',
    immich_picker_moves_failed: '2',
    immich_picker_moves_pending: '3',
    immich_picker_oldest_pending_age_seconds: '60',
    immich_picker_link_mismatch_total: '1',
    immich_picker_last_write_timestamp_seconds: String(now.getTime() / 1000),
  });
  assert.match(text, /# TYPE immich_picker_link_mismatch_total counter/);
  assert.ok(text.endsWith('\n'));
});

test('nothing pending → age 0; guard failed → 0', () => {
  const v = values(renderMetrics({ guardOk: false, failed: 0, pending: 0, oldestPendingAt: null, linkMismatchTotal: 0 }, now));
  assert.equal(v.immich_picker_oldest_pending_age_seconds, '0');
  assert.equal(v.immich_picker_guard_ok, '0');
});

test('writes atomically: only the .prom file remains', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'picker-metrics-'));
  try {
    await writeMetrics(dir, 'a 1\n');
    await writeMetrics(dir, 'a 2\n');
    assert.deepEqual(readdirSync(dir), [METRICS_FILE]);
    assert.equal(readFileSync(join(dir, METRICS_FILE), 'utf8'), 'a 2\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
