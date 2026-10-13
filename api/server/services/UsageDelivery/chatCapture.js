const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { MAX_EVENT_BYTES, RETENTION_MS, validateEnvelope } = require('./contract');
const { admissionError } = require('./admission');
const STATUS_REVISION = { submitted: 0, status_unknown: 1, failed: 2, cancelled: 2, succeeded: 3 };
const FIELDS = [
  'usageEventId',
  'userId',
  'tenantId',
  'businessType',
  'provider',
  'model',
  'modelKey',
  'status',
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cachedOutputTokens',
  'imageCount',
  'requestCount',
  'tokenValue',
  'conversationId',
  'messageId',
  'requestId',
];
const META = ['usageContext', 'usageType', 'inputOnlyTokens', 'tokenType', 'context', 'durationMs'];
function createChatCapture({
  isEnabled,
  getService,
  legacyRecord,
  now = Date.now,
  onFailure = () => {},
}) {
  const storage = new AsyncLocalStorage();
  const withRequest = ({ userId, tenantId, requestId = randomUUID() }, work) => {
    if (!isEnabled()) return work();
    const scope = {
      userId: String(userId),
      tenantId,
      requestId,
      groups: new Map(),
      admissions: new Map(),
    };
    return storage.run(scope, () => work(scope));
  };
  const withScope = (scope, work) => (scope ? storage.run(scope, work) : work());
  async function admitRun({ key, models, maxCalls = 1, source = 'chat' }) {
    if (!isEnabled()) return null;
    const scope = storage.getStore();
    if (
      !scope ||
      !key ||
      !Number.isSafeInteger(maxCalls) ||
      maxCalls < 1 ||
      maxCalls > 512 ||
      !models?.length
    )
      throw admissionError();
    const existing = scope.groups.get(key);
    if (existing) return existing;
    if (scope.admissions.has(key)) return scope.admissions.get(key);
    const pending = initialize();
    scope.admissions.set(key, pending);
    try {
      return await pending;
    } finally {
      scope.admissions.delete(key);
    }
    async function initialize() {
      try {
        const service = getService();
        const startedAt = now();
        const occurredAt = new Date(startedAt).toISOString();
        const expiresAt = new Date(startedAt + RETENTION_MS).toISOString();
        const reportingSubjectId = await service.resolveSubject(scope.userId);
        const prices = new Map();
        for (const { provider, model, businessType = 'chat' } of models) {
          if (!provider || !model) throw admissionError();
          const pricing = await service.resolvePricing({
            provider,
            model,
            businessType,
            occurredAt: new Date(occurredAt),
          });
          prices.set(JSON.stringify([provider, model, businessType]), pricing);
        }
        const reservation = await service.reserve({
          scope: 'request',
          key: `usage:${scope.requestId}:${key}`,
          bytes: maxCalls * 2 * MAX_EVENT_BYTES,
          expiresAt,
        });
        if (reservation.remainingBytes < maxCalls * 2 * MAX_EVENT_BYTES) throw admissionError();
        const group = {
          key,
          source,
          occurredAt,
          expiresAt,
          reportingSubjectId,
          reservationId: reservation.id,
          prices,
          maxCalls,
          startedCalls: 0,
        };
        scope.groups.set(key, group);
        return group;
      } catch {
        throw admissionError();
      }
    }
  }
  async function beginModelCall({ key, provider, model, businessType = 'chat' }) {
    if (!isEnabled()) return;
    const group = storage.getStore()?.groups.get(key);
    if (!group || group.startedCalls >= group.maxCalls) throw admissionError();
    // Count synchronously before awaiting, including concurrent child model calls.
    group.startedCalls++;
    try {
      const service = getService();
      const currentSubject = await service.resolveSubject(storage.getStore().userId);
      if (currentSubject !== group.reportingSubjectId) throw admissionError();
      const priceKey = JSON.stringify([provider, model, businessType]);
      if (!group.prices.has(priceKey))
        group.prices.set(
          priceKey,
          await service.resolvePricing({
            provider,
            model,
            businessType,
            occurredAt: new Date(group.occurredAt),
          }),
        );
      const reservation = await service.reserve({
        scope: 'request',
        key: group.reservationId,
        bytes: MAX_EVENT_BYTES * 2,
        expiresAt: group.expiresAt,
      });
      if (reservation.remainingBytes < MAX_EVENT_BYTES * 2) throw admissionError();
    } catch {
      throw admissionError();
    }
  }
  function findGroup(input) {
    const scope = storage.getStore();
    if (!scope || String(input.userId) !== scope.userId) return {};
    const priceKey = JSON.stringify([input.provider, input.model, input.businessType]);
    const contextKey = input.metadata?.usageContext;
    const byContext =
      contextKey && contextKey !== 'message'
        ? scope.groups.get(`${input.messageId}:${contextKey}`)
        : null;
    const byIdentity =
      byContext || scope.groups.get(input.messageId) || scope.groups.get(input.requestId);
    const group =
      (byIdentity?.prices.has(priceKey) ? byIdentity : null) ||
      [...scope.groups.values()].find((candidate) => candidate.prices.has(priceKey)) ||
      byIdentity ||
      (scope.groups.size === 1 ? [...scope.groups.values()][0] : null);
    return { scope, group };
  }
  function prepare(input) {
    if (!isEnabled()) return null;
    const { scope, group } = findGroup(input);
    if (!group) return null;
    const event = Object.fromEntries(
      FIELDS.filter((key) => input[key] != null).map((key) => [key, input[key]]),
    );
    event.userId = scope.userId;
    if (scope.tenantId) event.tenantId = scope.tenantId;
    if (event.tokenValue != null) event.tokenValue = Math.abs(event.tokenValue);
    event.metadata = Object.fromEntries(
      META.filter((key) => input.metadata?.[key] != null).map((key) => [key, input.metadata[key]]),
    );
    const envelope = {
      schemaVersion: 1,
      source: input.usageEventId.startsWith('transaction:') ? 'transaction' : group.source,
      sourceKey: input.usageEventId,
      revision: STATUS_REVISION[input.status],
      occurredAt: group.occurredAt,
      expiresAt: group.expiresAt,
      reportingSubjectId: group.reportingSubjectId,
      pricing: group.prices.get(
        JSON.stringify([input.provider, input.model, input.businessType]),
      ) || { kind: 'missing' },
      event,
    };
    const checked = validateEnvelope(envelope);
    return checked.ok ? checked.envelope : null;
  }
  async function record(input) {
    if (!isEnabled()) {
      try {
        const row = await legacyRecord(input);
        return row?._id
          ? {
              durableAccepted: true,
              ledgerPersisted: true,
              eventId: input.usageEventId,
              revision: STATUS_REVISION[input.status],
            }
          : { durableAccepted: false, ledgerPersisted: false, reason: 'unavailable' };
      } catch {
        onFailure('unavailable');
        return { durableAccepted: false, ledgerPersisted: false, reason: 'unavailable' };
      }
    }
    const envelope = prepare(input);
    if (!envelope) {
      onFailure('invalid');
      return { durableAccepted: false, ledgerPersisted: false, reason: 'invalid' };
    }
    try {
      const { group } = findGroup(input);
      const result = await getService().capture(envelope, group.reservationId);
      return { ...result, envelope };
    } catch {
      onFailure('unavailable');
      return { durableAccepted: false, ledgerPersisted: false, reason: 'unavailable', envelope };
    }
  }
  async function finishRun(key) {
    const group = storage.getStore()?.groups.get(key);
    if (!group) return;
    try {
      await getService().release(group.reservationId);
    } catch {
      onFailure('unavailable');
    }
  }
  const captureEnvelope = (envelope) =>
    getService().capture(envelope, findGroup(envelope.event).group?.reservationId);
  return {
    withRequest,
    withScope,
    admitRun,
    beginModelCall,
    prepare,
    record,
    finishRun,
    captureEnvelope,
  };
}
module.exports = { createChatCapture };
