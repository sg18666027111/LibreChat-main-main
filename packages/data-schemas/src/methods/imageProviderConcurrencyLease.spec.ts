import imageProviderConcurrencyLeaseSchema from '~/schema/imageProviderConcurrencyLease';
import { createImageProviderConcurrencyLeaseMethods } from './imageProviderConcurrencyLease';

function createQuery(result: unknown = null) {
  const query = {
    lean: jest.fn(async () => result),
  };
  return query;
}

function createMethods(overrides: Record<string, jest.Mock> = {}) {
  const model = {
    createCollection: jest.fn(),
    createIndexes: jest.fn(),
    modelName: 'ImageProviderConcurrencyLease',
    findOneAndUpdate: jest.fn(() => createQuery(null)),
    deleteOne: jest.fn(async () => ({ deletedCount: 0 })),
    deleteMany: jest.fn(async () => ({ deletedCount: 0 })),
    countDocuments: jest.fn(async () => 0),
    ...overrides,
  };
  const mongoose = { models: { ImageProviderConcurrencyLease: model } } as never;
  return { methods: createImageProviderConcurrencyLeaseMethods(mongoose), model };
}

describe('ImageProviderConcurrencyLease persistence', () => {
  test('defines indexes for resource lookup and expiry cleanup', () => {
    const indexes = imageProviderConcurrencyLeaseSchema.indexes();

    expect(indexes).toEqual(
      expect.arrayContaining([
        [{ resourceKey: 1, leaseExpiresAt: 1 }, expect.any(Object)],
        [{ leaseExpiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
      ]),
    );
    expect(imageProviderConcurrencyLeaseSchema.path('providerTaskId')).toBeDefined();
  });

  test('claims the first free provider slot with an atomic expired-or-owner filter', async () => {
    const query = createQuery({
      _id: 'apimart:key:gpt-image-2:slot:0',
      ownerId: 'worker-a',
      internalTaskId: 'task-1',
    });
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });
    const now = new Date('2026-08-04T10:00:00.000Z');

    await methods.acquireImageProviderConcurrencyLease({
      resourceKey: 'apimart:key:gpt-image-2',
      ownerId: 'worker-a',
      internalTaskId: 'task-1',
      maxConcurrency: 1,
      leaseMs: 60_000,
      now,
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: 'apimart:key:gpt-image-2:slot:0',
        $or: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $exists: false } },
          { leaseExpiresAt: { $lte: now } },
          { internalTaskId: 'task-1' },
        ],
      },
      {
        $set: {
          resourceKey: 'apimart:key:gpt-image-2',
          slot: 0,
          ownerId: 'worker-a',
          internalTaskId: 'task-1',
          leaseExpiresAt: new Date('2026-08-04T10:01:00.000Z'),
          heartbeatAt: now,
        },
      },
      { new: true, upsert: true },
    );
  });

  test('returns null when every configured provider slot is already active', async () => {
    const { methods, model } = createMethods({
      findOneAndUpdate: jest.fn(() => createQuery(null)),
    });

    const lease = await methods.acquireImageProviderConcurrencyLease({
      resourceKey: 'apimart:key:gpt-image-2',
      ownerId: 'worker-b',
      internalTaskId: 'task-2',
      maxConcurrency: 2,
      leaseMs: 60_000,
      now: new Date('2026-08-04T10:00:00.000Z'),
    });

    expect(lease).toBeNull();
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  test('refreshes heartbeat only for the matching owner and task', async () => {
    const query = createQuery({ ownerId: 'worker-a', internalTaskId: 'task-1' });
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });
    const now = new Date('2026-08-04T10:00:00.000Z');

    await methods.heartbeatImageProviderConcurrencyLease({
      leaseId: 'apimart:key:gpt-image-2:slot:0',
      ownerId: 'worker-a',
      internalTaskId: 'task-1',
      leaseMs: 60_000,
      now,
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: 'apimart:key:gpt-image-2:slot:0',
        ownerId: 'worker-a',
        internalTaskId: 'task-1',
        leaseExpiresAt: { $gt: now },
      },
      {
        $set: {
          heartbeatAt: now,
          leaseExpiresAt: new Date('2026-08-04T10:01:00.000Z'),
        },
      },
      { new: true },
    );
  });

  test('stores provider task id on claim and heartbeat when available', async () => {
    const claimQuery = createQuery({
      _id: 'apimart:key:gpt-image-2:slot:0',
      ownerId: 'worker-a',
      internalTaskId: 'task-1',
      providerTaskId: 'provider-task-1',
    });
    const heartbeatQuery = createQuery({
      _id: 'apimart:key:gpt-image-2:slot:0',
      ownerId: 'worker-a',
      internalTaskId: 'task-1',
      providerTaskId: 'provider-task-1',
    });
    const findOneAndUpdate = jest
      .fn()
      .mockReturnValueOnce(claimQuery)
      .mockReturnValueOnce(heartbeatQuery);
    const { methods, model } = createMethods({ findOneAndUpdate });
    const now = new Date('2026-08-04T10:00:00.000Z');

    await methods.acquireImageProviderConcurrencyLease({
      resourceKey: 'apimart:key:gpt-image-2',
      ownerId: 'worker-a',
      internalTaskId: 'task-1',
      providerTaskId: 'provider-task-1',
      maxConcurrency: 1,
      leaseMs: 60_000,
      now,
    });
    await methods.heartbeatImageProviderConcurrencyLease({
      leaseId: 'apimart:key:gpt-image-2:slot:0',
      ownerId: 'worker-a',
      internalTaskId: 'task-1',
      providerTaskId: 'provider-task-1',
      leaseMs: 60_000,
      now,
    });

    expect(model.findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({ providerTaskId: 'provider-task-1' }),
      }),
      expect.any(Object),
    );
    expect(model.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({ providerTaskId: 'provider-task-1' }),
      }),
      expect.any(Object),
    );
  });

  test('releases only the matching owner-safe provider lease', async () => {
    const { methods, model } = createMethods({
      deleteOne: jest.fn(async () => ({ deletedCount: 1 })),
    });

    await methods.releaseImageProviderConcurrencyLease({
      leaseId: 'apimart:key:gpt-image-2:slot:0',
      ownerId: 'worker-a',
      internalTaskId: 'task-1',
    });

    expect(model.deleteOne).toHaveBeenCalledWith({
      _id: 'apimart:key:gpt-image-2:slot:0',
      ownerId: 'worker-a',
      internalTaskId: 'task-1',
    });
  });

  test('reports release idempotently and does not let an old owner release a new owner permit', async () => {
    const { methods, model } = createMethods({
      deleteOne: jest
        .fn()
        .mockResolvedValueOnce({ deletedCount: 1 })
        .mockResolvedValueOnce({ deletedCount: 0 }),
    });

    await expect(
      methods.releaseImageProviderConcurrencyLease({
        leaseId: 'apimart:key:gpt-image-2:slot:0',
        ownerId: 'worker-new',
        internalTaskId: 'task-1',
      }),
    ).resolves.toBe(true);
    await expect(
      methods.releaseImageProviderConcurrencyLease({
        leaseId: 'apimart:key:gpt-image-2:slot:0',
        ownerId: 'worker-old',
        internalTaskId: 'task-1',
      }),
    ).resolves.toBe(false);

    expect(model.deleteOne).toHaveBeenLastCalledWith({
      _id: 'apimart:key:gpt-image-2:slot:0',
      ownerId: 'worker-old',
      internalTaskId: 'task-1',
    });
  });

  test('counts only non-expired leases for the resource', async () => {
    const { methods, model } = createMethods({ countDocuments: jest.fn(async () => 1) });
    const now = new Date('2026-08-04T10:00:00.000Z');

    await methods.countActiveImageProviderConcurrencyLeases({
      resourceKey: 'apimart:key:gpt-image-2',
      now,
    });

    expect(model.countDocuments).toHaveBeenCalledWith({
      resourceKey: 'apimart:key:gpt-image-2',
      leaseExpiresAt: { $gt: now },
    });
  });
});
