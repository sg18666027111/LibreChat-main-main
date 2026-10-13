const {
  createAPIMartImg2JobWorker,
  createInMemoryAPIMartImg2JobStore,
} = require('./apimartImg2JobWorker');
const { submitImageTask } = require('./adapters/apimart/common');

function worker(store, provider, workerId = 'worker-a', extra = {}) {
  return createAPIMartImg2JobWorker({
    store,
    provider,
    workerId,
    heartbeatIntervalMs: 0,
    resolveJobPayload: async (job) => job.payload,
    cleanupJobPayload: async () => {},
    ...extra,
  });
}

function addJob(store, internalTaskId, extra = {}) {
  return store.createJob({
    internalTaskId,
    requestId: internalTaskId,
    userId: 'user-1',
    provider: 'apimart',
    model: 'gpt-image-2',
    payload: { model: 'gpt-image-2', prompt: 'local fixture' },
    ...extra,
  });
}

function successfulProvider() {
  return {
    generate: jest.fn(async (request) => {
      const taskId = `provider-${request.internalTaskId}`;
      await request.onProviderTaskSubmitted({ providerTaskId: taskId });
      return { taskId, images: [{ url: `https://example.test/${taskId}.png` }] };
    }),
    resume: jest.fn(),
  };
}

describe('APIMart V2 unknown submission local capacity', () => {
  test('A/G: an existing unknown without task ID cannot starve a later waiting job', async () => {
    const store = createInMemoryAPIMartImg2JobStore();
    const provider = successfulProvider();
    await addJob(store, 'unknown', {
      status: 'status_unknown',
      submittedToProvider: true,
      providerTaskId: null,
    });
    await addJob(store, 'next');
    await worker(store, provider).runOnce();
    expect((await store.getJob('next')).status).toBe('succeeded');
    expect(provider.generate.mock.calls.map(([request]) => request.internalTaskId)).toEqual([
      'next',
    ]);
    expect((await store.getJob('unknown')).status).toBe('status_unknown');
  });

  test('B: repeated and concurrent ticks never resubmit an unknown without task ID', async () => {
    const store = createInMemoryAPIMartImg2JobStore();
    const provider = successfulProvider();
    await addJob(store, 'unknown', {
      status: 'status_unknown',
      submittedToProvider: true,
      providerTaskId: null,
    });
    const a = worker(store, provider);
    const b = worker(store, provider, 'worker-b');
    for (let i = 0; i < 3; i++) {
      await Promise.all([a.runOnce(), a.runOnce(), b.runOnce()]);
    }
    expect(provider.generate).not.toHaveBeenCalled();
    expect(provider.resume).not.toHaveBeenCalled();
    expect((await store.getJob('unknown')).status).toBe('status_unknown');
  });

  test.each(['status_unknown', 'submitted', 'polling'])(
    'C/D/E: %s with an ID retains active capacity',
    async (status) => {
      const store = createInMemoryAPIMartImg2JobStore();
      const provider = successfulProvider();
      await addJob(store, 'known', {
        status,
        submittedToProvider: true,
        providerTaskId: 'known-provider-id',
        nextPollAt: new Date(Date.now() + 60_000),
      });
      await addJob(store, 'next');
      await worker(store, provider).runOnce();
      expect((await store.getJob('next')).status).toBe('waiting');
      expect((await store.getJob('known')).status).toBe(status);
      expect(provider.generate).not.toHaveBeenCalled();
      expect(
        await store.acquireProviderPermit({ ownerId: 'probe', internalTaskId: 'next' }),
      ).toBeNull();
    },
  );

  test('F/J: stale submit recovery records one durable unknown audit and never resubmits', async () => {
    const rawStore = createInMemoryAPIMartImg2JobStore();
    const store = { ...rawStore, updateJob: jest.fn(rawStore.updateJob) };
    const provider = successfulProvider();
    const recordUsage = jest.fn(async () => ({ _id: 'usage-unknown' }));
    await addJob(store, 'stale', { status: 'submitting', providerTaskId: null });
    const a = worker(store, provider, 'worker-a', { recordUsage });
    const b = worker(store, provider, 'worker-b', { recordUsage });
    await Promise.all([a.runOnce(), b.runOnce(), a.runOnce()]);
    const first = await store.getJob('stale');
    await Promise.all([a.runOnce(), b.runOnce()]);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(
      store.updateJob.mock.calls.filter(([args]) => args.updates.status === 'status_unknown'),
    ).toHaveLength(1);
    expect(await store.getJob('stale')).toMatchObject({
      status: 'status_unknown',
      submittedToProvider: true,
      providerTaskId: null,
      providerOutcomeUnknown: true,
      manualReviewRequired: true,
      neverResubmit: true,
      localCapacityReleasedAt: expect.any(Date),
      localCapacityReleaseReason: 'status_unknown_without_provider_task_id',
      errorCode: 'APIMART_IMG2_SUBMIT_RECOVERY_UNKNOWN',
      statusUnknownAt: first.statusUnknownAt,
    });
  });

  test('I: a stale worker late completion cannot attach to the next job or release its permit', async () => {
    let current = new Date();
    const store = createInMemoryAPIMartImg2JobStore({ now: () => current });
    const pending = new Map();
    const provider = {
      generate: jest.fn(
        (request) =>
          new Promise((resolve) => {
            pending.set(request.internalTaskId, { request, resolve });
          }),
      ),
    };
    await addJob(store, 'old');
    await addJob(store, 'next');
    const oldRun = worker(store, provider, 'old-worker', {
      jobLeaseMs: 100,
      providerLeaseMs: 100,
    }).runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending.has('old')).toBe(true);
    current = new Date(current.getTime() + 200);
    await worker(store, provider, 'recovery-worker').runOnce();
    const unknown = await store.getJob('old');
    expect(unknown.status).toBe('status_unknown');
    const nextRun = worker(store, provider, 'next-worker').runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    const nextPending = pending.get('next');
    expect(nextPending).toBeDefined();
    await nextPending.request.onProviderTaskSubmitted({ providerTaskId: 'next-provider-id' });
    const next = await store.getJob('next');
    pending
      .get('old')
      .resolve({ taskId: 'late-old-id', images: [{ url: 'https://example.test/old.png' }] });
    await oldRun;
    expect(await store.getJob('old')).toEqual(unknown);
    expect(await store.getJob('next')).toEqual(next);
    expect(await store.getCurrentConcurrency()).toBe(1);
    nextPending.resolve({
      taskId: 'next-provider-id',
      images: [{ url: 'https://example.test/next.png' }],
    });
    await nextRun;
    expect(await store.getJob('next')).toMatchObject({
      status: 'succeeded',
      providerTaskId: 'next-provider-id',
    });
    expect(provider.generate.mock.calls.map(([request]) => request.internalTaskId)).toEqual([
      'old',
      'next',
    ]);
  });

  test('H/I: a real submit client timeout releases local capacity without resubmit or late-result cross-binding', async () => {
    const originalFetch = global.fetch;
    const savedEnv = { ...process.env };
    process.env.APIMART_API_KEY = 'local-test-key';
    process.env.APIMART_IMAGE_BASE_URL = 'https://example.test/v1';
    process.env.APIMART_IMAGE_SUBMIT_TIMEOUT_MS = '10';
    const creates = [];
    global.fetch = jest.fn(async (url, options) => {
      creates.push({ url, method: options.method });
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            const error = new Error('local client aborted after request started');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
    });
    try {
      const store = createInMemoryAPIMartImg2JobStore();
      const accepted = successfulProvider();
      let orphanCallbacks;
      let markNextStarted;
      const nextStarted = new Promise((resolve) => {
        markNextStarted = resolve;
      });
      let finishNext;
      const nextFinished = new Promise((resolve) => {
        finishNext = resolve;
      });
      const provider = {
        generate: jest.fn(async (request) => {
          if (request.internalTaskId === 'orphan') {
            orphanCallbacks = request;
            return submitImageTask(request, request);
          }
          const result = await accepted.generate(request);
          markNextStarted();
          await nextFinished;
          return result;
        }),
      };
      const recordUsage = jest.fn(async () => ({ _id: 'usage' }));
      await addJob(store, 'orphan');
      await addJob(store, 'next');
      const a = worker(store, provider, 'worker-a', { recordUsage });
      await a.runOnce();
      const orphan = await store.getJob('orphan');
      expect(creates).toEqual([
        { url: 'https://example.test/v1/images/generations', method: 'POST' },
      ]);
      expect(orphan).toMatchObject({
        status: 'status_unknown',
        submittedToProvider: true,
        providerTaskId: null,
        errorCode: 'APIMART_IMAGE_SUBMIT_TIMEOUT',
      });
      const nextRun = a.runOnce();
      await Promise.race([nextStarted, nextRun]);
      const nextWhilePolling = await store.getJob('next');
      expect(nextWhilePolling.status).toBe('polling');
      expect(await store.getCurrentConcurrency()).toBe(1);
      await orphanCallbacks.onProviderTaskSubmitted({ providerTaskId: 'late-orphan-provider-id' });
      await orphanCallbacks.onProviderPoll({
        providerTaskId: 'late-orphan-provider-id',
        providerStatus: 'completed',
      });
      expect(await store.getJob('next')).toEqual(nextWhilePolling);
      expect(await store.getJob('orphan')).toEqual(orphan);
      expect(await store.getCurrentConcurrency()).toBe(1);
      finishNext();
      await nextRun;
      await Promise.all([a.runOnce(), worker(store, provider, 'worker-b').runOnce()]);
      expect(
        provider.generate.mock.calls.filter(([request]) => request.internalTaskId === 'orphan'),
      ).toHaveLength(1);
      expect(await store.getJob('next')).toMatchObject({
        status: 'succeeded',
        providerTaskId: 'provider-next',
        result: {
          taskId: 'provider-next',
          images: [{ url: 'https://example.test/provider-next.png' }],
        },
      });
      expect(orphan).toMatchObject({
        providerOutcomeUnknown: true,
        manualReviewRequired: true,
        neverResubmit: true,
        localCapacityReleasedAt: expect.any(Date),
        localCapacityReleaseReason: 'status_unknown_without_provider_task_id',
      });
      expect(await store.getCurrentConcurrency()).toBe(0);
    } finally {
      global.fetch = originalFetch;
      for (const key of [
        'APIMART_API_KEY',
        'APIMART_IMAGE_BASE_URL',
        'APIMART_IMAGE_SUBMIT_TIMEOUT_MS',
      ]) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }
  });
});
