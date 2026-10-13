const { validateEnvelope } = require('./contract');

function resolveImageBusinessType({ businessType, taskType, subMode } = {}) {
  if (businessType) {
    return businessType;
  }
  if (taskType === 'text-to-image') {
    return 'image_generation';
  }
  if (taskType === 'single-image-edit') {
    return 'product_replacement';
  }
  if (taskType === 'multi-reference') {
    return subMode === 'dual-product-replace'
      ? 'product_replacement'
      : 'multi_reference_generation';
  }
  if (taskType === 'white-background') {
    return 'white_background';
  }
  if (taskType === 'batch-packaging') {
    return 'batch_image_generation';
  }
  if (taskType === 'canvas-action-run') {
    return 'canvas_generation';
  }
  if (taskType === 'main-image') {
    return 'main_image_generation';
  }
  if (taskType === 'detail-page') {
    return 'detail_page_generation';
  }
  return 'image_generation';
}

function imageUsageEvent(input) {
  const {
    req,
    userId,
    requestId,
    provider,
    model,
    modelKey,
    taskType,
    subMode,
    businessType,
    status,
    imageCount = 0,
    providerTaskId,
    batchId,
    itemId,
    durationMs,
    costCny,
    billingConfirmed,
    metadata = {},
  } = input;
  const resolved = resolveImageBusinessType({ businessType, taskType, subMode });
  return {
    usageEventId: `${resolved}:${requestId}:${itemId || 'single'}`,
    userId: userId || req?.user?.id,
    tenantId: input.tenantId || req?.user?.tenantId,
    businessType: resolved,
    provider,
    model,
    modelKey,
    status,
    imageCount,
    requestCount: 1,
    batchId,
    itemId,
    requestId,
    occurredAt: new Date(),
    metadata: {
      taskType,
      subMode,
      providerTaskId,
      durationMs,
      ...metadata,
      ...(billingConfirmed === undefined ? {} : { billingConfirmed }),
    },
    ...(costCny === undefined ? {} : { costCny }),
  };
}
const METADATA = new Set([
  'taskType',
  'subMode',
  'providerTaskId',
  'durationMs',
  'billingConfirmed',
  'auditOnly',
  'submitOutcome',
  'providerCost',
  'providerCreditsCost',
]);
function buildImageUsageEnvelope(input) {
  const context = input.usageContext || input.req?.usageContext;
  if (!context) return null;
  const { occurredAt: _occurredAt, costCny, ...raw } = imageUsageEvent(input);
  if (raw.usageEventId !== context.eventId) return null;
  const event = Object.fromEntries(Object.entries(raw).filter(([, value]) => value != null));
  event.metadata = Object.fromEntries(
    Object.entries(raw.metadata).filter(([key, value]) => METADATA.has(key) && value != null),
  );
  const envelope = {
    schemaVersion: 1,
    source: context.source,
    sourceKey: context.sourceKey,
    revision: input.revision ?? (input.status === 'submitted' ? 0 : 1),
    occurredAt: context.occurredAt,
    expiresAt: context.expiresAt,
    reportingSubjectId: context.reportingSubjectId,
    pricing: costCny === undefined ? context.pricing : { kind: 'confirmed_cost', costCny },
    event,
  };
  const checked = validateEnvelope(envelope);
  return checked.ok ? checked.envelope : null;
}
module.exports = { resolveImageBusinessType, imageUsageEvent, buildImageUsageEnvelope };
