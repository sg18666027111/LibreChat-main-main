const mongoose = require('mongoose');
const { createUsageSourceStore } = require('~/server/services/UsageDelivery/sourceStore');
const {
  sampleUsageMetrics,
  recordUsageEvent: recordUsageDeliveryEvent,
} = require('~/server/services/UsageDelivery/metrics');
const { createMethods } = require('@librechat/data-schemas');
const { matchModelName, findMatchingPattern } = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');
const { createChatCapture } = require('~/server/services/UsageDelivery/chatCapture');
const { createUsageDeliveryRuntime } = require('~/server/services/UsageDelivery/runtime');

const methods = createMethods(mongoose, {
  matchModelName,
  findMatchingPattern,
  getCache: getLogStores,
  isUsageDeliveryEnabled: () => usageDelivery.enabled(),
  prepareUsage: (input) => chatCapture.prepare(input),
  captureUsage: (envelope) => chatCapture.captureEnvelope(envelope),
});

const usageDelivery = createUsageDeliveryRuntime({
  persist: methods.persistUsageEnvelope,
  sealExpired: methods.sealExpiredUsageIdentity,
  createSourceStore: () => createUsageSourceStore(mongoose.connection.db),
  onStats: sampleUsageMetrics,
  onEvent: recordUsageDeliveryEvent,
  resolvePricing: methods.resolveUsagePricing,
  resolveSubject: async (userId) => {
    const user = await mongoose.models.User.findById(userId)
      .select('reportingSubjectId approvalStatus')
      .lean();
    if (!user?.reportingSubjectId || user.approvalStatus === 'deleting') {
      throw Object.assign(new Error('Usage identity unavailable'), {
        code: 'USAGE_IDENTITY_UNAVAILABLE',
      });
    }
    return user.reportingSubjectId;
  },
});

const chatCapture = createChatCapture({
  isEnabled: usageDelivery.enabled,
  getService: usageDelivery.get,
  legacyRecord: methods.recordAIUsageEvent,
  onFailure: (reason) => recordUsageDeliveryEvent('failure', reason),
});

const seedDatabase = async () => {
  await methods.initializeRoles();
  await methods.seedDefaultRoles();
  await methods.ensureDefaultCategories();
  await methods.seedSystemGrants();
};

module.exports = {
  ...methods,
  seedDatabase,
  initializeUsageDelivery: usageDelivery.initialize,
  isUsageDeliveryEnabled: usageDelivery.enabled,
  getUsageDeliveryService: usageDelivery.get,
  captureUsageEnvelope: usageDelivery.capture,
  withUsageRequest: chatCapture.withRequest,
  withUsageScope: chatCapture.withScope,
  admitUsageRun: chatCapture.admitRun,
  beginUsageModelCall: chatCapture.beginModelCall,
  finishUsageRun: chatCapture.finishRun,
  recordUsageEvent: chatCapture.record,
  prepareUsageEnvelope: chatCapture.prepare,
  anonymizeUsageForDeletedUser: (params) =>
    usageDelivery.withDeletedSubject(params.reportingSubjectId, () =>
      methods.anonymizeUsageForDeletedUser(params),
    ),
};
