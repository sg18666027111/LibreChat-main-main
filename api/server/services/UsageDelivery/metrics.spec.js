jest.mock('@librechat/api', () => ({
  publishUsageDeliveryStats: jest.fn(),
  recordUsageDeliveryEvent: jest.fn(),
}));
const { sampleUsageMetrics, recordUsageEvent } = require('./metrics');
const api = require('@librechat/api');
test('journal health and delivery failures reach the application metrics registry', () => {
  const stats = {
    pendingCount: 2,
    pendingBytes: 512,
    oldestPendingSeconds: 301,
    quarantinedCount: 1,
    writable: false,
  };
  sampleUsageMetrics(stats);
  recordUsageEvent('failure', 'full');
  expect(api.publishUsageDeliveryStats).toHaveBeenCalledWith(stats);
  expect(api.recordUsageDeliveryEvent).toHaveBeenCalledWith('failure', 'full');
});
