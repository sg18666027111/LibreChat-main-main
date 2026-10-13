import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { createTransactionMethods } from './transaction';
import type { UsageEnvelope, RecordAIUsageEventInput, CaptureResult } from '~/types/aiUsage';
import type { TransactionData } from '~/types/transaction';
let server: MongoMemoryServer;
const user = '507f1f77bcf86cd799439011';
function prepare(input: RecordAIUsageEventInput): UsageEnvelope {
  const time = new Date();
  return {
    schemaVersion: 1,
    source: 'transaction',
    sourceKey: input.usageEventId,
    revision: 3,
    occurredAt: time.toISOString(),
    expiresAt: new Date(+time + 86400000).toISOString(),
    reportingSubjectId: 'subject',
    pricing: { kind: 'confirmed_cost', costCny: 0.1 },
    event: {
      usageEventId: input.usageEventId,
      userId: user,
      provider: input.provider,
      model: input.model,
      businessType: input.businessType,
      status: input.status,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
    },
  };
}
beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  await mongoose.connect(server.getUri());
  createModels(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await mongoose.models.Transaction.deleteMany({});
  await mongoose.models.AIUsageEvent.deleteMany({});
});
test('legacy transaction saves its exact recovery envelope even when capture fails', async () => {
  const captureUsage = jest.fn(
    async (): Promise<CaptureResult> => ({
      durableAccepted: false,
      ledgerPersisted: false,
      reason: 'unavailable',
    }),
  );
  const methods = createTransactionMethods(
    mongoose,
    { getMultiplier: () => 1, getCacheMultiplier: () => 1 },
    { isUsageDeliveryEnabled: () => true, prepareUsage: prepare, captureUsage },
  );
  await methods.createTransaction({
    user,
    model: 'fixture',
    tokenType: 'prompt',
    rawAmount: -10,
    balance: { enabled: false },
  });
  const transaction = await mongoose.models.Transaction.findOne({})
    .select('+usageDelivery')
    .lean<TransactionData>();
  if (!transaction?.usageDelivery?.envelope)
    throw new Error('Expected persisted transaction delivery evidence');
  expect(transaction.usageDelivery).toMatchObject({
    state: 'pending',
    envelope: { event: { inputTokens: 10 } },
  });
  expect(captureUsage).toHaveBeenCalledWith(transaction.usageDelivery.envelope);
  expect(await mongoose.models.AIUsageEvent.countDocuments()).toBe(0);
});
test('an explicitly linked chat transaction retains the source without a second mirror submission', async () => {
  const captureUsage = jest.fn();
  const methods = createTransactionMethods(
    mongoose,
    { getMultiplier: () => 1, getCacheMultiplier: () => 1 },
    { isUsageDeliveryEnabled: () => true, prepareUsage: prepare, captureUsage },
  );
  const envelope = prepare({
    usageEventId: 'chat:canonical',
    businessType: 'chat',
    provider: 'fixture',
    model: 'fixture',
    status: 'succeeded',
    inputTokens: 10,
  });
  await methods.createTransaction({
    user,
    model: 'fixture',
    tokenType: 'prompt',
    rawAmount: -10,
    skipUsageLedger: true,
    usageEventId: 'chat:canonical',
    usageDelivery: { revision: 3, state: 'pending', envelope },
    balance: { enabled: false },
  });
  const transaction = await mongoose.models.Transaction.findOne({})
    .select('+usageDelivery')
    .lean<TransactionData>();
  if (!transaction?.usageDelivery?.envelope)
    throw new Error('Expected persisted transaction delivery evidence');
  expect(transaction.usageEventId).toBe('chat:canonical');
  expect(transaction.usageDelivery.envelope.event.usageEventId).toBe('chat:canonical');
  expect(captureUsage).not.toHaveBeenCalled();
});

test('a failed transaction save still attempts durable capture without a balance update', async () => {
  const captureUsage = jest.fn(
    async (envelope: UsageEnvelope): Promise<CaptureResult> => ({
      durableAccepted: true,
      ledgerPersisted: false,
      eventId: envelope.event.usageEventId,
      revision: envelope.revision,
    }),
  );
  const methods = createTransactionMethods(
    mongoose,
    { getMultiplier: () => 1, getCacheMultiplier: () => 1 },
    { isUsageDeliveryEnabled: () => true, prepareUsage: prepare, captureUsage },
  );
  const save = jest
    .spyOn(mongoose.models.Transaction.prototype, 'save')
    .mockRejectedValueOnce(new Error('synthetic DB outage'));
  const balance = jest.spyOn(mongoose.models.Balance, 'findOneAndUpdate');
  try {
    await expect(
      methods.createTransaction({
        user,
        model: 'fixture',
        tokenType: 'prompt',
        rawAmount: -10,
        balance: { enabled: true },
      }),
    ).rejects.toThrow('synthetic DB outage');
    expect(captureUsage).toHaveBeenCalledTimes(1);
    expect(captureUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'transaction',
        event: expect.objectContaining({ inputTokens: 10 }),
      }),
    );
    expect(balance).not.toHaveBeenCalled();
  } finally {
    save.mockRestore();
    balance.mockRestore();
  }
});
