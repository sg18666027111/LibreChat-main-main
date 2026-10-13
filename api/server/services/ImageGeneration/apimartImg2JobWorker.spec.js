const { logger } = require('@librechat/data-schemas');
const {
  createAPIMartImg2JobWorker,
  createInMemoryAPIMartImg2JobStore,
  createMongoAPIMartImg2JobStore,
} = require('./apimartImg2JobWorker');
const {
  getAPIMartImg2AsyncMode,
  getAPIMartImg2WorkerRolloutModes,
  shouldStartAPIMartImg2JobWorker,
  shouldUseAPIMartImg2AsyncForUser,
} = require('./apimartImg2Async');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitForWorkerTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeAPIMartProvider() {
  const calls = [];
  let active = 0;
  let maxActive = 0;

  return {
    calls,
    get maxActive() {
      return maxActive;
    },
    async generate(request) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = createDeferred();
      calls.push({ request, gate });
      await gate.promise;
      active -= 1;
      return {
        taskId: `provider-${request.internalTaskId}`,
        status: 'success',
        images: [{ url: `https://example.test/${request.internalTaskId}.png` }],
      };
    },
  };
}

function createAcceptedAPIMartProvider(result = {}) {
  const calls = [];
  return {
    calls,
    async generate(request) {
      calls.push(request);
      if (request.onProviderTaskSubmitted) {
        await request.onProviderTaskSubmitted({
          providerTaskId: 'provider-task-1',
          providerStatus: 'IN_PROGRESS',
        });
      }
      return {
        taskId: 'provider-task-1',
        status: 'success',
        images: [{ url: 'https://example.test/result.png' }],
        ...result,
      };
    },
  };
}

async function createBaseJob(store, overrides = {}) {
  return store.createJob({
    internalTaskId: overrides.internalTaskId || 'job-1',
    requestId: overrides.requestId || 'request-1',
    userId: overrides.userId || 'user-1',
    tenantId: overrides.tenantId,
    businessType: overrides.businessType || 'image_generation',
    taskType: overrides.taskType || 'text-to-image',
    provider: 'apimart',
    model: 'gpt-image-2',
    modelKey: 'apimart_gpt_image_2_text',
    payload: { prompt: 'not inspected by logs', count: 1 },
    ...overrides,
  });
}

