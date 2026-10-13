import { Counter, Gauge } from 'prom-client';
import type { Registry } from 'prom-client';
import type { UsageStats } from '@librechat/data-schemas';
const reasons = new Set([
  'invalid',
  'oversize',
  'full',
  'unavailable',
  'conflict',
  'journal',
  'expired',
  'pricing',
  'identity',
  'legacy',
  'reconcile',
]);
let publish: ((stats: UsageStats) => void) | undefined;
let record: ((event: string, reason?: string) => void) | undefined;
export function publishUsageDeliveryStats(stats: UsageStats): void {
  try {
    publish?.(stats);
  } catch {
    /* Telemetry never changes a paid result. */
  }
}
export function recordUsageDeliveryEvent(event: string, reason?: string): void {
  try {
    record?.(event, reason);
  } catch {
    /* fixed best-effort metric */
  }
}
export function initializeUsageMetrics(
  registry?: Registry,
  enabled = Boolean(process.env.USAGE_DELIVERY_MODE && process.env.USAGE_DELIVERY_MODE !== 'off'),
): void {
  publish = undefined;
  record = undefined;
  if (!registry || !enabled) return;
  const gauge = (suffix: string, help: string) =>
    new Gauge({ name: `librechat_usage_delivery_${suffix}`, help, registers: [registry] });
  const pending = gauge('pending', 'Unacknowledged private usage envelopes');
  const bytes = gauge('pending_bytes', 'Logical bytes of unacknowledged private usage envelopes');
  const oldest = gauge('oldest_seconds', 'Age of oldest unacknowledged private usage envelope');
  const quarantined = gauge('quarantined', 'Usage envelopes requiring manual review');
  const writable = gauge('writable', 'Private usage journal is accepting paid admission');
  const failures = new Counter({
    name: 'librechat_usage_delivery_failures_total',
    help: 'Usage delivery failures by bounded reason',
    labelNames: ['reason'],
    registers: [registry],
  });
  const recovered = new Counter({
    name: 'librechat_usage_delivery_recovered_total',
    help: 'Usage journal records acknowledged after ledger persistence',
    registers: [registry],
  });
  const safeNumber = (value: number) => (Number.isFinite(value) && value >= 0 ? value : 0);
  publish = (stats) => {
    pending.set(safeNumber(stats.pendingCount));
    bytes.set(safeNumber(stats.pendingBytes));
    oldest.set(safeNumber(stats.oldestPendingSeconds));
    quarantined.set(safeNumber(stats.quarantinedCount));
    writable.set(stats.writable === true ? 1 : 0);
  };
  record = (event, reason) => {
    if (event === 'recovered') recovered.inc();
    else if (event === 'failure' || event === 'quarantined')
      failures.inc({ reason: reason && reasons.has(reason) ? reason : 'other' });
  };
}
