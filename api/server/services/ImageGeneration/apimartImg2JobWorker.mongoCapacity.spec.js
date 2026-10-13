const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, createMethods } = require('@librechat/data-schemas');
const { createMongoAPIMartImg2JobStore } = require('./apimartImg2JobWorker');

describe('APIMart Mongo capacity accounting', () => {
  let server;
  let db;
  const resourceKey = 'apimart:capacity-test:gpt-image-2';
  const now = new Date();

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    createModels(mongoose);
    db = createMethods(mongoose);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  beforeEach(async () => {
    await mongoose.models.ImageGenerationJob.deleteMany({});
    await mongoose.models.ImageProviderConcurrencyLease.deleteMany({});
  });

  const acquire = (store, internalTaskId) =>
    store.acquireProviderPermit({
      resourceKey,
      internalTaskId,
      ownerId: `worker-${internalTaskId}`,
      leaseMs: 60_000,
    });
  const active = (internalTaskId) =>
    mongoose.models.ImageGenerationJob.create({
      internalTaskId,
      userId: 'test-user',
      requestId: internalTaskId,
      resourceKey,
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      asyncVersion: 2,
      workerEligible: true,
      status: 'status_unknown',
      submittedToProvider: true,
      providerTaskId: `provider-${internalTaskId}`,
    });

  test('admits two reservations without double-counting a covered active task', async () => {
    const store = createMongoAPIMartImg2JobStore({ db, maxConcurrency: 2, now: () => now });
    expect(await acquire(store, 'first')).not.toBeNull();
    await active('first');
    expect(await acquire(store, 'second')).not.toBeNull();
    expect(await acquire(store, 'third')).toBeNull();
  });

  test('includes an orphan after TTL cleanup when two workers reserve concurrently', async () => {
    await active('orphan');
    await db.acquireImageProviderConcurrencyLease({
      resourceKey,
      internalTaskId: 'orphan',
      ownerId: 'old-worker',
      maxConcurrency: 2,
      leaseMs: 1000,
      now: new Date(now.getTime() - 2000),
    });
    await db.pruneExpiredImageProviderConcurrencyLeases({ now });
    let arrived = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const concurrentDb = {
      ...db,
      acquireImageProviderConcurrencyLease: async (input) => {
        const permit = await db.acquireImageProviderConcurrencyLease(input);
        if (++arrived === 2) {
          release();
        }
        await gate;
        return permit;
      },
    };
    const store = createMongoAPIMartImg2JobStore({
      db: concurrentDb,
      maxConcurrency: 2,
      now: () => now,
    });
    const results = await Promise.all([acquire(store, 'new-a'), acquire(store, 'new-b')]);
    expect(results.filter(Boolean).length + 1).toBeLessThanOrEqual(2);
    const retryStore = createMongoAPIMartImg2JobStore({ db, maxConcurrency: 2, now: () => now });
    if (results.every((result) => !result)) {
      expect(await acquire(retryStore, 'retry')).not.toBeNull();
    }
  });

  test('recovers the same active task without consuming another slot', async () => {
    await active('recovering');
    const store = createMongoAPIMartImg2JobStore({ db, maxConcurrency: 2, now: () => now });
    const first = await acquire(store, 'recovering');
    const second = await acquire(store, 'recovering');
    expect(second.leaseId).toBe(first.leaseId);
    expect(await db.countActiveImageProviderConcurrencyLeases({ resourceKey, now })).toBe(1);
  });
});