describe('APIMart img2 durable job worker', () => {
  test('scopes real Mongo lease and capacity calls to both APIMart image models', async () => {
    const calls = [];
    const db = {
      acquireImageGenerationJobLease: async (input) => {
        calls.push(input);
        return null;
      },
      countActiveImageGenerationProviderTasks: async (input) => {
        calls.push(input);
        return 1;
      },
    };
    const store = createMongoAPIMartImg2JobStore({ db, maxConcurrency: 1 });
    await store.claimNextWaitingJob({ workerId: 'worker', leaseMs: 30000 });
    expect(
      await store.acquireProviderPermit({
        resourceKey: 'apimart:key:gpt-image-2',
        internalTaskId: 'new-job',
      }),
    ).toBeNull();
    expect(calls).toHaveLength(4);
    for (const input of calls)
      expect(input.models).toEqual([
        'gpt-image-2',
        'gpt-image-2.5-sunburst',
        'gpt-image-2.5-flare',
      ]);
  });

  test.each([
    ['gpt-image-2', 'apimart_gpt_image_2'],
    ['gpt-image-2.5-sunburst', 'apimart_gpt_image_2_5_sunburst'],
    ['gpt-image-2.5-flare', 'apimart_gpt_image_2_5_flare'],
  ])(
    'records provider cost and model identity without inventing CNY for %s',
    async (model, modelKey) => {
      const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
      const usage = [];
      await createBaseJob(store, { model, modelKey, taskType: 'single-image-edit' });
      const worker = createAPIMartImg2JobWorker({
        workerId: 'cost-worker',
        store,
        provider: createAcceptedAPIMartProvider({
          cost: 0.017666,
          json: { data: { cost: 0.017666, credits_cost: 0.17666 } },
        }),
        recordUsage: async (event) => {
          usage.push(event);
        },
      });
      await worker.runOnce();
      expect((await store.getJob('job-1')).status).toBe('succeeded');
      expect(usage[1]).toMatchObject({
        model,
        modelKey,
        status: 'succeeded',
        metadata: { providerCost: 0.017666, providerCreditsCost: 0.17666 },
      });
      expect(usage[1]).not.toHaveProperty('costCny');
      expect(usage[0]).not.toHaveProperty('metadata.providerCost');
    },
  );

  test('counts orphan active jobs together with concurrent Mongo reservations', async () => {
    const permits = new Map();
    const db = {
      countActiveImageGenerationProviderTasks: jest.fn(async () => 1),
      acquireImageProviderConcurrencyLease: jest.fn(async ({ internalTaskId }) => {
        const permit = { leaseId: internalTaskId, internalTaskId };
        permits.set(internalTaskId, permit);
        return permit;
      }),
      listActiveImageProviderConcurrencyLeases: jest.fn(async () => [...permits.values()]),
      releaseImageProviderConcurrencyLease: jest.fn(async ({ internalTaskId }) => {
        permits.delete(internalTaskId);
      }),
    };
    const store = createMongoAPIMartImg2JobStore({ db, maxConcurrency: 2 });
    const acquired = await Promise.all(
      ['new-a', 'new-b'].map((internalTaskId) =>
        store.acquireProviderPermit({
          resourceKey: 'apimart:key:gpt-image-2',
          ownerId: internalTaskId,
          internalTaskId,
          leaseMs: 60_000,
        }),
      ),
    );
    expect(acquired.filter(Boolean).length + 1).toBeLessThanOrEqual(2);
  });

  test('runs different users concurrently up to the configured worker limit', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 2 });
    const provider = createFakeAPIMartProvider();
    for (let i = 0; i < 3; i++) {
      await createBaseJob(store, { internalTaskId: `parallel-${i}`, userId: `user-${i}` });
    }
    const worker = createAPIMartImg2JobWorker({
      workerId: 'parallel-worker',
      store,
      provider,
      maxConcurrency: 2,
    });
    const runs = [worker.runOnce(), worker.runOnce()];
    await waitForWorkerTick();
    await worker.runOnce();
    try {
      expect(provider.calls).toHaveLength(2);
      expect(provider.maxActive).toBe(2);
    } finally {
      provider.calls.forEach(({ gate }) => gate.resolve());
      await Promise.all(runs);
    }
  });

  test('does not hard-code one active provider task when the configured limit is two', async () => {
    const db = {
      countActiveImageGenerationProviderTasks: jest.fn(async () => 1),
      acquireImageProviderConcurrencyLease: jest.fn(async () => ({ leaseId: 'slot-1' })),
      listActiveImageProviderConcurrencyLeases: jest.fn(async () => [
        { internalTaskId: 'next-user' },
      ]),
      releaseImageProviderConcurrencyLease: jest.fn(),
    };
    const store = createMongoAPIMartImg2JobStore({ db, maxConcurrency: 2 });
    expect(
      await store.acquireProviderPermit({
        resourceKey: 'apimart:key:gpt-image-2',
        ownerId: 'worker-b',
        internalTaskId: 'next-user',
        leaseMs: 60_000,
      }),
    ).toEqual({ leaseId: 'slot-1' });
  });

  describe('worker auto-start guard', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalJestWorkerId = process.env.JEST_WORKER_ID;
    const originalAsyncMode = process.env.APIMART_IMG2_ASYNC_MODE;
    const originalCanaryUserIds = process.env.APIMART_IMG2_ASYNC_CANARY_USER_IDS;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalJestWorkerId == null) {
        delete process.env.JEST_WORKER_ID;
      } else {
        process.env.JEST_WORKER_ID = originalJestWorkerId;
      }
      if (originalAsyncMode == null) {
        delete process.env.APIMART_IMG2_ASYNC_MODE;
      } else {
        process.env.APIMART_IMG2_ASYNC_MODE = originalAsyncMode;
      }
      if (originalCanaryUserIds == null) {
        delete process.env.APIMART_IMG2_ASYNC_CANARY_USER_IDS;
      } else {
        process.env.APIMART_IMG2_ASYNC_CANARY_USER_IDS = originalCanaryUserIds;
      }
    });

    test('fails closed when async mode is omitted or invalid', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.JEST_WORKER_ID;
      delete process.env.APIMART_IMG2_ASYNC_MODE;
      delete process.env.APIMART_IMG2_ASYNC_CANARY_USER_IDS;

      expect(getAPIMartImg2AsyncMode()).toBe('off');
      expect(shouldStartAPIMartImg2JobWorker()).toBe(false);
      expect(shouldUseAPIMartImg2AsyncForUser('user-1')).toBe(false);

      process.env.APIMART_IMG2_ASYNC_MODE = 'unexpected';
      expect(getAPIMartImg2AsyncMode()).toBe('off');
      expect(shouldStartAPIMartImg2JobWorker()).toBe(false);
      expect(shouldUseAPIMartImg2AsyncForUser('user-1')).toBe(false);
    });

    test('enables async only for canary allowlisted user ids', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.JEST_WORKER_ID;
      process.env.APIMART_IMG2_ASYNC_MODE = 'canary';
      process.env.APIMART_IMG2_ASYNC_CANARY_USER_IDS = 'user-1,user-2';

      expect(shouldStartAPIMartImg2JobWorker()).toBe(true);
      expect(shouldUseAPIMartImg2AsyncForUser('user-1')).toBe(true);
      expect(shouldUseAPIMartImg2AsyncForUser('user-3')).toBe(false);
    });

    test('does not auto-start inside CI or Jest', () => {
      process.env.APIMART_IMG2_ASYNC_MODE = 'all';
      process.env.NODE_ENV = 'CI';
      delete process.env.JEST_WORKER_ID;
      expect(shouldStartAPIMartImg2JobWorker()).toBe(false);

      process.env.NODE_ENV = 'production';
      process.env.JEST_WORKER_ID = '1';
      expect(shouldStartAPIMartImg2JobWorker()).toBe(false);
    });

    test('allows auto-start in production outside Jest only when rollout is enabled', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.JEST_WORKER_ID;
      process.env.APIMART_IMG2_ASYNC_MODE = 'all';
      expect(shouldStartAPIMartImg2JobWorker()).toBe(true);
    });

    test('scopes worker claims to the active rollout mode', () => {
      process.env.APIMART_IMG2_ASYNC_MODE = 'off';
      expect(getAPIMartImg2WorkerRolloutModes()).toEqual([]);

      process.env.APIMART_IMG2_ASYNC_MODE = 'canary';
      expect(getAPIMartImg2WorkerRolloutModes()).toEqual(['canary']);

      process.env.APIMART_IMG2_ASYNC_MODE = 'all';
      expect(getAPIMartImg2WorkerRolloutModes()).toEqual(['canary', 'all']);
    });
  });

  test('serializes independent and batch jobs through one shared provider permit across workers', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const provider = createFakeAPIMartProvider();

    await store.createJob({
      internalTaskId: 'job-independent',
      requestId: 'request-independent',
      userId: 'user-1',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      payload: { prompt: 'not inspected by logs', count: 1 },
    });
    await store.createJob({
      internalTaskId: 'job-batch-item',
      requestId: 'batch-1',
      batchTaskId: 'batch-1',
      itemId: 'item-1',
      userId: 'user-1',
      businessType: 'batch_image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      payload: { prompt: 'not inspected by logs', count: 1 },
    });

    const workerA = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      pollIntervalMs: 0,
    });
    const workerB = createAPIMartImg2JobWorker({
      workerId: 'worker-b',
      store,
      provider,
      pollIntervalMs: 0,
    });

    const firstRun = workerA.runOnce();
    await workerB.runOnce();
    await waitForWorkerTick();
    expect(provider.calls).toHaveLength(1);
    expect(await store.getCurrentConcurrency()).toBe(1);

    provider.calls[0].gate.resolve();
    await firstRun;

    const secondRun = workerB.runOnce();
    await waitForWorkerTick();
    expect(provider.calls).toHaveLength(2);
    expect(provider.maxActive).toBe(1);

    provider.calls[1].gate.resolve();
    await secondRun;

    const independent = await store.getJob('job-independent');
    const batchItem = await store.getJob('job-batch-item');
    expect(independent.status).toBe('succeeded');
    expect(batchItem.status).toBe('succeeded');
    expect(independent.submittedToProvider).toBe(true);
    expect(batchItem.submittedToProvider).toBe(true);
    expect(await store.getCurrentConcurrency()).toBe(0);
  });

  test('does not submit a waiting job to APIMart until a provider permit is acquired', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const provider = createFakeAPIMartProvider();

    await store.acquireProviderPermit({
      resourceKey: 'apimart:test-key:gpt-image-2',
      ownerId: 'external-worker',
      internalTaskId: 'external-job',
      leaseMs: 60_000,
    });
    await store.createJob({
      internalTaskId: 'job-waiting',
      requestId: 'request-waiting',
      userId: 'user-1',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      payload: { prompt: 'not inspected by logs', count: 1 },
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      pollIntervalMs: 0,
    });

    await worker.runOnce();

    const job = await store.getJob('job-waiting');
    expect(job.status).toBe('waiting');
    expect(job.submittedToProvider).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  test('heartbeats the provider permit while an APIMart request is still running', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const provider = createFakeAPIMartProvider();

    await store.createJob({
      internalTaskId: 'job-long-running',
      requestId: 'request-long-running',
      userId: 'user-1',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      payload: { prompt: 'not inspected by logs', count: 1 },
    });
    await store.createJob({
      internalTaskId: 'job-must-wait',
      requestId: 'request-must-wait',
      userId: 'user-1',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      payload: { prompt: 'not inspected by logs', count: 1 },
    });

    const workerA = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      jobLeaseMs: 1000,
      providerLeaseMs: 1000,
      heartbeatIntervalMs: 50,
    });
    const workerB = createAPIMartImg2JobWorker({
      workerId: 'worker-b',
      store,
      provider,
      jobLeaseMs: 1000,
      providerLeaseMs: 1000,
      heartbeatIntervalMs: 50,
    });

    const firstRun = workerA.runOnce();
    await waitForWorkerTick();
    expect(provider.calls).toHaveLength(1);

    await sleep(1200);
    const secondRun = workerB.runOnce();
    await waitForWorkerTick();
    expect(provider.calls).toHaveLength(1);
    expect(provider.maxActive).toBe(1);

    provider.calls[0].gate.resolve();
    if (provider.calls[1]) {
      provider.calls[1].gate.resolve();
    }
    await Promise.all([firstRun, secondRun]);
  });

  test('keeps the provider permit active across polling backoff that exceeds the permit ttl', async () => {
    let current = new Date('2026-08-05T06:00:00.000Z');
    const store = createInMemoryAPIMartImg2JobStore({
      maxConcurrency: 1,
      now: () => current,
    });
    const provider = {
      generate: jest.fn(async (request) => {
        await request.onProviderTaskSubmitted({
          providerTaskId: 'provider-task-pending',
          providerStatus: 'processing',
        });
        const error = new Error('provider still processing');
        error.code = 'IMAGE_GENERATION_TIMEOUT';
        error.statusCode = 504;
        error.providerTaskId = 'provider-task-pending';
        error.providerStatus = 'processing';
        throw error;
      }),
      resume: jest.fn(),
    };
    const recordUsage = jest.fn(async () => ({ _id: 'usage-submitted' }));

    await createBaseJob(store, {
      internalTaskId: 'job-polling-backoff',
      requestId: 'request-polling-backoff',
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      recordUsage,
      jobLeaseMs: 100,
      providerLeaseMs: 100,
      heartbeatIntervalMs: 0,
    });

    await worker.runOnce();
    current = new Date(current.getTime() + 150);

    const job = await store.getJob('job-polling-backoff');
    expect(job.status).toBe('polling');
    expect(job.providerTaskId).toBe('provider-task-pending');
    expect(await store.getCurrentConcurrency()).toBe(1);
  });

  test('does not submit a waiting job while another provider task is pending even after permit ttl expiry', async () => {
    let current = new Date('2026-08-05T06:00:00.000Z');
    const store = createInMemoryAPIMartImg2JobStore({
      maxConcurrency: 1,
      now: () => current,
    });
    const provider = {
      generate: jest.fn(async (request) => {
        await request.onProviderTaskSubmitted({
          providerTaskId: `provider-${request.internalTaskId}`,
          providerStatus: 'processing',
        });
        const error = new Error('provider still processing');
        error.code = 'IMAGE_GENERATION_TIMEOUT';
        error.statusCode = 504;
        error.providerTaskId = `provider-${request.internalTaskId}`;
        error.providerStatus = 'processing';
        throw error;
      }),
      resume: jest.fn(),
    };

    await createBaseJob(store, {
      internalTaskId: 'job-active-provider',
      requestId: 'request-active-provider',
    });
    await createBaseJob(store, {
      internalTaskId: 'job-waiting-behind-active-provider',
      requestId: 'request-waiting-behind-active-provider',
    });

    const workerA = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      jobLeaseMs: 100,
      providerLeaseMs: 100,
      heartbeatIntervalMs: 0,
    });
    const workerB = createAPIMartImg2JobWorker({
      workerId: 'worker-b',
      store,
      provider,
      jobLeaseMs: 100,
      providerLeaseMs: 100,
      heartbeatIntervalMs: 0,
    });

    await workerA.runOnce();
    await store.updateJob({
      internalTaskId: 'job-active-provider',
      updates: {
        nextPollAt: new Date(current.getTime() + 60_000),
        workerOwner: null,
        workerLeaseUntil: null,
      },
    });
    current = new Date(current.getTime() + 150);

    await workerB.runOnce();

    const activeJob = await store.getJob('job-active-provider');
    const waitingJob = await store.getJob('job-waiting-behind-active-provider');
    expect(activeJob.status).toBe('polling');
    expect(waitingJob.status).toBe('waiting');
    expect(waitingJob.submittedToProvider).toBe(false);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  test('does not submit waiting jobs while a stale submitting job is being marked unknown', async () => {
    const rawStore = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const statusUnknownUpdateStarted = createDeferred();
    const statusUnknownUpdateGate = createDeferred();
    const store = {
      ...rawStore,
      updateJob: jest.fn(async (args) => {
        if (
          args.internalTaskId === 'job-stale-submitting-no-task-id' &&
          args.updates?.status === 'status_unknown'
        ) {
          statusUnknownUpdateStarted.resolve();
          await statusUnknownUpdateGate.promise;
        }
        return rawStore.updateJob(args);
      }),
    };
    const provider = {
      generate: jest.fn(async () => ({
        taskId: 'provider-waiting-should-not-submit',
        status: 'success',
        images: [{ url: 'https://example.test/should-not-submit.png' }],
      })),
    };

    await rawStore.createJob({
      internalTaskId: 'job-stale-submitting-no-task-id',
      requestId: 'request-stale-submitting-no-task-id',
      userId: 'user-1',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      payload: { prompt: 'not inspected by logs', count: 1 },
      status: 'submitting',
      submittedToProvider: false,
      providerTaskId: null,
    });
    await createBaseJob(rawStore, {
      internalTaskId: 'job-waiting-behind-stale-submitting',
      requestId: 'request-waiting-behind-stale-submitting',
    });

    const recoveryWorker = createAPIMartImg2JobWorker({
      workerId: 'worker-recovery',
      store,
      provider,
      jobLeaseMs: 30_000,
      providerLeaseMs: 100,
      heartbeatIntervalMs: 0,
    });
    const waitingWorker = createAPIMartImg2JobWorker({
      workerId: 'worker-waiting',
      store,
      provider,
      jobLeaseMs: 30_000,
      providerLeaseMs: 100,
      heartbeatIntervalMs: 0,
    });

    const recoveryRun = recoveryWorker.runOnce();
    await statusUnknownUpdateStarted.promise;

    await waitingWorker.runOnce();

    const waitingJob = await rawStore.getJob('job-waiting-behind-stale-submitting');
    expect(provider.generate).not.toHaveBeenCalled();
    expect(waitingJob.status).toBe('waiting');
    expect(waitingJob.submittedToProvider).toBe(false);

    statusUnknownUpdateGate.resolve();
    await recoveryRun;

    const staleJob = await rawStore.getJob('job-stale-submitting-no-task-id');
    expect(staleJob.status).toBe('status_unknown');
    expect(staleJob.submittedToProvider).toBe(true);
  });

  test('lets a recovered worker take over the same task permit without allowing old-owner release', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    await createBaseJob(store, {
      internalTaskId: 'job-recovered-owner',
      requestId: 'request-recovered-owner',
    });

    const firstPermit = await store.acquireProviderPermit({
      resourceKey: 'apimart:test-key:gpt-image-2',
      ownerId: 'worker-old',
      internalTaskId: 'job-recovered-owner',
      providerTaskId: 'provider-task-recovered-owner',
      leaseMs: 60_000,
    });
    const recoveredPermit = await store.acquireProviderPermit({
      resourceKey: 'apimart:test-key:gpt-image-2',
      ownerId: 'worker-new',
      internalTaskId: 'job-recovered-owner',
      providerTaskId: 'provider-task-recovered-owner',
      leaseMs: 60_000,
    });

    expect(recoveredPermit.leaseId).toBe(firstPermit.leaseId);
    expect(recoveredPermit.ownerId).toBe('worker-new');
    expect(
      await store.heartbeatProviderPermit({
        leaseId: firstPermit.leaseId,
        ownerId: 'worker-old',
        internalTaskId: 'job-recovered-owner',
        leaseMs: 60_000,
      }),
    ).toBeNull();
    expect(
      await store.releaseProviderPermit({
        leaseId: firstPermit.leaseId,
        ownerId: 'worker-old',
        internalTaskId: 'job-recovered-owner',
      }),
    ).toBe(false);
    expect(await store.getCurrentConcurrency()).toBe(1);
    expect(
      await store.releaseProviderPermit({
        leaseId: firstPermit.leaseId,
        ownerId: 'worker-new',
        internalTaskId: 'job-recovered-owner',
      }),
    ).toBe(true);
    expect(await store.getCurrentConcurrency()).toBe(0);
  });

  test('lets an expired provider permit slot be taken over by a new task', async () => {
    let current = new Date('2026-08-05T06:00:00.000Z');
    const store = createInMemoryAPIMartImg2JobStore({
      maxConcurrency: 1,
      now: () => current,
    });

    await store.acquireProviderPermit({
      resourceKey: 'apimart:test-key:gpt-image-2',
      ownerId: 'worker-old',
      internalTaskId: 'job-expired-owner',
      leaseMs: 100,
    });
    current = new Date(current.getTime() + 101);
    const nextPermit = await store.acquireProviderPermit({
      resourceKey: 'apimart:test-key:gpt-image-2',
      ownerId: 'worker-new',
      internalTaskId: 'job-after-expired-permit',
      leaseMs: 100,
    });

    expect(nextPermit).toEqual(
      expect.objectContaining({
        ownerId: 'worker-new',
        internalTaskId: 'job-after-expired-permit',
      }),
    );
    expect(await store.getCurrentConcurrency()).toBe(1);
  });

  test('does not let the same worker reclaim an active submitting job before its lease expires', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const provider = createFakeAPIMartProvider();
    const recordUsage = jest.fn(async () => ({ durableAccepted: true, ledgerPersisted: true }));

    await createBaseJob(store, {
      internalTaskId: 'job-active-submit',
      requestId: 'request-active-submit',
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      recordUsage,
      jobLeaseMs: 30_000,
      providerLeaseMs: 30_000,
      heartbeatIntervalMs: 10_000,
    });

    const firstRun = worker.runOnce();
    await waitForWorkerTick();
    expect(provider.calls).toHaveLength(1);

    const afterFirstTick = await store.getJob('job-active-submit');
    expect(afterFirstTick.status).toBe('submitting');
    expect(afterFirstTick.workerOwner).toBe('worker-a');
    expect(new Date(afterFirstTick.workerLeaseUntil).getTime()).toBeGreaterThan(Date.now());

    try {
      await worker.runOnce();

      const duringSubmit = await store.getJob('job-active-submit');
      expect(provider.calls).toHaveLength(1);
      expect(duringSubmit.status).toBe('submitting');
      expect(duringSubmit.submittedToProvider).toBe(false);
      expect(recordUsage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'status_unknown',
        }),
      );
    } finally {
      provider.calls[0].gate.resolve();
      await firstRun;
    }

    const finalJob = await store.getJob('job-active-submit');
    expect(finalJob.status).toBe('succeeded');
    expect(provider.calls).toHaveLength(1);
  });

  test('records submitted usage and final success against the same idempotency key', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const provider = createAcceptedAPIMartProvider();
    const recordUsage = jest.fn(async () => ({ durableAccepted: true, ledgerPersisted: true }));

    await store.createJob({
      internalTaskId: 'job-accepted',
      requestId: 'request-accepted',
      userId: 'user-1',
      tenantId: 'tenant-1',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      payload: { prompt: 'not inspected by logs', count: 1 },
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      recordUsage,
    });

    await worker.runOnce();

    const job = await store.getJob('job-accepted');
    expect(job.status).toBe('succeeded');
    expect(job.submittedToProvider).toBe(true);
    expect(job.usageRecorded).toBe(true);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        requestId: 'request-accepted',
        provider: 'apimart',
        model: 'gpt-image-2',
        modelKey: 'apimart_gpt_image_2_text',
        taskType: 'text-to-image',
        businessType: 'image_generation',
        status: 'submitted',
        providerTaskId: 'provider-task-1',
      }),
    );
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-accepted',
        status: 'succeeded',
        imageCount: 1,
        providerTaskId: 'provider-task-1',
      }),
    );
  });

  test('resolves staged image input references before provider submit and cleans them after success', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const provider = createAcceptedAPIMartProvider();
    const recordUsage = jest.fn(async () => ({ durableAccepted: true, ledgerPersisted: true }));
    const resolveJobPayload = jest.fn(async (job) => ({
      ...job.payload,
      imageInputs: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'],
    }));
    const cleanupJobPayload = jest.fn(async () => undefined);

    await store.createJob({
      internalTaskId: 'job-staged-inputs',
      requestId: 'request-staged-inputs',
      userId: 'user-1',
      tenantId: 'tenant-1',
      businessType: 'product_replacement',
      taskType: 'multi-reference',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2',
      payload: {
        prompt: 'not inspected by logs',
        imageInputRefs: [
          { kind: 'file', index: 0, fileId: 'input-file-1', mimeType: 'image/png' },
          { kind: 'file', index: 1, fileId: 'input-file-2', mimeType: 'image/png' },
        ],
      },
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      recordUsage,
      resolveJobPayload,
      cleanupJobPayload,
    });

    await worker.runOnce();

    const job = await store.getJob('job-staged-inputs');
    expect(resolveJobPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        internalTaskId: 'job-staged-inputs',
        payload: expect.objectContaining({ imageInputRefs: expect.any(Array) }),
      }),
    );
    expect(provider.calls[0]).toEqual(
      expect.objectContaining({
        imageInputs: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'],
      }),
    );
    expect(job.status).toBe('succeeded');
    expect(cleanupJobPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        internalTaskId: 'job-staged-inputs',
        status: 'succeeded',
        payload: expect.objectContaining({ imageInputRefs: expect.any(Array) }),
      }),
    );
  });

  test('marks submit-before-provider 502 as failed without submitted usage', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const error = new Error('APIMart gateway failed before accepting request');
    error.statusCode = 502;
    error.code = 'APIMART_502';
    const provider = {
      calls: [],
      async generate(request) {
        this.calls.push(request);
        throw error;
      },
    };
    const recordUsage = jest.fn();

    await store.createJob({
      internalTaskId: 'job-502',
      requestId: 'request-502',
      userId: 'user-1',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      payload: { prompt: 'not inspected by logs', count: 1 },
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      recordUsage,
    });

    await worker.runOnce();

    const job = await store.getJob('job-502');
    expect(job.status).toBe('failed');
    expect(job.submittedToProvider).toBe(false);
    expect(job.errorCode).toBe('APIMART_502');
    expect(await store.getCurrentConcurrency()).toBe(0);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  test('resumes a long-running task after 30 seconds without resubmission or duplicate admission', async () => {
    jest.useFakeTimers();
    const logs = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
      const recordUsage = jest.fn(async () => ({ durableAccepted: true, ledgerPersisted: true }));
      const provider = {
        generate: jest.fn(async (request) => {
          await request.onProviderTaskSubmitted({ providerTaskId: 'existing-task' });
          for (let i = 0; i < 197; i++) {
            await request.onProviderPoll({
              providerTaskId: 'existing-task',
              providerStatus: 'processing',
            });
          }
          throw Object.assign(new Error('poll budget exhausted'), {
            code: 'IMAGE_GENERATION_TIMEOUT',
            providerTaskId: 'existing-task',
            providerStatus: 'processing',
          });
        }),
        resume: jest.fn(async (request) => ({
          taskId: request.providerTaskId,
          status: 'success',
          images: [{ url: 'https://example.test/recovered.png' }],
        })),
      };
      await createBaseJob(store, { internalTaskId: 'timed-recovery', requestId: 'timed-request' });
      const worker = createAPIMartImg2JobWorker({
        workerId: 'worker-timed',
        store,
        provider,
        recordUsage,
        heartbeatIntervalMs: 0,
      });
      await worker.runOnce();
      await jest.advanceTimersByTimeAsync(29999);
      await worker.runOnce();
      expect(provider.resume).not.toHaveBeenCalled();
      expect(await store.getCurrentConcurrency()).toBe(1);
      await jest.advanceTimersByTimeAsync(1);
      await worker.runOnce();
      expect(provider.resume).toHaveBeenCalledTimes(1);
      expect(provider.resume).toHaveBeenCalledWith(
        expect.objectContaining({ providerTaskId: 'existing-task' }),
      );
      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect((await store.getJob('timed-recovery')).status).toBe('succeeded');
      expect(await store.getCurrentConcurrency()).toBe(0);
      const timings = logs.mock.calls
        .map(([message]) => message)
        .filter((message) => message.includes(' timing '))
        .map((message) => JSON.parse(message.split(' timing ')[1]));
      expect(timings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage: 'reference_prepare', outcome: 'success' }),
          expect.objectContaining({
            stage: 'recovery_wait',
            outcome: 'scheduled',
            durationMs: 30000,
          }),
          expect.objectContaining({
            stage: 'recovery_wait',
            outcome: 'resumed',
            durationMs: 30000,
            scheduledDelayMs: 30000,
          }),
        ]),
      );
      expect(recordUsage.mock.calls.filter(([entry]) => entry.status === 'submitted')).toHaveLength(
        1,
      );
    } finally {
      logs.mockRestore();
      jest.useRealTimers();
    }
  });

  test('keeps an accepted provider task polling after a transient poll timeout', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const recordUsage = jest.fn(async () => ({ durableAccepted: true, ledgerPersisted: true }));
    const provider = {
      calls: [],
      async generate(request) {
        this.calls.push(request);
        await request.onProviderTaskSubmitted({
          providerTaskId: 'provider-task-timeout',
          providerStatus: 'IN_PROGRESS',
        });
        const error = new Error('polling timed out');
        error.code = 'IMAGE_GENERATION_TIMEOUT';
        error.statusCode = 504;
        error.providerTaskId = 'provider-task-timeout';
        throw error;
      },
    };

    await store.createJob({
      internalTaskId: 'job-timeout',
      requestId: 'request-timeout',
      userId: 'user-1',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      payload: { prompt: 'not inspected by logs', count: 1 },
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      recordUsage,
    });

    await worker.runOnce();

    const job = await store.getJob('job-timeout');
    expect(job.status).toBe('polling');
    expect(job.submittedToProvider).toBe(true);
    expect(job.providerTaskId).toBe('provider-task-timeout');
    expect(job.nextPollAt).toBeInstanceOf(Date);
    expect(provider.calls).toHaveLength(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-timeout',
        status: 'submitted',
        providerTaskId: 'provider-task-timeout',
      }),
    );
  });

  test('marks completed APIMart error 17419 without an image as failed, not status_unknown', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const recordUsage = jest.fn(async () => ({ durableAccepted: true, ledgerPersisted: true }));
    const provider = {
      calls: [],
      async generate(request) {
        this.calls.push(request);
        await request.onProviderTaskSubmitted({
          providerTaskId: 'provider-task-no-image',
          providerStatus: 'IN_PROGRESS',
        });
        const error = new Error('provider completed without a valid image');
        error.code = '17419';
        error.providerErrorCode = '17419';
        error.providerStatus = 'completed';
        error.providerTaskId = 'provider-task-no-image';
        throw error;
      },
    };

    await createBaseJob(store, {
      internalTaskId: 'job-no-image',
      requestId: 'request-no-image',
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      recordUsage,
    });

    await worker.runOnce();

    const job = await store.getJob('job-no-image');
    expect(job.status).toBe('failed');
    expect(job.providerStatus).toBe('completed');
    expect(job.providerErrorCode).toBe('17419');
    expect(job.errorCode).toBe('17419');
    expect(job.submittedToProvider).toBe(true);
    expect(await store.getCurrentConcurrency()).toBe(0);
    expect(recordUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestId: 'request-no-image',
        status: 'failed',
        providerTaskId: 'provider-task-no-image',
      }),
    );
  });

  test('marks submit acceptance timeout as status_unknown and counts it as possibly submitted', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const recordUsage = jest.fn(async () => ({ _id: 'usage-unknown' }));
    const provider = {
      calls: [],
      async generate(request) {
        this.calls.push(request);
        const error = new Error('submit acceptance timed out');
        error.code = 'APIMART_IMAGE_SUBMIT_TIMEOUT';
        error.statusCode = 524;
        throw error;
      },
    };

    await store.createJob({
      internalTaskId: 'job-submit-unknown',
      requestId: 'request-submit-unknown',
      userId: 'user-1',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      payload: { prompt: 'not inspected by logs', count: 1 },
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      recordUsage,
    });

    await worker.runOnce();

    const job = await store.getJob('job-submit-unknown');
    expect(job.status).toBe('status_unknown');
    expect(job.submittedToProvider).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(await store.getCurrentConcurrency()).toBe(0);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-submit-unknown',
        status: 'status_unknown',
        providerTaskId: null,
      }),
    );
  });

  test('upload timeout is failed before submission and releases the capacity slot', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    await store.createJob({
      internalTaskId: 'job-upload-failed',
      requestId: 'request-upload-failed',
      userId: 'user-1',
      businessType: 'image_generation',
      taskType: 'single-image-edit',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2',
      payload: {},
    });
    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider: {
        async generate() {
          const error = new Error('Reference upload did not finish');
          error.code = 'APIMART_INPUT_UPLOAD_TIMEOUT';
          error.submittedToProvider = false;
          throw error;
        },
      },
      recordUsage: async () => ({}),
    });
    await worker.runOnce();
    const job = await store.getJob('job-upload-failed');
    expect(job.status).toBe('failed');
    expect(job.submittedToProvider).toBe(false);
    expect(job.providerTaskId).toBeFalsy();
    expect(await store.getCurrentConcurrency()).toBe(0);
  });

  test('claims stale in-flight statuses through the Mongo atomic job lease', async () => {
    const db = {
      acquireImageGenerationJobLease: jest.fn(async () => null),
    };
    const store = createMongoAPIMartImg2JobStore({ db });

    await store.claimNextWaitingJob({ workerId: 'worker-a', leaseMs: 30_000 });

    expect(db.acquireImageGenerationJobLease.mock.calls.map(([arg]) => arg.statuses)).toEqual([
      ['submitted', 'polling'],
      ['submitting'],
      ['waiting'],
    ]);
  });

  test('prefers stale provider polling recovery before claiming waiting jobs in Mongo', async () => {
    const db = {
      acquireImageGenerationJobLease: jest
        .fn()
        .mockResolvedValueOnce({
          internalTaskId: 'task-polling',
          requestId: 'request-polling',
          status: 'polling',
          providerTaskId: 'provider-task-polling',
        })
        .mockResolvedValueOnce({
          internalTaskId: 'task-waiting',
          requestId: 'request-waiting',
          status: 'waiting',
        }),
    };
    const store = createMongoAPIMartImg2JobStore({ db });

    const claimed = await store.claimNextWaitingJob({ workerId: 'worker-a', leaseMs: 30_000 });

    expect(claimed.internalTaskId).toBe('task-polling');
    expect(db.acquireImageGenerationJobLease).toHaveBeenCalledTimes(1);
    expect(db.acquireImageGenerationJobLease).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ['submitted', 'polling'],
      }),
    );
  });

  test('passes rollout mode limits into the Mongo atomic job lease', async () => {
    const db = {
      acquireImageGenerationJobLease: jest.fn(async () => null),
    };
    const store = createMongoAPIMartImg2JobStore({ db, rolloutModes: ['canary'] });

    await store.claimNextWaitingJob({ workerId: 'worker-a', leaseMs: 30_000 });

    expect(db.acquireImageGenerationJobLease).toHaveBeenCalledWith(
      expect.objectContaining({
        rolloutModes: ['canary'],
      }),
    );
  });

  test('normalizes Mongo provider lease ids so worker heartbeats and releases the claimed slot', async () => {
    const db = {
      countActiveImageGenerationProviderTasks: jest.fn(async () => 0),
      listActiveImageProviderConcurrencyLeases: jest.fn(async () => [{ internalTaskId: 'task-1' }]),
      acquireImageProviderConcurrencyLease: jest.fn(async () => ({
        _id: 'apimart:key:gpt-image-2:slot:0',
        resourceKey: 'apimart:key:gpt-image-2',
        ownerId: 'worker-a',
        internalTaskId: 'task-1',
        leaseExpiresAt: new Date('2026-08-04T10:01:00.000Z'),
      })),
    };
    const store = createMongoAPIMartImg2JobStore({ db });

    const lease = await store.acquireProviderPermit({
      resourceKey: 'apimart:key:gpt-image-2',
      ownerId: 'worker-a',
      internalTaskId: 'task-1',
      leaseMs: 60_000,
    });

    expect(lease.leaseId).toBe('apimart:key:gpt-image-2:slot:0');
  });

  test('checks active submitted provider tasks before acquiring a Mongo permit', async () => {
    const db = {
      countActiveImageGenerationProviderTasks: jest.fn(async () => 1),
      acquireImageProviderConcurrencyLease: jest.fn(),
    };
    const store = createMongoAPIMartImg2JobStore({ db });

    const lease = await store.acquireProviderPermit({
      resourceKey: 'apimart:key:gpt-image-2',
      ownerId: 'worker-b',
      internalTaskId: 'task-waiting',
      leaseMs: 60_000,
    });

    expect(lease).toBeNull();
    expect(db.countActiveImageGenerationProviderTasks).toHaveBeenCalledWith({
      models: ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'],
      resourceKey: 'apimart:key:gpt-image-2',
      excludeInternalTaskId: 'task-waiting',
    });
    expect(db.acquireImageProviderConcurrencyLease).not.toHaveBeenCalled();
  });

  test('releases a Mongo permit when the post-acquire active job guard fails', async () => {
    const db = {
      listActiveImageProviderConcurrencyLeases: jest.fn(async () => [
        { internalTaskId: 'task-waiting' },
      ]),
      countActiveImageGenerationProviderTasks: jest
        .fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1),
      acquireImageProviderConcurrencyLease: jest.fn(async () => ({
        _id: 'apimart:key:gpt-image-2:slot:0',
        resourceKey: 'apimart:key:gpt-image-2',
        ownerId: 'worker-race',
        internalTaskId: 'task-waiting',
        leaseExpiresAt: new Date('2026-08-04T10:01:00.000Z'),
      })),
      releaseImageProviderConcurrencyLease: jest.fn(async () => true),
    };
    const store = createMongoAPIMartImg2JobStore({ db });

    const lease = await store.acquireProviderPermit({
      resourceKey: 'apimart:key:gpt-image-2',
      ownerId: 'worker-race',
      internalTaskId: 'task-waiting',
      leaseMs: 60_000,
    });

    expect(lease).toBeNull();
    expect(db.countActiveImageGenerationProviderTasks).toHaveBeenCalledTimes(2);
    expect(db.acquireImageProviderConcurrencyLease).toHaveBeenCalledTimes(1);
    expect(db.releaseImageProviderConcurrencyLease).toHaveBeenCalledWith({
      leaseId: 'apimart:key:gpt-image-2:slot:0',
      ownerId: 'worker-race',
      internalTaskId: 'task-waiting',
    });
  });

  test('does not claim jobs from a rollout mode outside the worker allowlist', async () => {
    const store = createInMemoryAPIMartImg2JobStore({
      maxConcurrency: 1,
      rolloutModes: ['canary'],
    });
    const provider = createAcceptedAPIMartProvider();

    await createBaseJob(store, {
      internalTaskId: 'all-mode-job',
      requestId: 'all-mode-request',
      rolloutMode: 'all',
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
    });

    await worker.runOnce();

    const job = await store.getJob('all-mode-job');
    expect(job.status).toBe('waiting');
    expect(job.workerOwner).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  test('does not claim legacy async jobs without v2 worker eligibility', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const provider = createAcceptedAPIMartProvider();

    await createBaseJob(store, {
      internalTaskId: 'legacy-job',
      requestId: 'legacy-request',
      asyncVersion: 1,
      workerEligible: false,
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
    });

    await worker.runOnce();

    const job = await store.getJob('legacy-job');
    expect(job.status).toBe('waiting');
    expect(job.workerOwner).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  test('recovers a stale polling job by querying the original provider task id', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const provider = {
      generate: jest.fn(),
      resume: jest.fn(async (request) => ({
        taskId: request.providerTaskId,
        status: 'success',
        images: [{ url: 'https://example.test/recovered.png' }],
      })),
    };
    const recordUsage = jest.fn(async () => ({ durableAccepted: true, ledgerPersisted: true }));

    await createBaseJob(store, {
      internalTaskId: 'job-polling-recovery',
      requestId: 'request-polling-recovery',
    });
    await store.updateJob({
      internalTaskId: 'job-polling-recovery',
      updates: {
        status: 'polling',
        submittedToProvider: true,
        usageRecorded: true,
        providerTaskId: 'provider-task-existing',
        providerStatus: 'IN_PROGRESS',
        providerAcceptedAt: new Date(Date.now() - 5000),
        workerOwner: 'dead-worker',
        workerLeaseUntil: new Date(Date.now() - 1000),
      },
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-b',
      store,
      provider,
      recordUsage,
    });

    await worker.runOnce();

    const job = await store.getJob('job-polling-recovery');
    expect(provider.generate).not.toHaveBeenCalled();
    expect(provider.resume).toHaveBeenCalledWith(
      expect.objectContaining({
        internalTaskId: 'job-polling-recovery',
        providerTaskId: 'provider-task-existing',
      }),
    );
    expect(job.status).toBe('succeeded');
    expect(job.providerTaskId).toBe('provider-task-existing');
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'submitted',
      }),
    );
  });

  test('marks stale submitting without a provider task id as status_unknown without resubmitting', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const provider = {
      generate: jest.fn(),
      resume: jest.fn(),
    };
    const recordUsage = jest.fn(async () => ({ _id: 'usage-unknown' }));

    await createBaseJob(store, {
      internalTaskId: 'job-submitting-recovery',
      requestId: 'request-submitting-recovery',
    });
    await store.updateJob({
      internalTaskId: 'job-submitting-recovery',
      updates: {
        status: 'submitting',
        submittedToProvider: false,
        providerTaskId: null,
        workerOwner: 'dead-worker',
        workerLeaseUntil: new Date(Date.now() - 1000),
      },
    });

    const worker = createAPIMartImg2JobWorker({
      workerId: 'worker-b',
      store,
      provider,
      recordUsage,
    });

    await worker.runOnce();

    const job = await store.getJob('job-submitting-recovery');
    expect(provider.generate).not.toHaveBeenCalled();
    expect(provider.resume).not.toHaveBeenCalled();
    expect(job.status).toBe('status_unknown');
    expect(job.submittedToProvider).toBe(true);
    expect(job.providerTaskId).toBeNull();
    expect(job.workerOwner).toBeNull();
    expect(job.workerLeaseUntil).toBeNull();
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-submitting-recovery',
        status: 'status_unknown',
        providerTaskId: null,
      }),
    );
  });

  test('resumes after a polling crash without submitting a second provider task or double-recording usage', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const gate = createDeferred();
    const provider = {
      generate: jest.fn(async (request) => {
        await request.onProviderTaskSubmitted({
          providerTaskId: 'provider-task-once',
          providerStatus: 'IN_PROGRESS',
        });
        await gate.promise;
        return {
          taskId: 'provider-task-once',
          status: 'success',
          images: [{ url: 'https://example.test/late.png' }],
        };
      }),
      resume: jest.fn(async (request) => ({
        taskId: request.providerTaskId,
        status: 'success',
        images: [{ url: 'https://example.test/recovered.png' }],
      })),
    };
    const recordUsage = jest.fn(async () => ({ durableAccepted: true, ledgerPersisted: true }));

    await createBaseJob(store, {
      internalTaskId: 'job-submit-once',
      requestId: 'request-submit-once',
    });

    const firstWorker = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
      recordUsage,
      jobLeaseMs: 25,
      providerLeaseMs: 25,
      heartbeatIntervalMs: 10_000,
    });
    const secondWorker = createAPIMartImg2JobWorker({
      workerId: 'worker-b',
      store,
      provider,
      recordUsage,
      jobLeaseMs: 25,
      providerLeaseMs: 25,
      heartbeatIntervalMs: 10_000,
    });

    const firstRun = firstWorker.runOnce();
    await waitForWorkerTick();
    await sleep(40);

    await secondWorker.runOnce();
    gate.resolve();
    await firstRun;

    const job = await store.getJob('job-submit-once');
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.resume).toHaveBeenCalledTimes(1);
    expect(job.status).toBe('succeeded');
    expect(job.providerTaskId).toBe('provider-task-once');
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-submit-once',
        status: 'submitted',
        providerTaskId: 'provider-task-once',
      }),
    );
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-submit-once',
        status: 'succeeded',
        providerTaskId: 'provider-task-once',
      }),
    );
  });

  test('allows only one worker to claim a stale polling recovery job', async () => {
    const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
    const resumeGate = createDeferred();
    const provider = {
      generate: jest.fn(),
      resume: jest.fn(async (request) => {
        await resumeGate.promise;
        return {
          taskId: request.providerTaskId,
          status: 'success',
          images: [{ url: 'https://example.test/recovered.png' }],
        };
      }),
    };

    await createBaseJob(store, {
      internalTaskId: 'job-single-claim',
      requestId: 'request-single-claim',
    });
    await store.updateJob({
      internalTaskId: 'job-single-claim',
      updates: {
        status: 'polling',
        submittedToProvider: true,
        usageRecorded: true,
        providerTaskId: 'provider-single-claim',
        workerOwner: 'dead-worker',
        workerLeaseUntil: new Date(Date.now() - 1000),
      },
    });

    const workerA = createAPIMartImg2JobWorker({
      workerId: 'worker-a',
      store,
      provider,
    });
    const workerB = createAPIMartImg2JobWorker({
      workerId: 'worker-b',
      store,
      provider,
    });

    const runA = workerA.runOnce();
    const runB = workerB.runOnce();
    await waitForWorkerTick();
    expect(provider.resume).toHaveBeenCalledTimes(1);

    resumeGate.resolve();
    await Promise.all([runA, runB]);

    const job = await store.getJob('job-single-claim');
    expect(provider.generate).not.toHaveBeenCalled();
    expect(provider.resume).toHaveBeenCalledTimes(1);
    expect(job.status).toBe('succeeded');
  });
});

