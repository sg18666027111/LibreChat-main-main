import imageEgressWorkerSlotSchema from '~/schema/imageEgressWorkerSlot';
import { createImageEgressWorkerSlotMethods } from './imageEgressWorkerSlot';

function createQuery(result: unknown = null) {
  return {
    lean: jest.fn(async () => result),
  };
}

function createMethods(overrides: Record<string, jest.Mock> = {}) {
  const model = {
    createCollection: jest.fn(),
    createIndexes: jest.fn(),
    modelName: 'ImageEgressWorkerSlot',
    findOneAndUpdate: jest.fn(() => createQuery(null)),
    ...overrides,
  };
  const mongoose = { models: { ImageEgressWorkerSlot: model } } as never;
  return { methods: createImageEgressWorkerSlotMethods(mongoose), model };
}

describe('ImageEgressWorkerSlot persistence', () => {
  test('defines fixed reusable slots unique within a worker family', () => {
    expect(imageEgressWorkerSlotSchema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { workerFamily: 1, slotNumber: 1 },
          expect.objectContaining({ unique: true, name: 'uniq_image_egress_worker_slot' }),
        ],
      ]),
    );
    expect(imageEgressWorkerSlotSchema.path('ownerId')).toBeDefined();
    expect(imageEgressWorkerSlotSchema.path('leaseId')).toBeDefined();
    expect(imageEgressWorkerSlotSchema.path('leaseUntil')).toBeDefined();
    expect(imageEgressWorkerSlotSchema.path('heartbeatAt')).toBeDefined();
  });

  test('claims at most one fixed family slot when concurrency is one', async () => {
    const now = new Date('2026-08-08T10:00:00.000Z');
    const query = createQuery({
      _id: 'image-egress-v1:slot:0',
      workerFamily: 'image-egress-v1',
      slotNumber: 0,
      ownerId: 'worker-a',
      leaseId: 'lease-a',
    });
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });

    await methods.acquireImageEgressWorkerSlot({
      workerFamily: 'image-egress-v1',
      ownerId: 'worker-a',
      maxConcurrency: 1,
      leaseMs: 30_000,
      now,
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: 'image-egress-v1:slot:0',
        $or: [
          { ownerId: null },
          { ownerId: { $exists: false } },
          { leaseUntil: null },
          { leaseUntil: { $exists: false } },
          { leaseUntil: { $lte: now } },
        ],
      },
      {
        $set: expect.objectContaining({
          workerFamily: 'image-egress-v1',
          slotNumber: 0,
          ownerId: 'worker-a',
          leaseId: expect.any(String),
          leaseUntil: new Date('2026-08-08T10:00:30.000Z'),
          heartbeatAt: now,
        }),
      },
      { new: true, upsert: true },
    );
  });

  test('tries only the configured number of slots', async () => {
    const { methods, model } = createMethods({
      findOneAndUpdate: jest.fn(() => createQuery(null)),
    });

    await expect(
      methods.acquireImageEgressWorkerSlot({
        workerFamily: 'image-egress-v1',
        ownerId: 'worker-b',
        maxConcurrency: 2,
        leaseMs: 30_000,
      }),
    ).resolves.toBeNull();
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  test('heartbeats only a live slot owned by the matching lease and owner', async () => {
    const now = new Date('2026-08-08T10:00:00.000Z');
    const query = createQuery({ leaseId: 'lease-a', ownerId: 'worker-a' });
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });

    await methods.heartbeatImageEgressWorkerSlot({
      leaseId: 'lease-a',
      ownerId: 'worker-a',
      leaseMs: 30_000,
      now,
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        leaseId: 'lease-a',
        ownerId: 'worker-a',
        leaseUntil: { $gt: now },
      },
      {
        $set: {
          heartbeatAt: now,
          leaseUntil: new Date('2026-08-08T10:00:30.000Z'),
        },
      },
      { new: true },
    );
  });

  test('releases ownership without deleting the fixed slot', async () => {
    const now = new Date('2026-08-08T10:00:00.000Z');
    const query = createQuery({ ownerId: null, leaseId: null });
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });

    await expect(
      methods.releaseImageEgressWorkerSlot({
        leaseId: 'lease-a',
        ownerId: 'worker-a',
        now,
      }),
    ).resolves.toBe(true);

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { leaseId: 'lease-a', ownerId: 'worker-a' },
      {
        $set: { ownerId: null, leaseId: null, leaseUntil: null, heartbeatAt: now },
      },
      { new: true },
    );
  });
});
