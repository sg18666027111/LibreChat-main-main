import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { createAIUsageMethods } from './aiUsage';
import type { UsageEnvelope, IAIUsageEvent } from '~/types';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));
let server: MongoMemoryServer;
let methods: ReturnType<typeof createAIUsageMethods>;
const eventId = 'image_generation:delivery-test:single';
const digest = (version: number) => String(version).padStart(64, '0');
function envelope(revision = 1, imageCount = 1): UsageEnvelope {
  const occurredAt = new Date(Date.now() - 60000);
  return {
    schemaVersion: 1,
    source: 'image',
    sourceKey: 'delivery-test',
    revision,
    occurredAt: occurredAt.toISOString(),
    expiresAt: new Date(occurredAt.getTime() + 30 * 86400000).toISOString(),
    reportingSubjectId: 'delivery-subject',
    pricing: { kind: 'snapshot', snapshot: { currency: 'CNY', imagePriceCny: 0.25 } },
    event: {
      usageEventId: eventId,
      userId: '507f1f77bcf86cd799439011',
      businessType: 'image_generation',
      provider: 'fixture',
      model: 'fixture-image',
      status: 'succeeded',
      imageCount,
    },
  };
}
beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  await mongoose.connect(server.getUri());
  createModels(mongoose);
  methods = createAIUsageMethods(mongoose);
  await methods.ensureAIUsageStorage();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await mongoose.models.AIUsageEvent.deleteMany({});
  await mongoose.models.AIModelPrice.deleteMany({});
});