describe('usage delivery failures do not change paid provider outcomes', () => {
  test.each(['null', 'submitted-only', 'throws', 'durable-only'])(
    '%s leaves successful image available without resubmitting or claiming final ledger success',
    async (mode) => {
      const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
      const provider = createAcceptedAPIMartProvider();
      await createBaseJob(store);
      const recordUsage = async ({ status }) => {
        if (mode === 'throws' && status === 'succeeded') throw new Error('ledger unavailable');
        if (mode === 'durable-only') return { durableAccepted: true, ledgerPersisted: false };
        if (mode === 'submitted-only' && status === 'submitted')
          return { durableAccepted: true, ledgerPersisted: true };
        return null;
      };
      const worker = createAPIMartImg2JobWorker({ workerId: 'test', store, provider, recordUsage });
      await worker.runOnce();
      const job = await store.getJob('job-1');
      expect(job.status).toBe('succeeded');
      expect(job.result.images).toHaveLength(1);
      expect(job.usageRecorded).toBe(false);
      expect(job.usageDelivery.state).toBe(mode === 'durable-only' ? 'durable' : 'pending');
      expect(job.usageDelivery.revision).toBe(1);
      await worker.runOnce();
      expect(provider.calls).toHaveLength(1);
    },
  );
});

test('usage admission failure prevents an APIMart paid submission', async () => {
  const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
  await createBaseJob(store);
  const provider = createAcceptedAPIMartProvider();
  const worker = createAPIMartImg2JobWorker({
    workerId: 'admission',
    store,
    provider,
    admitUsage: async () => {
      throw Object.assign(new Error('capacity exhausted'), {
        code: 'USAGE_CAPTURE_UNAVAILABLE',
        statusCode: 503,
      });
    },
  });
  await worker.runOnce();
  expect(provider.calls).toHaveLength(0);
  expect((await store.getJob('job-1')).submittedToProvider).toBe(false);
});

