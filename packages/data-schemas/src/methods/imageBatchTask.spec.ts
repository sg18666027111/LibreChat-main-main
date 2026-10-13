import mongoose from 'mongoose';
import imageBatchTaskSchema from '~/schema/imageBatchTask';
import { createImageBatchTaskMethods } from './imageBatchTask';

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
    modelName: 'ImageBatchTask',
    find: jest.fn(() => createQuery([])),
    findOne: jest.fn(() => createQuery(null)),
    findOneAndUpdate: jest.fn(() => createQuery(null)),
    ...overrides,
  };
  const mongoose = { models: { ImageBatchTask: model } } as never;
  return { methods: createImageBatchTaskMethods(mongoose), model };
}

describe('ImageBatchTask persistence', () => {
  test('retains the durable child identity when casting a persisted batch document', () => {
    const Model = mongoose.model('B02BatchContract', imageBatchTaskSchema);
    const doc = new Model({
      internalJobItemId: 'attempt-2',
      internalTaskId: 'child-1',
      internalJobStatus: 'polling',
      batchId: 'batch-1',
      itemId: 'item-1',
    });
    expect(doc.toObject()).toMatchObject({
      internalJobItemId: 'attempt-2',
      internalTaskId: 'child-1',
      internalJobStatus: 'polling',
    });
    mongoose.deleteModel('B02BatchContract');
  });

  test('defines unique batch item and TTL indexes', () => {
    const indexes = imageBatchTaskSchema.indexes();
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

    await methods.createImageBatchTaskItem({ batchId: 'batch-1', itemId: 'item-1' } as never);
    await methods.createImageBatchTaskItem({ batchId: 'batch-2', itemId: 'item-2' } as never);

    expect(events).toEqual(['collection', 'indexes', 'insert', 'insert']);
    expect(model.createCollection).toHaveBeenCalledTimes(1);
    expect(model.createIndexes).toHaveBeenCalledTimes(1);
  });

  test('uses an atomic expired-or-empty lease filter', async () => {
    const query = createQuery({ processingWorkerId: 'worker-a' });
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });
    const now = new Date('2026-07-10T10:00:00.000Z');

    await methods.acquireImageBatchTaskLease({
      batchId: 'batch-1',
      itemId: 'item-1',
      workerId: 'worker-a',
      leaseMs: 30_000,
      statuses: ['pending'],
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
          processingWorkerId: 'worker-a',
          processingLeaseUntil: new Date('2026-07-10T10:00:30.000Z'),
        },
        $unset: { expiresAt: 1 },
      },
      { new: true },
    );
  });

  test('allows only the first simulated worker to acquire a lease', async () => {
    let leased = false;
    const findOneAndUpdate = jest.fn((_filter) => {
      const result = leased ? null : { processingWorkerId: 'winner' };
      leased = true;
      return createQuery(result);
    });
    const { methods } = createMethods({ findOneAndUpdate });

    const first = await methods.acquireImageBatchTaskLease({
      batchId: 'batch-1',
      itemId: 'item-1',
      workerId: 'worker-a',
      leaseMs: 30_000,
      statuses: ['pending'],
    });
    const second = await methods.acquireImageBatchTaskLease({
      batchId: 'batch-1',
      itemId: 'item-1',
      workerId: 'worker-b',
      leaseMs: 30_000,
      statuses: ['pending'],
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test('requires worker ownership, a live lease, and expected status for updates', async () => {
    const query = createQuery(null);
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });
    const now = new Date('2026-07-10T10:00:00.000Z');

    const result = await methods.updateImageBatchTaskItemWithLease({
      batchId: 'batch-1',
      itemId: 'item-1',
      workerId: 'old-worker',
      statuses: ['processing_result'],
      updates: { status: 'failed', errorKind: 'normalization_failed' },
      now,
    });

    expect(result).toBeNull();
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        batchId: 'batch-1',
        itemId: 'item-1',
        status: { $in: ['processing_result'] },
        processingWorkerId: 'old-worker',
        processingLeaseUntil: { $gt: now },
      },
      { $set: { status: 'failed', errorKind: 'normalization_failed' } },
      { new: true },
    );
  });

  test('rejects a late worker result after its lease has expired', async () => {
    const query = createQuery(null);
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });
    const now = new Date('2026-07-10T10:00:00.000Z');

    const result = await methods.updateImageBatchTaskItemWithLease({
      batchId: 'batch-1',
      itemId: 'item-1',
      workerId: 'expired-worker',
      statuses: ['processing_result'],
      updates: { status: 'succeeded' },
      now,
    });

    expect(result).toBeNull();
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: { $in: ['processing_result'] },
        processingWorkerId: 'expired-worker',
        processingLeaseUntil: { $gt: now },
      }),
      expect.any(Object),
      { new: true },
    );
  });

  test('selects providerResult only for explicit internal reads', async () => {
    const safeQuery = createQuery(null);
    const internalQuery = createQuery(null);
    const findOne = jest.fn().mockReturnValueOnce(safeQuery).mockReturnValueOnce(internalQuery);
    const { methods } = createMethods({ findOne });

    await methods.getImageBatchTaskItem({ batchId: 'batch-1', itemId: 'item-1' });
    await methods.getImageBatchTaskItem({
      batchId: 'batch-1',
      itemId: 'item-1',
      includeSensitive: true,
    });

    expect(safeQuery.select).not.toHaveBeenCalled();
    expect(internalQuery.select).toHaveBeenCalledWith(
      '+providerResult +usageContext +usageDelivery',
    );
  });
  test.each([
    { expectedRetryCount: 0, expectedInternalJobItemId: null, countFilter: { $in: [0, null] } },
    { expectedRetryCount: 2, expectedInternalJobItemId: 'attempt-2', countFilter: 2 },
  ])(
    'retry CAS binds the observed generation: %j',
    async ({ expectedRetryCount, expectedInternalJobItemId, countFilter }) => {
      const findOneAndUpdate = jest.fn((_filter: unknown) => createQuery());
      const { methods } = createMethods({ findOneAndUpdate });
      await methods.updateImageBatchTaskItem({
        batchId: 'batch',
        itemId: 'item',
        statuses: ['failed'],
        expectedRetryCount,
        expectedInternalJobItemId,
        updates: { status: 'pending', retryCount: expectedRetryCount + 1 },
      } as never);
      expect(findOneAndUpdate.mock.calls[0][0]).toMatchObject({
        retryCount: countFilter,
        internalJobItemId: expectedInternalJobItemId,
      });
    },
  );
});
