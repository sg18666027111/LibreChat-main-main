const { logger } = require('@librechat/data-schemas');
const db = require('~/models');

const {
  resolveImageBusinessType,
  imageUsageEvent,
  buildImageUsageEnvelope,
} = require('./UsageDelivery/imageUsage');
const { createUsageAdmission } = require('./UsageDelivery/admission');

const admission = createUsageAdmission({
  isEnabled: () => db.isUsageDeliveryEnabled?.() === true,
  getService: () => db.getUsageDeliveryService(),
});

async function recordAIUsage(input) {
  if (typeof db.recordAIUsageEvent !== 'function') {
    return null;
  }
  try {
    return await db.recordAIUsageEvent(input);
  } catch (error) {
    logger.warn('[UsageLedger] Failed to record AI usage event', {
      usageEventId: input?.usageEventId,
      provider: input?.provider,
      model: input?.model,
      businessType: input?.businessType,
      error: error?.message || String(error),
    });
    return null;
  }
}

async function recordImageUsage(input) {
  const context = input.usageContext || input.req?.usageContext;
  if (db.isUsageDeliveryEnabled?.()) {
    const envelope = input.envelope || buildImageUsageEnvelope(input);
    if (!envelope) return { durableAccepted: false, ledgerPersisted: false, reason: 'invalid' };
    try {
      const result = await db.captureUsageEnvelope(envelope, context?.reservationId);
      if (result.durableAccepted && envelope.event.status !== 'submitted') {
        await admission.releaseUsage(context);
      }
      return result;
    } catch {
      return { durableAccepted: false, ledgerPersisted: false, reason: 'unavailable' };
    }
  }
  const event = imageUsageEvent(input);
  if (!event.userId || !input.requestId || !input.provider || !input.model) return null;
  const record = await recordAIUsage(event);
  return record?._id
    ? {
        durableAccepted: true,
        ledgerPersisted: true,
        eventId: event.usageEventId,
        revision: input.status === 'submitted' ? 0 : 1,
      }
    : { durableAccepted: false, ledgerPersisted: false, reason: 'unavailable' };
}

async function admitImageUsage(input) {
  if (input.usageContext) {
    await admission.checkUsageContext(input.usageContext, 1);
    return input.usageContext;
  }
  const event = imageUsageEvent({ ...input, status: 'submitted', imageCount: 0 });
  return admission.prepareUsageContext({
    source: input.batchId ? 'batch' : 'image',
    sourceKey: event.usageEventId,
    event,
    maxEvents: 2,
    reservationScope: input.reservationScope || 'source',
  });
}

module.exports = {
  recordAIUsage,
  recordImageUsage,
  buildImageUsageEnvelope,
  admitImageUsage,
  releaseImageUsage: admission.releaseUsage,
  resolveImageBusinessType,
};