test('duplicate delivery inserts exactly one ledger event', async () => {
  const input = envelope();
  const results = await Promise.all(
    Array.from({ length: 3 }, () => methods.persistUsageEnvelope(input, digest(1))),
  );
  expect(results.every((r) => r.persisted)).toBe(true);
  expect(await mongoose.models.AIUsageEvent.countDocuments()).toBe(1);
  expect((await mongoose.models.AIUsageEvent.findOne({ usageEventId: eventId })).costCny).toBe(
    0.25,
  );
});
test('concurrent terminal revisions preserve newest quantities', async () => {
  await Promise.all([
    methods.persistUsageEnvelope(envelope(2, 2), digest(2)),
    methods.persistUsageEnvelope(envelope(1, 1), digest(1)),
  ]);
  const stored = await mongoose.models.AIUsageEvent.findOne({ usageEventId: eventId });
  expect(stored.deliveryRevision).toBe(2);
  expect(stored.imageCount).toBe(2);
});
test('lower status cannot overwrite success even with a higher revision', async () => {
  await methods.persistUsageEnvelope(envelope(), digest(1));
  const submitted = envelope(2, 0);
  submitted.event.status = 'submitted';
  expect(await methods.persistUsageEnvelope(submitted, digest(2))).toMatchObject({
    persisted: true,
    superseded: true,
  });
  expect((await mongoose.models.AIUsageEvent.findOne({ usageEventId: eventId })).status).toBe(
    'succeeded',
  );
});
test('conflicting same revision is not acknowledged as persisted', async () => {
  await methods.persistUsageEnvelope(envelope(), digest(1));
  await expect(methods.persistUsageEnvelope(envelope(1, 4), digest(2))).rejects.toMatchObject({
    code: 'USAGE_REVISION_CONFLICT',
  });
  expect((await mongoose.models.AIUsageEvent.findOne({ usageEventId: eventId })).imageCount).toBe(
    1,
  );
});
test('replay uses frozen price rather than current model configuration', async () => {
  const input = envelope();
  await methods.upsertAIModelPrice({
    provider: 'fixture',
    model: 'fixture-image',
    imagePriceCny: 9,
  });
  await methods.persistUsageEnvelope(input, digest(1));
  const stored = await mongoose.models.AIUsageEvent.findOne({ usageEventId: eventId });
  expect(stored.costCny).toBe(0.25);
  expect(stored.occurredAt.toISOString()).toBe(input.occurredAt);
  expect(stored.expiresAt.toISOString()).toBe(input.expiresAt);
});
test('later revisions preserve the already established pricing snapshot', async () => {
  await methods.persistUsageEnvelope(envelope(), digest(1));
  const newer = envelope(2, 2);
  newer.pricing = { kind: 'snapshot', snapshot: { currency: 'CNY', imagePriceCny: 9 } };
  await methods.persistUsageEnvelope(newer, digest(2));
  const stored = await mongoose.models.AIUsageEvent.findOne({ usageEventId: eventId });
  expect(stored.costCny).toBe(0.5);
  expect(stored.pricingSnapshot.imagePriceCny).toBe(0.25);
});
test('missing pricing stays missing even if configuration now exists', async () => {
  const input = envelope();
  input.pricing = { kind: 'missing' };
  await methods.upsertAIModelPrice({
    provider: 'fixture',
    model: 'fixture-image',
    imagePriceCny: 9,
  });
  await methods.persistUsageEnvelope(input, digest(1));
  const stored = await mongoose.models.AIUsageEvent.findOne({ usageEventId: eventId });
  expect(stored.pricingMissing).toBe(true);
  expect(stored.costCny).toBe(0);
});
test('expired events cannot be recreated with fresh retention', async () => {
  const input = envelope();
  input.occurredAt = '2020-01-01T00:00:00.000Z';
  input.expiresAt = '2020-01-31T00:00:00.000Z';
  await expect(methods.persistUsageEnvelope(input, digest(1))).rejects.toMatchObject({
    code: 'USAGE_EXPIRED',
  });
  expect(await mongoose.models.AIUsageEvent.countDocuments()).toBe(0);
});
test('legacy events require review instead of silent overwrite', async () => {
  const input = envelope();
  await methods.recordAIUsageEvent({
    ...input.event,
    occurredAt: new Date(input.occurredAt),
    reportingSubjectId: input.reportingSubjectId,
  });
  await expect(methods.persistUsageEnvelope(input, digest(1))).rejects.toMatchObject({
    code: 'USAGE_LEGACY_CONFLICT',
  });
});
test('higher revision never reattaches an anonymized identity', async () => {
  await methods.persistUsageEnvelope(envelope(), digest(1));
  await methods.anonymizeUsageForDeletedUser({
    userId: envelope().event.userId,
    reportingSubjectId: 'delivery-subject',
  });
  await methods.persistUsageEnvelope(envelope(2, 2), digest(2));
  const stored = await mongoose.models.AIUsageEvent.findOne({ usageEventId: eventId });
  expect(stored.userId).toBeNull();
  expect(stored.anonymizedAt).toBeTruthy();
  expect(stored.imageCount).toBe(2);
});
test('pricing resolver freezes only whitelisted price evidence', async () => {
  const input = envelope();
  expect(await methods.resolveUsagePricing(input.event)).toEqual({ kind: 'missing' });
  await methods.upsertAIModelPrice({
    provider: 'fixture',
    model: 'fixture-image',
    imagePriceCny: 0.25,
  });
  expect(await methods.resolveUsagePricing(input.event)).toEqual({
    kind: 'snapshot',
    snapshot: { provider: 'fixture', model: 'fixture-image', imagePriceCny: 0.25, currency: 'CNY' },
  });
});

test('expired identity seal survives delayed first insert without creating billable usage', async () => {
  const input = envelope();
  input.occurredAt = new Date(Date.now() - 31 * 86400000).toISOString();
  input.expiresAt = new Date(Date.now() - 86400000).toISOString();
  await methods.sealExpiredUsageIdentity(input);
  const seal = await mongoose.models.AIUsageEvent.findOne({
    usageEventId: input.event.usageEventId,
  }).lean<Partial<IAIUsageEvent>>();
  if (!seal) throw new Error('Expected a persisted identity seal');
  expect(seal.userId).toBeNull();
  expect(seal.deliveryTombstone).toBe(true);
  expect(seal.expiresAt).toBeUndefined();
  expect(seal.occurredAt).toBeUndefined();
  // A stale writer passed validation/read before deletion and now reaches its initial upsert.
  await mongoose.models.AIUsageEvent.findOneAndUpdate(
    { usageEventId: input.event.usageEventId },
    { $setOnInsert: { userId: input.event.userId, imageCount: 1 } },
    { upsert: true },
  );
  expect(
    (await mongoose.models.AIUsageEvent.findOne({ usageEventId: input.event.usageEventId })).userId,
  ).toBeNull();
  expect(await mongoose.models.AIUsageEvent.countDocuments({ occurredAt: { $exists: true } })).toBe(
    0,
  );
});
