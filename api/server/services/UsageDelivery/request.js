const { randomUUID } = require('node:crypto');
const db = require('~/models');
// In-process shared usage arrays belong to the original paid request, including abort callbacks.
const usageRequests = new WeakMap();
const bindUsageRequest = (usage, req) => {
  if (enabled() && Array.isArray(usage)) usageRequests.set(usage, req);
};
const getUsageRequest = (usage) => usageRequests.get(usage);
function enabled() {
  return Boolean(process.env.USAGE_DELIVERY_MODE && process.env.USAGE_DELIVERY_MODE !== 'off');
}
function usageRequestScope(req, res, next) {
  if (!enabled()) return next();
  return db.withUsageRequest({ userId: req.user?.id, tenantId: req.user?.tenantId }, (scope) => {
    req.usageScope = scope;
    return next();
  });
}
function withRequestScope(req, work) {
  if (!enabled() || !req) return work();
  if (req?.usageScope) return db.withUsageScope(req.usageScope, work);
  return db.withUsageRequest({ userId: req?.user?.id, tenantId: req?.user?.tenantId }, (scope) => {
    if (req) req.usageScope = scope;
    return work();
  });
}
async function admitModelRun({ req, key = randomUUID(), models, maxCalls = 1, source = 'chat' }) {
  if (!enabled()) return undefined;
  await withRequestScope(req, () => db.admitUsageRun({ key, models, maxCalls, source }));
  return (identity) => withRequestScope(req, () => db.beginUsageModelCall({ key, ...identity }));
}
const recordUsageForRequest = (req, input) =>
  withRequestScope(req, () => db.recordUsageEvent(input));
const finishUsageRun = (req, key) =>
  enabled() ? withRequestScope(req, () => db.finishUsageRun(key)) : Promise.resolve();
module.exports = {
  bindUsageRequest,
  getUsageRequest,
  usageRequestScope,
  withRequestScope,
  admitModelRun,
  recordUsageForRequest,
  finishUsageRun,
};
