const { publishUsageDeliveryStats, recordUsageDeliveryEvent } = require('@librechat/api');
function sampleUsageMetrics(stats) {
  publishUsageDeliveryStats?.(stats);
}
function recordUsageEvent(event, reason) {
  recordUsageDeliveryEvent?.(event, reason);
}
module.exports = { sampleUsageMetrics, recordUsageEvent };
