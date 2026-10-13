const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openUsageJournal } = require('./journal');
const { createUsageDeliveryService } = require('./service');
const { createChatCapture } = require('./chatCapture');
let directory, service, capture;
const userId = '507f1f77bcf86cd799439011';
const input = {
  usageEventId: 'chat:conversation:message:message:0',
  userId,
  conversationId: 'conversation',
  messageId: 'message',
  provider: 'fixture',
  model: 'model',
  businessType: 'chat',
  status: 'succeeded',
  inputTokens: 10,
  outputTokens: 5,
};
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'o03-chat-'));
  const journal = await openUsageJournal({ directory, maxPendingBytes: 131072 });
  service = createUsageDeliveryService({
    journal,
    persist: async () => ({ persisted: true, revision: 3 }),
    resolvePricing: async () => ({ kind: 'confirmed_cost', costCny: 0.5 }),
    resolveSubject: async () => 'original-subject',
  });
  capture = createChatCapture({
    isEnabled: () => true,
    getService: () => service,
    legacyRecord: () => {
      throw new Error('raw write forbidden');
    },
  });
});
afterEach(async () => {
  await service.drain();
  await fs.rm(directory, { recursive: true, force: true });
});
test('a multi-call run reserves all slots before providers start and captures offline with frozen prices', async () => {
  await capture.withRequest({ userId, requestId: 'request' }, async () => {
    await capture.admitRun({
      key: 'message',
      models: [{ provider: 'fixture', model: 'model' }],
      maxCalls: 2,
    });
    service.resolvePricing = async () => {
      throw new Error('DB offline');
    };
    const result = await capture.record(input);
    expect(result).toMatchObject({
      durableAccepted: true,
      ledgerPersisted: false,
      envelope: { pricing: { costCny: 0.5 }, reportingSubjectId: 'original-subject' },
    });
    expect(await capture.record(input)).toMatchObject({ durableAccepted: true });
    expect((await service.stats()).pendingCount).toBe(1);
  });
});
test('a second run cannot call its provider when capacity has been reserved', async () => {
  let calls = 0;
  await capture.withRequest({ userId, requestId: 'first' }, async () => {
    await capture.admitRun({
      key: 'first',
      models: [{ provider: 'fixture', model: 'model' }],
      maxCalls: 2,
    });
    calls++;
  });
  await expect(
    capture.withRequest({ userId, requestId: 'second' }, async () => {
      await capture.admitRun({
        key: 'second',
        models: [{ provider: 'fixture', model: 'model' }],
        maxCalls: 1,
      });
      calls++;
    }),
  ).rejects.toMatchObject({ code: 'USAGE_CAPTURE_UNAVAILABLE' });
  expect(calls).toBe(1);
});
test('a deleting account cannot obtain a new paid admission or replacement reporting identity', async () => {
  service.resolveSubject = async () => {
    throw new Error('deleting');
  };
  await expect(
    capture.withRequest({ userId, requestId: 'deleted' }, () =>
      capture.admitRun({
        key: 'deleted',
        models: [{ provider: 'fixture', model: 'model' }],
        maxCalls: 1,
      }),
    ),
  ).rejects.toMatchObject({ code: 'USAGE_CAPTURE_UNAVAILABLE' });
  expect((await service.stats()).reservedBytes).toBe(0);
});
test('stream cancellation and final success retain one event identity with increasing revisions', async () => {
  await capture.withRequest({ userId, requestId: 'request' }, async () => {
    await capture.admitRun({
      key: 'message',
      models: [{ provider: 'fixture', model: 'model' }],
      maxCalls: 1,
    });
    const cancelled = await capture.record({ ...input, status: 'cancelled' });
    const final = await capture.record(input);
    expect(final.eventId).toBe(cancelled.eventId);
    expect(final.revision).toBeGreaterThan(cancelled.revision);
  });
});

test('concurrent admission for one run freezes one identity and shared call budget', async () => {
  const resolve = jest.spyOn(service, 'resolveSubject');
  await capture.withRequest({ userId, requestId: 'parallel' }, async () => {
    const args = { key: 'message', models: [{ provider: 'fixture', model: 'model' }], maxCalls: 1 };
    const groups = await Promise.all([capture.admitRun(args), capture.admitRun(args)]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(groups[0]).toBe(groups[1]);
    let paidCalls = 0;
    const results = await Promise.allSettled(
      [1, 2].map(async () => {
        await capture.beginModelCall({ key: 'message', provider: 'fixture', model: 'model' });
        paidCalls++;
      }),
    );
    expect(paidCalls).toBe(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});
test('title and memory with the same model consume their own reservation', async () => {
  await capture.withRequest({ userId, requestId: 'separate' }, async () => {
    const models = [{ provider: 'fixture', model: 'model', businessType: 'other' }];
    await capture.admitRun({ key: 'message:title', models });
    await capture.admitRun({ key: 'message:memory', models });
    await capture.finishRun('message:title');
    expect(
      await capture.record({
        ...input,
        usageEventId: 'other:conversation:message:memory:0',
        businessType: 'other',
        metadata: { usageContext: 'memory' },
      }),
    ).toMatchObject({ durableAccepted: true });
  });
});
test('deleting an account between agent steps prevents another paid model call', async () => {
  await capture.withRequest({ userId, requestId: 'delete-between' }, async () => {
    await capture.admitRun({
      key: 'message',
      models: [{ provider: 'fixture', model: 'model' }],
      maxCalls: 2,
    });
    await capture.beginModelCall({ key: 'message', provider: 'fixture', model: 'model' });
    service.resolveSubject = async () => {
      throw new Error('deleting');
    };
    await expect(
      capture.beginModelCall({ key: 'message', provider: 'fixture', model: 'model' }),
    ).rejects.toMatchObject({ code: 'USAGE_CAPTURE_UNAVAILABLE' });
  });
});
