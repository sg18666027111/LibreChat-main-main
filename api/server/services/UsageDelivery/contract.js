const { createHash } = require('node:crypto');

const MAX_EVENT_BYTES = 32 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SOURCES = new Set(['image', 'batch', 'chat', 'assistant', 'transaction']);
const STATUSES = new Set(['submitted', 'succeeded', 'failed', 'cancelled', 'status_unknown']);
const BUSINESSES = new Set([
  'chat',
  'vision_analysis',
  'image_generation',
  'multi_reference_generation',
  'product_replacement',
  'white_background',
  'batch_image_generation',
  'canvas_generation',
  'main_image_generation',
  'detail_page_generation',
  'other',
]);
const TOP = new Set([
  'schemaVersion',
  'source',
  'sourceKey',
  'revision',
  'event',
  'occurredAt',
  'expiresAt',
  'reportingSubjectId',
  'pricing',
]);
const IDS = [
  'usageEventId',
  'tenantId',
  'userId',
  'provider',
  'model',
  'modelKey',
  'requestId',
  'conversationId',
  'messageId',
  'actionRunId',
  'batchId',
  'itemId',
];
const COUNTS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cachedOutputTokens',
  'imageCount',
  'requestCount',
];
const EVENT = new Set([...IDS, ...COUNTS, 'status', 'businessType', 'tokenValue', 'metadata']);
const META_STRINGS = new Set([
  'taskType',
  'subMode',
  'providerTaskId',
  'usageContext',
  'usageType',
  'tokenType',
  'context',
]);
const PRICE_NUMBERS = [
  'inputPriceCnyPer1K',
  'outputPriceCnyPer1K',
  'imagePriceCny',
  'requestPriceCny',
  'tokenCreditToCny',
];

function plain(value) {
  if (value == null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  return Object.getPrototypeOf(prototype) === null && constructor?.value?.name === 'Object';
}

function keysAllowed(value, allowed) {
  return plain(value) && Object.keys(value).every((key) => allowed.has(key));
}
function id(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some(
      (char) => /\s/.test(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) &&
    !value.includes('://') &&
    !/[?&#]/.test(value)
  );
}
function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function amount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function iso(value) {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

// Reject accessors/prototypes/cycles before serialization; never invoke user-supplied toJSON.
function copyPlain(value, seen = new Set(), depth = 0) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value;
  }
  if (!plain(value) || seen.has(value) || depth > 4) {
    throw new Error('Invalid usage shape');
  }
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new Error('Invalid usage key');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('Invalid usage property');
    }
    result[key] = copyPlain(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

function validPricing(pricing) {
  if (!plain(pricing)) return false;
  if (pricing.kind === 'missing') return Object.keys(pricing).length === 1;
  if (pricing.kind === 'confirmed_cost') {
    return keysAllowed(pricing, new Set(['kind', 'costCny'])) && amount(pricing.costCny);
  }
  if (pricing.kind !== 'snapshot' || !keysAllowed(pricing, new Set(['kind', 'snapshot'])))
    return false;
  const snapshot = pricing.snapshot;
  return (
    keysAllowed(
      snapshot,
      new Set([...PRICE_NUMBERS, 'provider', 'model', 'businessType', 'currency']),
    ) &&
    snapshot.currency === 'CNY' &&
    ['provider', 'model'].every((key) => snapshot[key] === undefined || id(snapshot[key])) &&
    (snapshot.businessType === undefined || BUSINESSES.has(snapshot.businessType)) &&
    PRICE_NUMBERS.every((key) => snapshot[key] === undefined || amount(snapshot[key])) &&
    PRICE_NUMBERS.some((key) => snapshot[key] !== undefined)
  );
}

/** Validate the serialized, private-only delivery boundary. Never return input in errors. */
function validateEnvelope(value) {
  const invalid = { ok: false, reason: 'invalid' };
  try {
    const envelope = copyPlain(value);
    const json = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > MAX_EVENT_BYTES) return { ok: false, reason: 'oversize' };
    if (
      !keysAllowed(envelope, TOP) ||
      envelope.schemaVersion !== 1 ||
      !SOURCES.has(envelope.source) ||
      !id(envelope.sourceKey) ||
      !count(envelope.revision) ||
      !id(envelope.reportingSubjectId) ||
      !iso(envelope.occurredAt) ||
      !iso(envelope.expiresAt)
    )
      return invalid;
    const duration = Date.parse(envelope.expiresAt) - Date.parse(envelope.occurredAt);
    if (duration <= 0 || duration > RETENTION_MS || !validPricing(envelope.pricing)) return invalid;
    const event = envelope.event;
    if (
      !keysAllowed(event, EVENT) ||
      !STATUSES.has(event.status) ||
      !BUSINESSES.has(event.businessType) ||
      !['usageEventId', 'provider', 'model'].every((key) => id(event[key])) ||
      !IDS.every(
        (key) =>
          event[key] === undefined || (key === 'userId' && event[key] === null) || id(event[key]),
      ) ||
      !COUNTS.every((key) => event[key] === undefined || count(event[key])) ||
      (event.tokenValue !== undefined && !amount(event.tokenValue))
    )
      return invalid;
    if (event.userId != null && !/^[a-fA-F0-9]{24}$/.test(event.userId)) return invalid;
    if (event.metadata !== undefined) {
      if (!plain(event.metadata)) return invalid;
      for (const [key, item] of Object.entries(event.metadata)) {
        if (META_STRINGS.has(key)) {
          if (!id(item)) return invalid;
        } else if (['billingConfirmed', 'auditOnly'].includes(key)) {
          if (typeof item !== 'boolean') return invalid;
        } else if (key === 'submitOutcome') {
          if (!['accepted', 'rejected', 'unknown'].includes(item)) return invalid;
        } else if (['providerCost', 'providerCreditsCost'].includes(key)) {
          if (!amount(item)) return invalid;
        } else if (['durationMs', 'inputOnlyTokens'].includes(key)) {
          if (!count(item)) return invalid;
        } else {
          return invalid;
        }
      }
    }
    return { ok: true, envelope, bytes, digest: createHash('sha256').update(json).digest('hex') };
  } catch {
    return invalid;
  }
}
module.exports = { validateEnvelope, MAX_EVENT_BYTES, RETENTION_MS };