test('lost source ownership at admission prevents an APIMart submission', async () => {
  const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
  await createBaseJob(store);
  const update = store.updateJob;
  store.updateJob = async (input) => (input.updates.status === 'submitting' ? null : update(input));
  const provider = createAcceptedAPIMartProvider();
  await createAPIMartImg2JobWorker({
    workerId: 'fenced',
    store,
    provider,
    admitUsage: async () => null,
  }).runOnce();
  expect(provider.calls).toHaveLength(0);
});

describe('APIMart terminal adapter response releases worker capacity', () => {
  const { generateImage } = require('./adapters/apimart/gptImage2');
  const originalFetch = global.fetch;
  const originalKey = process.env.APIMART_API_KEY;
  const originalTimeout = process.env.APIMART_IMAGE_TIMEOUT_MS;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.APIMART_API_KEY = 'test-key';
    process.env.APIMART_IMAGE_TIMEOUT_MS = '50';
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.APIMART_API_KEY;
    else process.env.APIMART_API_KEY = originalKey;
    if (originalTimeout === undefined) delete process.env.APIMART_IMAGE_TIMEOUT_MS;
    else process.env.APIMART_IMAGE_TIMEOUT_MS = originalTimeout;
  });

  test.each(['failed', 'cancelled', 'canceled', 'nested-failed'])(
    'a confirmed %s ends immediately and the next queued job can run',
    async (status) => {
      let submissions = 0;
      global.fetch = jest.fn(async (url, options) => {
        let body;
        if (options.method === 'POST') {
          submissions += 1;
          body = { task_id: `provider-${submissions}` };
        } else if (url.endsWith('/provider-1')) {
          const failure = {
            status: status === 'nested-failed' ? 'failed' : status,
            error: { code: 'UPSTREAM_REJECTED', message: 'request rejected' },
          };
          body =
            status === 'nested-failed' ? { code: 200, message: 'success', data: failure } : failure;
        } else {
          body = { status: 'completed', data: { url: 'https://example.test/result.png' } };
        }
        return new Response(JSON.stringify(body), { status: 200 });
      });
      const store = createInMemoryAPIMartImg2JobStore({ maxConcurrency: 1 });
      await createBaseJob(store, { internalTaskId: 'terminal-job', requestId: 'terminal-request' });
      await createBaseJob(store, { internalTaskId: 'next-job', requestId: 'next-request' });
      const recordUsage = jest.fn(async () => ({ durableAccepted: true, ledgerPersisted: true }));
      const worker = createAPIMartImg2JobWorker({
        workerId: 'terminal-worker',
        store,
        provider: { generate: generateImage },
        recordUsage,
      });
      const startedAt = Date.now();
      const first = worker.runOnce().then(() => Date.now() - startedAt);
      await jest.advanceTimersByTimeAsync(3000);
      expect(await first).toBe(0);
      expect(await store.getJob('terminal-job')).toMatchObject({
        status: 'failed',
        providerStatus: status === 'nested-failed' ? 'failed' : status,
        errorCode: 'UPSTREAM_REJECTED',
        providerErrorCode: 'UPSTREAM_REJECTED',
        error: 'request rejected',
        submittedToProvider: true,
        workerOwner: null,
        nextPollAt: null,
      });
      expect(await store.getCurrentConcurrency()).toBe(0);
      expect(recordUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          requestId: 'terminal-request',
          status: 'failed',
          providerTaskId: 'provider-1',
        }),
      );
      await worker.runOnce();
      expect((await store.getJob('next-job')).status).toBe('succeeded');
      expect(submissions).toBe(2);
      expect(global.fetch).toHaveBeenCalledTimes(4);
      expect(await store.getCurrentConcurrency()).toBe(0);
    },
  );
});
