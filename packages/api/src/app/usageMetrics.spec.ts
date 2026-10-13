import { Registry } from 'prom-client';
import {
  initializeUsageMetrics,
  publishUsageDeliveryStats,
  recordUsageDeliveryEvent,
} from './usageMetrics';
test('publishes fixed usage delivery metrics without identity or arbitrary error labels', async () => {
  const registry = new Registry();
  initializeUsageMetrics(registry, true);
  publishUsageDeliveryStats({
    pendingCount: 3,
    pendingBytes: 1024,
    reservedBytes: 512,
    oldestPendingSeconds: 600,
    quarantinedCount: 1,
    writable: false,
  });
  recordUsageDeliveryEvent('failure', 'secret-user/provider-token');
  recordUsageDeliveryEvent('recovered');
  const output = await registry.metrics();
  expect(output).toContain('librechat_usage_delivery_pending 3');
  expect(output).toContain('librechat_usage_delivery_pending_bytes 1024');
  expect(output).toContain('librechat_usage_delivery_oldest_seconds 600');
  expect(output).toContain('librechat_usage_delivery_quarantined 1');
  expect(output).toContain('librechat_usage_delivery_writable 0');
  expect(output).toContain('librechat_usage_delivery_failures_total{reason="other"} 1');
  expect(output).toContain('librechat_usage_delivery_recovered_total 1');
  expect(output).not.toContain('secret-user');
});
test('disabled recovery emits no false unavailability signal', async () => {
  const registry = new Registry();
  initializeUsageMetrics(registry, false);
  publishUsageDeliveryStats({ pendingCount: 1 } as never);
  recordUsageDeliveryEvent('failure', 'invalid');
  expect(await registry.metrics()).not.toContain('usage_delivery');
});
