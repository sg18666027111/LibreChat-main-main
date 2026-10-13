import skuBatchTaskSchema from '~/schema/skuBatchTask';
import { createSkuBatchTaskMethods } from './skuBatchTask';

function createQuery(result: unknown = null) {
  const query = {
    select: jest.fn(),
    sort: jest.fn(),
    lean: jest.fn(async () => result),
  };
  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  return query;
}

function createMethods(overrides: Record<string, jest.Mock> = {}) {
  const model = {
    create: jest.fn(),
    createCollection: jest.fn(),
    createIndexes: jest.fn(),
    modelName: 'SkuBatchTask',
    find: jest.fn(() => createQuery([])),
    findOne: jest.fn(() => createQuery(null)),
    findOneAndUpdate: jest.fn(() => createQuery(null)),
    ...overrides,
  };
  const mongoose = { models: { SkuBatchTask: model } } as never;
  return { methods: createSkuBatchTaskMethods(mongoose), model };
}

describe('SkuBatchTask persistence', () => {
  test('allows template assets without operator icon file ids', () => {
    expect(skuBatchTaskSchema.path('leftIconFileId').isRequired).toBeFalsy();
    expect(skuBatchTaskSchema.path('rightIconFileId').isRequired).toBeFalsy();
  });

  test('defines unique batch item and TTL indexes', () => {
    const indexes = skuBatchTaskSchema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [{ batchId: 1, itemId: 1 }, expect.objectContaining({ unique: true })],
        [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
      ]),
    );
  });

  test('creates the collection and indexes before the first task insert', async () => {
    const events: string[] = [];
    const { methods, model } = createMethods({
      createCollection: jest.fn(async () => events.push('collection')),
      createIndexes: jest.fn(async () => events.push('indexes')),
      create: jest.fn(async () => events.push('insert')),
    });

    await methods.createSkuBatchTaskItem({
      userId: 'user-1',
      tenantId: 'tenant-1',
      batchId: 'batch-1',
      itemId: 'item-1',
      itemIndex: 0,
      sourceFileId: 'source-1',
      templateKey: 'sku_red_delivery_label_v1',
      text: '第一条',
    } as never);
    await methods.createSkuBatchTaskItem({
      userId: 'user-1',
      tenantId: 'tenant-1',
      batchId: 'batch-1',
      itemId: 'item-2',
      itemIndex: 1,
      sourceFileId: 'source-1',
      templateKey: 'sku_red_delivery_label_v1',
      text: '第二条',
    } as never);

    expect(events).toEqual(['collection', 'indexes', 'insert', 'insert']);
    expect(model.createCollection).toHaveBeenCalledTimes(1);
    expect(model.createIndexes).toHaveBeenCalledTimes(1);
  });

  test('scopes task lookups by user and tenant and keeps item order', async () => {
    const query = createQuery([]);
    const { methods, model } = createMethods({ find: jest.fn(() => query) });

    await methods.getSkuBatchTaskItems({
      batchId: 'batch-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    expect(model.find).toHaveBeenCalledWith({
      batchId: 'batch-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
    expect(query.sort).toHaveBeenCalledWith({ itemIndex: 1, createdAt: 1 });
  });

  test('uses an atomic pending lease filter and updates only leased items', async () => {
    const query = createQuery({ processingWorkerId: 'worker-a' });
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });
    const now = new Date('2026-10-09T10:00:00.000Z');

    await methods.acquireSkuBatchTaskLease({
      batchId: 'batch-1',
      itemId: 'item-1',
      workerId: 'worker-a',
      leaseMs: 30_000,
      now,
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        batchId: 'batch-1',
        itemId: 'item-1',
        status: { $in: ['pending'] },
        $or: [
          { processingLeaseUntil: null },
          { processingLeaseUntil: { $exists: false } },
          { processingLeaseUntil: { $lte: now } },
          { processingWorkerId: 'worker-a' },
        ],
      },
      {
        $set: {
          status: 'running',
          processingWorkerId: 'worker-a',
          processingLeaseUntil: new Date('2026-10-09T10:00:30.000Z'),
        },
        $unset: { expiresAt: 1 },
      },
      { new: true },
    );
  });

  test('requires worker ownership, live lease, and expected status for updates', async () => {
    const query = createQuery(null);
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });
    const now = new Date('2026-10-09T10:00:00.000Z');

    await methods.updateSkuBatchTaskItemWithLease({
      batchId: 'batch-1',
      itemId: 'item-1',
      workerId: 'old-worker',
      statuses: ['running'],
      updates: { status: 'succeeded', outputFileId: 'file-1' },
      now,
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        batchId: 'batch-1',
        itemId: 'item-1',
        status: { $in: ['running'] },
        processingWorkerId: 'old-worker',
        processingLeaseUntil: { $gt: now },
      },
      {
        $set: {
          status: 'succeeded',
          outputFileId: 'file-1',
          processingWorkerId: null,
          processingLeaseUntil: null,
        },
      },
      { new: true },
    );
  });
});
