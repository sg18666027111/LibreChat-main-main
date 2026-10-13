const mockGetImageGenerationJob = jest.fn();

jest.mock('~/models', () => ({
  getImageGenerationJob: mockGetImageGenerationJob,
}));

const {
  findOrStageAndEnqueueImageEgressJob,
  getImageEgressAsyncMode,
  getImageEgressCanaryUserIds,
  getImageEgressJobStatus,
  getImageEgressMaxConcurrency,
  getImageEgressWorkerRolloutModes,
  isImageEgressAsyncResolvedModel,
  shouldStartImageEgressWorker,
  shouldUseImageEgressAsyncForUser,
  startImageEgressWorker,
} = require('./imageEgressAsync');

describe('image egress public task state', () => {
  beforeEach(() => {
    mockGetImageGenerationJob.mockReset();
  });

  it('exposes only an authenticated result route for success', async () => {
    mockGetImageGenerationJob.mockResolvedValue({
      internalTaskId: 'egress-1',
      requestId: 'request-1',
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
      status: 'succeeded',
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
      submittedToProvider: true,
      providerTaskId: 'fal-request-1',
      providerMetadata: {
        pendingOutputUrl: 'https://signed.example/output.png?token=secret',
      },
      result: { fileRef: { fileId: 'output-1' } },
    });

    const status = await getImageEgressJobStatus({
      internalTaskId: 'egress-1',
      userId: 'user-1',
    });
    expect(status).toEqual(
      expect.objectContaining({
        state: 'success',
        images: [
          {
            url: '/api/image-generation/tasks/egress-1/result-image',
            downloadUrl: '/api/image-generation/tasks/egress-1/result-image',
          },
        ],
      }),
    );
    expect(JSON.stringify(status)).not.toContain('signed.example');
    expect(JSON.stringify(status)).not.toContain('token=secret');
  });

  it('maps status_unknown to an explicit retryable terminal failure', async () => {
    mockGetImageGenerationJob.mockResolvedValue({
      internalTaskId: 'egress-unknown',
      requestId: 'request-unknown',
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
      status: 'status_unknown',
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
      errorCode: 'IMAGE_EGRESS_SUBMIT_RESULT_UNKNOWN',
      error: 'Provider submit result is unknown.',
    });
    await expect(
      getImageEgressJobStatus({ internalTaskId: 'egress-unknown', userId: 'user-1' }),
    ).resolves.toEqual(
      expect.objectContaining({
        state: 'status_unknown',
        errorCode: 'IMAGE_EGRESS_SUBMIT_RESULT_UNKNOWN',
        retryableByUser: true,
      }),
    );
  });

  it('does not claim a v2 task as v3', async () => {
    mockGetImageGenerationJob.mockResolvedValue({
      internalTaskId: 'v2-1',
      asyncVersion: 2,
      status: 'polling',
    });
    await expect(
      getImageEgressJobStatus({ internalTaskId: 'v2-1', userId: 'user-1' }),
    ).resolves.toBeNull();
  });
});

