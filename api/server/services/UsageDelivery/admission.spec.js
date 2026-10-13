const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openUsageJournal } = require('./journal');
const { createUsageDeliveryService } = require('./service');
const { createUsageAdmission } = require('./admission');
const { buildImageUsageEnvelope } = require('./imageUsage');
let directory, service, admission;
const event = {
  usageEventId: 'image_generation:request:single',
  userId: '507f1f77bcf86cd799439011',
  businessType: 'image_generation',
  provider: 'fixture',
  model: 'fixture-image',
  status: 'submitted',
};
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'o03-admission-'));
  const journal = await openUsageJournal({ directory, maxPendingBytes: 65536 });
  service = createUsageDeliveryService({
    journal,
    persist: async () => ({ persisted: true, revision: 1 }),
    resolveSubject: async () => 'frozen-subject',
    resolvePricing: async () => ({ kind: 'confirmed_cost', costCny: 0.25 }),
  });
  admission = createUsageAdmission({ isEnabled: () => true, getService: () => service });
});
afterEach(async () => {
  await service.drain();
  await fs.rm(directory, { recursive: true, force: true });
});
test('only one provider can begin when two requests compete for one reserved slot', async () => {
  let calls = 0;
  const results = await Promise.allSettled(
    ['a', 'b'].map(async (sourceKey) => {
      const context = await admission.prepareUsageContext({
        source: 'image',
        sourceKey,
        event: { ...event, usageEventId: sourceKey },
        maxEvents: 2,
      });
      calls++;
      return context;
    }),
  );
  expect(calls).toBe(1);
  expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({
    code: 'USAGE_CAPTURE_UNAVAILABLE',
    statusCode: 503,
  });
});
test('prepared image envelope uses original price, timestamp and identity without a DB read', async () => {
  const context = await admission.prepareUsageContext({
    source: 'image',
    sourceKey: 'request',
    event,
    maxEvents: 2,
  });
  service.resolvePricing = async () => {
    throw new Error('now offline');
  };
  const input = {
    userId: event.userId,
    requestId: 'request',
    provider: 'fixture',
    model: 'fixture-image',
    taskType: 'text-to-image',
    status: 'succeeded',
    imageCount: 1,
    usageContext: context,
    revision: 1,
  };
  const envelope = buildImageUsageEnvelope(input);
  expect(envelope).toMatchObject({
    occurredAt: context.occurredAt,
    reportingSubjectId: 'frozen-subject',
    pricing: { kind: 'confirmed_cost', costCny: 0.25 },
    revision: 1,
  });
  expect(envelope.event).not.toHaveProperty('occurredAt');
  expect(await service.capture(envelope, context.reservationId)).toMatchObject({
    durableAccepted: true,
  });
});
test('provider-native billing and unknown-submit audit stay metadata, not invented CNY', async () => {
  const context = await admission.prepareUsageContext({
    source: 'image',
    sourceKey: 'request',
    event,
    maxEvents: 2,
  });
  const envelope = buildImageUsageEnvelope({
    userId: event.userId,
    requestId: 'request',
    provider: 'fixture',
    model: 'fixture-image',
    taskType: 'text-to-image',
    status: 'status_unknown',
    imageCount: 0,
    usageContext: context,
    revision: 1,
    billingConfirmed: false,
    metadata: {
      auditOnly: true,
      submitOutcome: 'unknown',
      providerCost: 3,
      providerCreditsCost: 30,
    },
  });
  expect(envelope.event.metadata).toMatchObject({
    auditOnly: true,
    submitOutcome: 'unknown',
    providerCost: 3,
    providerCreditsCost: 30,
  });
  expect(envelope.pricing).toEqual(context.pricing);
});
test('off mode does not reserve storage or block legacy calls', async () => {
  const off = createUsageAdmission({
    isEnabled: () => false,
    getService: () => {
      throw new Error('must not access');
    },
  });
  expect(
    await off.prepareUsageContext({ source: 'image', sourceKey: 'request', event, maxEvents: 2 }),
  ).toBeNull();
});

test('time advancing while admitting cannot produce an invalid retention window', async () => {
  let time = Date.now();
  const advancing = createUsageAdmission({
    isEnabled: () => true,
    getService: () => service,
    now: () => time++,
  });
  const context = await advancing.prepareUsageContext({
    source: 'image',
    sourceKey: 'request',
    event,
    maxEvents: 2,
  });
  expect(
    buildImageUsageEnvelope({
      userId: event.userId,
      requestId: 'request',
      provider: 'fixture',
      model: 'fixture-image',
      status: 'succeeded',
      imageCount: 1,
      usageContext: context,
    }),
  ).not.toBeNull();
});