describe('image egress rollout gate', () => {
  it.each([
    [{}, 'off'],
    [{ IMAGE_EGRESS_ASYNC_MODE: 'invalid' }, 'off'],
    [{ IMAGE_EGRESS_ASYNC_MODE: 'CANARY' }, 'canary'],
    [{ IMAGE_EGRESS_ASYNC_MODE: 'all' }, 'all'],
  ])('normalizes runtime mode', (env, expected) => {
    expect(getImageEgressAsyncMode(env)).toBe(expected);
  });

  it('parses canary users and gates selection', () => {
    const env = {
      IMAGE_EGRESS_ASYNC_MODE: 'canary',
      IMAGE_EGRESS_ASYNC_CANARY_USER_IDS: 'user-1, user-2\nuser-3',
    };
    expect([...getImageEgressCanaryUserIds(env)]).toEqual(['user-1', 'user-2', 'user-3']);
    expect(shouldUseImageEgressAsyncForUser({ userId: 'user-2', env })).toBe('canary');
    expect(shouldUseImageEgressAsyncForUser({ userId: 'denied', env })).toBeNull();
    expect(
      shouldUseImageEgressAsyncForUser({
        userId: 'any',
        env: { IMAGE_EGRESS_ASYNC_MODE: 'all' },
      }),
    ).toBe('all');
  });

  it('uses bounded concurrency 1 by default and rejects invalid values', () => {
    expect(getImageEgressMaxConcurrency({})).toBe(1);
    expect(getImageEgressMaxConcurrency({ IMAGE_EGRESS_MAX_CONCURRENCY: '0' })).toBe(1);
    expect(getImageEgressMaxConcurrency({ IMAGE_EGRESS_MAX_CONCURRENCY: '3' })).toBe(3);
    expect(getImageEgressMaxConcurrency({ IMAGE_EGRESS_MAX_CONCURRENCY: '3junk' })).toBe(1);
  });

  it('claims canary only in canary mode and canary plus all after promotion', () => {
    expect(
      getImageEgressWorkerRolloutModes({
        IMAGE_EGRESS_ASYNC_MODE: 'canary',
        IMAGE_EGRESS_ASYNC_CANARY_USER_IDS: 'user-1',
      }),
    ).toEqual(['canary']);
    expect(getImageEgressWorkerRolloutModes({ IMAGE_EGRESS_ASYNC_MODE: 'all' })).toEqual([
      'canary',
      'all',
    ]);
    expect(getImageEgressWorkerRolloutModes({ IMAGE_EGRESS_ASYNC_MODE: 'off' })).toEqual([]);
  });

  it('does not start a worker or claim when off', () => {
    const createWorker = jest.fn();
    expect(shouldStartImageEgressWorker({ IMAGE_EGRESS_ASYNC_MODE: 'off' })).toBe(false);
    expect(
      startImageEgressWorker({
        env: { IMAGE_EGRESS_ASYNC_MODE: 'off' },
        deps: { createWorker },
      }),
    ).toBeNull();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('waits for storage/index preflight before the first claim', async () => {
    let releaseInitialization;
    const initializeStorage = jest.fn(
      () => new Promise((resolve) => (releaseInitialization = resolve)),
    );
    const runOnce = jest.fn(async () => null);
    const controller = startImageEgressWorker({
      env: {
        IMAGE_EGRESS_ASYNC_MODE: 'canary',
        IMAGE_EGRESS_ASYNC_CANARY_USER_IDS: 'user-1',
      },
      intervalMs: 60_000,
      deps: { initializeStorage, createWorker: () => ({ runOnce }) },
    });
    const tick = controller.runTick();
    await Promise.resolve();
    expect(initializeStorage).toHaveBeenCalledTimes(1);
    expect(runOnce).not.toHaveBeenCalled();
    releaseInitialization();
    await tick;
    expect(runOnce).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('retries a transient storage/index preflight failure on a later tick', async () => {
    const initializeStorage = jest
      .fn()
      .mockRejectedValueOnce(new Error('mongo unavailable'))
      .mockResolvedValueOnce(undefined);
    const runOnce = jest.fn(async () => null);
    const controller = startImageEgressWorker({
      env: {
        IMAGE_EGRESS_ASYNC_MODE: 'canary',
        IMAGE_EGRESS_ASYNC_CANARY_USER_IDS: 'user-1',
      },
      intervalMs: 60_000,
      deps: { initializeStorage, createWorker: () => ({ runOnce }) },
    });

    await controller.runTick();
    expect(runOnce).not.toHaveBeenCalled();
    await controller.runTick();
    expect(initializeStorage).toHaveBeenCalledTimes(2);
    expect(runOnce).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it.each([
    ['fal', 'openai/gpt-image-2'],
    ['fal', 'openai/gpt-image-2/edit'],
    ['apimart', 'gemini-3.1-flash-image-preview'],
    ['apimart', 'gemini-2.5-flash-image-preview'],
  ])('selects the approved v3 allowset entry %s/%s', (provider, model) => {
    expect(isImageEgressAsyncResolvedModel({ provider, model })).toBe(true);
  });

  it.each([
    ['apimart', 'gpt-image-2'],
    ['ark', 'doubao-seedream-5-0-pro-260628'],
    ['siliconflow', 'Qwen/Qwen-Image'],
  ])('keeps %s/%s outside v3', (provider, model) => {
    expect(isImageEgressAsyncResolvedModel({ provider, model })).toBe(false);
  });
});

describe('findOrStageAndEnqueueImageEgressJob', () => {
  function createHarness(overrides = {}) {
    const calls = [];
    const refs = [{ fileId: 'input-file-1', bytes: 10, contentType: 'image/png' }];
    const inputStorage = {
      stage: jest.fn(async () => {
        calls.push('stage');
        return { refs, stagingBatchId: 'stage-1' };
      }),
      promote: jest.fn(async () => {
        calls.push('promote');
        return { promotedFileIds: ['input-file-1'] };
      }),
      cleanup: jest.fn(async () => {
        calls.push('cleanup');
      }),
      ...overrides.inputStorage,
    };
    const jobStore = {
      findByIdentity: jest.fn(async () => {
        calls.push('find');
        return null;
      }),
      createJob: jest.fn(async (input) => {
        calls.push('create');
        return { ...input };
      }),
      failUnusableJob: jest.fn(async () => {
        calls.push('fail');
        return { status: 'failed' };
      }),
      failInactiveJob: jest.fn(async () => {
        calls.push('fail-inactive');
        return { status: 'failed', workerEligible: true };
      }),
      activateJob: jest.fn(async (input) => {
        calls.push('activate');
        return { ...input.job, workerEligible: true };
      }),
      ...overrides.jobStore,
    };
    return { calls, inputStorage, jobStore, refs };
  }

  function enqueue(harness, extra = {}) {
    return findOrStageAndEnqueueImageEgressJob({
      req: { user: { id: 'user-1' } },
      userId: 'user-1',
      tenantId: 'tenant-1',
      frontendTaskId: 'front-1',
      requestId: 'request-1',
      businessType: 'product_replacement',
      taskType: 'multi-reference',
      subMode: 'multi-reference',
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
      modelKey: 'fal_gpt_image_2_edit',
      payload: { prompt: 'edit', imageInputs: ['data:image/png;base64,AAAA'] },
      imageInputs: ['data:image/png;base64,AAAA'],
      inputMetadata: [{ index: 0 }],
      rolloutMode: 'canary',
      deps: { jobStore: harness.jobStore, inputStorage: harness.inputStorage },
      ...extra,
    });
  }

  it('rejects a job without a durable frontend or batch identity before staging', async () => {
    const harness = createHarness();

    await expect(
      enqueue(harness, { frontendTaskId: undefined, batchTaskId: undefined, itemId: undefined }),
    ).rejects.toMatchObject({ code: 'IMAGE_EGRESS_IDENTITY_REQUIRED' });
    expect(harness.inputStorage.stage).not.toHaveBeenCalled();
    expect(harness.jobStore.createJob).not.toHaveBeenCalled();
  });

  it('deduplicates before staging', async () => {
    const existing = { internalTaskId: 'existing', status: 'polling' };
    const harness = createHarness({
      jobStore: { findByIdentity: jest.fn(async () => existing) },
    });
    await expect(enqueue(harness)).resolves.toEqual({ job: existing, created: false });
    expect(harness.inputStorage.stage).not.toHaveBeenCalled();
  });

  it('reconciles a crash-window inactive job before returning the deduplicated task', async () => {
    const existing = {
      internalTaskId: 'existing',
      status: 'waiting',
      workerEligible: false,
      payload: { imageInputRefs: [{ fileId: 'existing-input' }] },
    };
    const activated = { ...existing, workerEligible: true };
    const harness = createHarness({
      jobStore: {
        findByIdentity: jest.fn(async () => existing),
        activateJob: jest.fn(async () => activated),
      },
    });

    await expect(enqueue(harness)).resolves.toEqual({ job: activated, created: false });
    expect(harness.inputStorage.promote).toHaveBeenCalledWith({
      internalTaskId: 'existing',
      refs: [{ fileId: 'existing-input' }],
    });
    expect(harness.inputStorage.stage).not.toHaveBeenCalled();
  });

  it('rejects v3 multi-output before staging because the durable result is single-output', async () => {
    const harness = createHarness();
    await expect(enqueue(harness, { payload: { prompt: 'draw', count: 2 } })).rejects.toMatchObject(
      {
        code: 'IMAGE_EGRESS_OUTPUT_COUNT_UNSUPPORTED',
        statusCode: 400,
      },
    );
    expect(harness.inputStorage.stage).not.toHaveBeenCalled();
  });

  it('stores only durable refs and promotes provisional TTL before returning', async () => {
    const harness = createHarness();
    const result = await enqueue(harness);

    expect(harness.calls).toEqual(['find', 'stage', 'create', 'promote', 'activate']);
    expect(result.created).toBe(true);
    expect(result.job).toEqual(
      expect.objectContaining({
        asyncVersion: 3,
        workerFamily: 'image-egress-v1',
        workerEligible: true,
        rolloutMode: 'canary',
        payload: expect.objectContaining({ imageInputRefs: harness.refs }),
      }),
    );
    const serialized = JSON.stringify(result.job);
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('base64');
    expect(harness.inputStorage.promote).toHaveBeenCalledWith(
      expect.objectContaining({ internalTaskId: result.job.internalTaskId, refs: harness.refs }),
    );
    expect(harness.jobStore.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ workerEligible: false }),
    );
  });

  it('cleans a duplicate-race loser and returns the winner', async () => {
    const winner = { internalTaskId: 'winner', status: 'waiting' };
    const duplicate = Object.assign(new Error('duplicate'), { code: 11000 });
    const harness = createHarness({
      jobStore: {
        findByIdentity: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
        createJob: jest.fn(async () => {
          throw duplicate;
        }),
      },
    });

    await expect(enqueue(harness)).resolves.toEqual({ job: winner, created: false });
    expect(harness.inputStorage.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ refs: harness.refs }),
    );
  });

  it('cleans all staged refs after any create failure', async () => {
    const harness = createHarness({
      jobStore: {
        createJob: jest.fn(async () => {
          throw new Error('database unavailable');
        }),
      },
    });
    await expect(enqueue(harness)).rejects.toThrow('database unavailable');
    expect(harness.inputStorage.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ refs: harness.refs }),
    );
  });

  it('terminalizes an unusable created job and cleans refs when promotion fails', async () => {
    const harness = createHarness({
      inputStorage: {
        promote: jest.fn(async () => {
          throw Object.assign(new Error('promotion failed'), {
            code: 'IMAGE_EGRESS_INPUT_OWNERSHIP_FAILED',
          });
        }),
      },
    });
    await expect(enqueue(harness)).rejects.toMatchObject({
      code: 'IMAGE_EGRESS_INPUT_OWNERSHIP_FAILED',
    });
    expect(harness.jobStore.failUnusableJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'IMAGE_EGRESS_INPUT_OWNERSHIP_FAILED' }),
    );
    expect(harness.inputStorage.cleanup).toHaveBeenCalled();
  });

  it('keeps a promotion-failed job worker-eligible until staged input cleanup is durable', async () => {
    const promotionError = Object.assign(new Error('promotion failed'), {
      code: 'IMAGE_EGRESS_INPUT_OWNERSHIP_FAILED',
    });
    const harness = createHarness({
      inputStorage: {
        promote: jest.fn(async () => {
          throw promotionError;
        }),
        cleanup: jest.fn(async () => {
          throw Object.assign(new Error('cleanup metadata unavailable'), {
            code: 'IMAGE_EGRESS_INPUT_CLEANUP_NOT_DURABLE',
          });
        }),
      },
    });

    await expect(enqueue(harness)).rejects.toBe(promotionError);
    expect(harness.jobStore.failInactiveJob).toHaveBeenCalledTimes(1);
    expect(harness.jobStore.failInactiveJob).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'IMAGE_EGRESS_INPUT_OWNERSHIP_FAILED',
      }),
    );
  });

  it('does not clean promoted inputs when the inactive terminalization outcome is unknown', async () => {
    const promotionError = Object.assign(new Error('promotion failed'), {
      code: 'IMAGE_EGRESS_INPUT_OWNERSHIP_FAILED',
    });
    const terminalWriteError = new Error('job database unavailable');
    const harness = createHarness({
      inputStorage: {
        promote: jest.fn(async () => {
          throw promotionError;
        }),
      },
      jobStore: {
        failInactiveJob: jest.fn(async () => {
          throw terminalWriteError;
        }),
      },
    });

    await expect(enqueue(harness)).rejects.toBe(promotionError);
    expect(harness.jobStore.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ workerEligible: false }),
    );
    expect(harness.jobStore.activateJob).not.toHaveBeenCalled();
    expect(harness.inputStorage.cleanup).not.toHaveBeenCalled();
  });

  it('confirms an ambiguous idempotent activation without cleaning possibly-owned inputs', async () => {
    const activated = { internalTaskId: 'activated', status: 'waiting', workerEligible: true };
    const harness = createHarness({
      jobStore: {
        findByIdentity: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(activated),
        activateJob: jest.fn(async () => {
          throw new Error('Mongo response lost');
        }),
      },
    });

    await expect(enqueue(harness)).resolves.toEqual({ job: activated, created: true });
    expect(harness.jobStore.activateJob).toHaveBeenCalledTimes(2);
    expect(harness.inputStorage.cleanup).not.toHaveBeenCalled();
    expect(harness.jobStore.failUnusableJob).not.toHaveBeenCalled();
  });

  it('does not clean inputs when an ambiguous activation was already claimed by a worker', async () => {
    const submitting = {
      internalTaskId: 'claimed',
      status: 'submitting',
      workerEligible: true,
      workerOwner: 'worker-1',
    };
    const harness = createHarness({
      jobStore: {
        findByIdentity: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(submitting),
        activateJob: jest
          .fn()
          .mockRejectedValueOnce(new Error('Mongo response lost'))
          .mockResolvedValueOnce(null),
      },
    });

    await expect(enqueue(harness)).resolves.toEqual({ job: submitting, created: true });
    expect(harness.inputStorage.cleanup).not.toHaveBeenCalled();
    expect(harness.jobStore.failUnusableJob).not.toHaveBeenCalled();
  });

  it('terminalizes a confirmed inactive activation instead of returning a stuck queued job', async () => {
    const inactive = { internalTaskId: 'inactive', status: 'waiting', workerEligible: false };
    const harness = createHarness({
      jobStore: {
        findByIdentity: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(inactive),
        activateJob: jest.fn(async () => {
          throw new Error('Mongo unavailable');
        }),
      },
    });

    await expect(enqueue(harness)).rejects.toMatchObject({
      code: 'IMAGE_EGRESS_JOB_ACTIVATION_FAILED',
    });
    expect(harness.inputStorage.cleanup).toHaveBeenCalled();
    expect(harness.jobStore.failInactiveJob).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'IMAGE_EGRESS_JOB_ACTIVATION_FAILED',
      }),
    );
  });

  it('does not terminalize or clean after a confirmed-inactive job is concurrently activated and claimed', async () => {
    const inactive = { internalTaskId: 'raced', status: 'waiting', workerEligible: false };
    const claimed = {
      ...inactive,
      workerEligible: true,
      workerOwner: 'worker-1',
      workerLeaseUntil: new Date('2026-08-10T10:01:00.000Z'),
    };
    const harness = createHarness({
      jobStore: {
        findByIdentity: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(inactive)
          .mockResolvedValueOnce(claimed),
        activateJob: jest.fn(async () => {
          throw new Error('Mongo unavailable');
        }),
        failInactiveJob: jest.fn(async () => null),
      },
    });

    await expect(enqueue(harness)).resolves.toEqual({ job: claimed, created: true });
    expect(harness.jobStore.failInactiveJob).toHaveBeenCalledTimes(1);
    expect(harness.jobStore.failUnusableJob).not.toHaveBeenCalled();
    expect(harness.inputStorage.cleanup).not.toHaveBeenCalled();
  });
});
