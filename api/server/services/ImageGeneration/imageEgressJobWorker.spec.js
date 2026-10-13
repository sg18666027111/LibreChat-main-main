jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

const {
  createImageEgressJobWorker,
  IMAGE_EGRESS_PROVIDER_MODEL_ALLOWSET,
} = require('./imageEgressJobWorker');
const { createFalImageEgressAdapter } = require('./adapters/fal/imageEgressFalAdapter');
const { logger } = require('@librechat/data-schemas');

const TRANSIENT = Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });

test('shutdown during slot acquisition releases the slot without claiming or submitting', async () => {
  let stopping = false;
  let releaseSlotAcquisition;
  const h = createHarness({
    slotStore: {
      acquireSlot: jest.fn(
        () =>
          new Promise((resolve) => {
            releaseSlotAcquisition = resolve;
          }),
      ),
    },
    workerOptions: { shouldStop: () => stopping },
  });
  const worker = h.createWorker();
  const tick = worker.runOnce();
  stopping = true;
  releaseSlotAcquisition({ leaseId: 'slot-1' });
  await tick;
  expect(h.jobStore.claimNextJob).not.toHaveBeenCalled();
  expect(h.adapter.submit).not.toHaveBeenCalled();
  expect(h.slotStore.releaseSlot).toHaveBeenCalledTimes(1);
  await worker.runOnce();
  expect(h.slotStore.acquireSlot).toHaveBeenCalledTimes(1);
});

function cloneJob(job) {
  return job
    ? {
        ...job,
        payload: job.payload ? { ...job.payload } : job.payload,
        providerMetadata: job.providerMetadata ? { ...job.providerMetadata } : job.providerMetadata,
        result: job.result ? { ...job.result } : job.result,
      }
    : null;
}

function createHarness(overrides = {}) {
  let current = new Date('2026-08-08T10:00:00.000Z');
  const calls = [];
  const initialJob = {
    internalTaskId: 'egress-1',
    frontendTaskId: 'front-1',
    requestId: 'request-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    businessType: 'product_replacement',
    taskType: 'multi-reference',
    provider: 'fal',
    model: 'openai/gpt-image-2/edit',
    modelKey: 'fal_gpt_image_2_edit',
    asyncVersion: 3,
    workerFamily: 'image-egress-v1',
    rolloutMode: 'canary',
    workerEligible: true,
    status: 'waiting',
    submittedToProvider: false,
    usageRecorded: false,
    payload: {
      prompt: 'edit this',
      imageInputRefs: [{ fileId: 'input-1', bytes: 4 }],
    },
    queueEnteredAt: current,
    ...overrides.job,
  };
  const state = { job: initialJob };
  const jobStore = {
    updateUsageDelivery: jest.fn(async ({ revision, state: next }) => {
      if (
        state.job.usageDelivery?.revision !== revision ||
        (state.job.usageDelivery.state === 'persisted' && next !== 'persisted')
      )
        return null;
      state.job.usageDelivery = { ...state.job.usageDelivery, state: next };
      state.job.usageRecorded = next === 'persisted';
      return cloneJob(state.job);
    }),
    claimNextJob: jest.fn(async ({ workerId, statuses, rolloutModes, allowset }) => {
      calls.push('claim');
      const job = state.job;
      if (
        !job ||
        !job.workerEligible ||
        !statuses.includes(job.status) ||
        !rolloutModes.includes(job.rolloutMode) ||
        !allowset.some(({ provider, model }) => provider === job.provider && model === job.model) ||
        (job.nextAttemptAt && new Date(job.nextAttemptAt) > current)
      ) {
        return null;
      }
      job.workerOwner = workerId;
      job.workerLeaseUntil = new Date(current.getTime() + 30_000);
      return cloneJob(job);
    }),
    getJob: jest.fn(async () => cloneJob(state.job)),
    updateJob: jest.fn(async ({ updates }) => {
      calls.push(`update:${updates.status || updates.currentOperation || 'metadata'}`);
      Object.assign(state.job, updates);
      return cloneJob(state.job);
    }),
    releaseJobClaim: jest.fn(async () => {
      calls.push('release-job');
      state.job.workerOwner = null;
      state.job.workerLeaseUntil = null;
      return cloneJob(state.job);
    }),
    ...overrides.jobStore,
  };
  const slotStore = {
    acquireSlot: jest.fn(async () => {
      calls.push('slot');
      return { leaseId: 'slot-1' };
    }),
    releaseSlot: jest.fn(async () => {
      calls.push('release-slot');
      return true;
    }),
    heartbeatSlot: jest.fn(async () => ({ leaseId: 'slot-1' })),
    ...overrides.slotStore,
  };
  jobStore.heartbeatJobClaim ??= jest.fn(async () => cloneJob(state.job));
  const adapter = {
    submit: jest.fn(async () => ({
      providerTaskId: 'fal-request-1',
      providerMetadata: {
        statusUrl: 'https://queue.fal.run/status/1',
        responseUrl: 'https://queue.fal.run/result/1',
      },
      outputUrls: [],
    })),
    status: jest.fn(async () => ({ state: 'pending', providerStatus: 'IN_PROGRESS' })),
    result: jest.fn(async () => ({ outputUrls: ['https://cdn.example/output.png?token=x'] })),
    ...overrides.adapter,
  };
  const inputStorage = {
    resolve: jest.fn(async () => ({
      prompt: 'edit this',
      imageInputs: ['data:image/png;base64,AAAA'],
    })),
    cleanup: jest.fn(async () => {}),
    ...overrides.inputStorage,
  };
  const outputStorage = {
    download: jest.fn(async ({ url }) => ({
      buffer: Buffer.from('image'),
      contentType: 'image/png',
      sourceMetadata: { hostname: new URL(url).hostname, urlHash: 'safe-hash' },
    })),
    store: jest.fn(async () => ({
      fileRef: { fileId: 'output-1', contentType: 'image/png', bytes: 5 },
    })),
    cleanupUncommitted: jest.fn(async () => true),
    ...overrides.outputStorage,
  };
  const usageRows = new Map();
  const recordUsage =
    overrides.recordUsage ||
    jest.fn(async (event) => {
      const id = `${event.businessType}:${event.requestId}:${event.itemId || 'single'}`;
      usageRows.set(id, { ...event });
      return { durableAccepted: true, ledgerPersisted: true };
    });
  const retryPolicies = {
    input_read: {
      operation: 'input_read',
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitterRatio: 0,
      turnBudgetMs: 100,
    },
    status_read: {
      operation: 'status_read',
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitterRatio: 0,
      turnBudgetMs: 100,
    },
    result_read: {
      operation: 'result_read',
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitterRatio: 0,
      turnBudgetMs: 100,
    },
    output_download: {
      operation: 'output_download',
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitterRatio: 0,
      turnBudgetMs: 100,
    },
    ...overrides.retryPolicies,
  };

  function createWorker(workerId = 'worker-1') {
    return createImageEgressJobWorker({
      workerId,
      jobStore,
      slotStore,
      adapters: {
        [`${initialJob.provider}:${initialJob.model}`]: adapter,
      },
      inputStorage,
      outputStorage,
      recordUsage,
      rolloutModes: ['canary'],
      maxConcurrency: 1,
      now: () => new Date(current),
      monotonicNow: (() => {
        let value = 0;
        return () => value++;
      })(),
      sleep: jest.fn(async () => {}),
      random: () => 0.5,
      retryPolicies,
      ...overrides.workerOptions,
    });
  }

  return {
    adapter,
    calls,
    createWorker,
    inputStorage,
    jobStore,
    outputStorage,
    recordUsage,
    retryPolicies,
    slotStore,
    state,
    usageRows,
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

describe('image-egress-v1 worker isolation and recovery', () => {
  beforeEach(() => {
    logger.warn.mockClear();
  });

  it.each([
    ['job', true, false],
    ['slot', false, true],
    ['both', true, true],
  ])(
    'resumes the same provider task after %s lease release fails',
    async (_, failJob, failSlot) => {
      const harness = createHarness({
        adapter: {
          status: jest.fn(async () => ({ state: 'succeeded', providerStatus: 'COMPLETED' })),
        },
      });
      // Model the lease gates so recovery cannot depend on immediately reclaiming
      // a lease whose release failed. No database or provider is contacted.
      const claim = harness.jobStore.claimNextJob.getMockImplementation();
      harness.jobStore.claimNextJob.mockImplementation(async (args) => {
        if (harness.state.job.workerLeaseUntil > args.now) {
          return null;
        }
        return claim(args);
      });
      let slotLeaseUntil = null;
      harness.slotStore.acquireSlot.mockImplementation(async ({ now, leaseMs }) => {
        if (slotLeaseUntil > now) {
          return null;
        }
        slotLeaseUntil = new Date(now.getTime() + leaseMs);
        return { leaseId: 'slot-1' };
      });
      harness.slotStore.releaseSlot.mockImplementation(async () => {
        slotLeaseUntil = null;
        return true;
      });
      const releaseError = Object.assign(new Error('private database connection details'), {
        code: 'ETIMEDOUT',
      });
      if (failJob) {
        harness.jobStore.releaseJobClaim.mockRejectedValueOnce(releaseError);
      }
      if (failSlot) {
        harness.slotStore.releaseSlot.mockRejectedValueOnce(releaseError);
      }
      const worker = harness.createWorker();
      const firstResult = await worker.runOnce().catch((error) => error);
      await worker.runOnce();
      expect(harness.adapter.status).not.toHaveBeenCalled();

      harness.advance(120_001);
      await worker.runOnce();
      expect(harness.state.job.currentOperation).toBe('result_read');
      expect(harness.state.job.providerTaskId).toBe('fal-request-1');
      expect(harness.adapter.submit).toHaveBeenCalledTimes(1);
      expect(firstResult).toMatchObject({ status: 'polling' });
      expect(logger.warn).toHaveBeenCalledTimes(Number(failJob) + Number(failSlot));
      for (const resource of [failJob && 'job', failSlot && 'slot'].filter(Boolean)) {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ resource, errorCode: 'ETIMEDOUT' }),
        );
      }
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private database');
    },
  );

  it('still releases the slot when releasing the job claim throws synchronously', async () => {
    const harness = createHarness();
    harness.jobStore.releaseJobClaim.mockImplementationOnce(() => {
      throw new Error('release failed');
    });
    const result = await harness
      .createWorker()
      .runOnce()
      .catch((error) => error);
    expect(harness.slotStore.releaseSlot).toHaveBeenCalledWith({
      leaseId: 'slot-1',
      ownerId: 'worker-1',
      now: expect.any(Date),
    });
    expect(result).toMatchObject({ status: 'polling' });
  });

  it('can process newly available work after an idle tick fails to release its slot', async () => {
    const harness = createHarness({ job: { workerEligible: false } });
    harness.slotStore.releaseSlot.mockRejectedValueOnce(new Error('release failed'));
    const worker = harness.createWorker();
    const idleResult = await worker.runOnce().catch((error) => error);

    harness.state.job.workerEligible = true;
    harness.advance(120_001);
    await worker.runOnce();
    expect(harness.state.job.status).toBe('polling');
    expect(harness.adapter.submit).toHaveBeenCalledTimes(1);
    expect(idleResult).toBeNull();
  });

  it('preserves the processing error when both lease releases also fail', async () => {
    const harness = createHarness();
    const processingError = new Error('processing persistence failed');
    harness.jobStore.updateJob.mockRejectedValueOnce(processingError);
    harness.jobStore.releaseJobClaim.mockRejectedValueOnce(new Error('job release failed'));
    harness.slotStore.releaseSlot.mockRejectedValueOnce(new Error('slot release failed'));
    const worker = harness.createWorker();

    await expect(worker.runOnce()).rejects.toBe(processingError);
    expect(harness.slotStore.releaseSlot).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(harness.adapter.submit).not.toHaveBeenCalled();
    harness.advance(120_001);
    await worker.runOnce();
    expect(harness.state.job.status).toBe('polling');
  });

  it('does not start another turn until lease cleanup settles', async () => {
    const harness = createHarness();
    let finishRelease;
    let notifyRelease;
    const releaseStarted = new Promise((resolve) => {
      notifyRelease = resolve;
    });
    const releasePending = new Promise((resolve) => {
      finishRelease = resolve;
    });
    harness.slotStore.releaseSlot.mockImplementationOnce(() => {
      notifyRelease();
      return releasePending;
    });
    const worker = harness.createWorker();
    const firstTurn = worker.runOnce();
    try {
      await releaseStarted;
      await expect(worker.runOnce()).resolves.toBeNull();
      expect(harness.slotStore.acquireSlot).toHaveBeenCalledTimes(1);
      expect(harness.adapter.submit).toHaveBeenCalledTimes(1);
    } finally {
      finishRelease(true);
      await firstTurn;
    }
    harness.advance(120_001);
    await worker.runOnce();
    expect(harness.adapter.status).toHaveBeenCalledTimes(1);
    expect(harness.adapter.submit).toHaveBeenCalledTimes(1);
  });

  it('prepares remote inputs while waiting and submits only the prepared URLs', async () => {
    const harness = createHarness({
      adapter: {
        prepare: jest.fn(async ({ request }) => {
          expect(harness.state.job.status).toBe('waiting');
          return { ...request, imageInputs: ['https://v3b.fal.media/files/input.png'] };
        }),
      },
    });
    await harness.createWorker().runOnce();
    expect(harness.adapter.prepare).toHaveBeenCalledTimes(1);
    expect(harness.adapter.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          imageInputs: ['https://v3b.fal.media/files/input.png'],
        }),
      }),
    );
  });

  it('reschedules an upload timeout without entering ambiguous generation state', async () => {
    const harness = createHarness({
      adapter: {
        prepare: jest.fn(async () => {
          throw TRANSIENT;
        }),
      },
    });
    await harness.createWorker().runOnce();
    expect(harness.adapter.submit).not.toHaveBeenCalled();
    expect(harness.state.job.status).toBe('polling');
    expect(harness.state.job.currentOperation).toBe('input_read');
    expect(harness.state.job.providerTaskId).toBeFalsy();
    expect(harness.state.job.submittedToProvider).toBe(false);
    expect(harness.state.job.nextAttemptAt).toBeTruthy();
  });

  it('fails invalid preparation without sending a generation request', async () => {
    const harness = createHarness({
      adapter: {
        prepare: jest.fn(async () => {
          throw Object.assign(new Error('invalid upload'), {
            code: 'FAL_INPUT_UPLOAD_INVALID_IMAGE',
            statusCode: 400,
          });
        }),
      },
    });
    await harness.createWorker().runOnce();
    expect(harness.adapter.submit).not.toHaveBeenCalled();
    expect(harness.state.job.status).toBe('failed');
  });

  it('fences the worker before submit when a lease-protected update no longer matches', async () => {
    const harness = createHarness({
      jobStore: {
        updateJob: jest.fn(async ({ updates }) =>
          updates.status === 'submitting' ? null : { ...harness.state.job, ...updates },
        ),
      },
    });

    await expect(harness.createWorker().runOnce()).rejects.toMatchObject({
      code: 'IMAGE_EGRESS_LEASE_LOST',
    });
    expect(harness.adapter.submit).not.toHaveBeenCalled();
  });

  it('aborts and fences an in-flight turn when either heartbeat loses ownership', async () => {
    const submit = jest.fn(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ providerTaskId: 'must-not-be-persisted', outputUrls: [] }),
            { once: true },
          );
        }),
    );
    const harness = createHarness({
      adapter: { submit },
      jobStore: {
        heartbeatJobClaim: jest
          .fn()
          .mockResolvedValueOnce({ internalTaskId: 'egress-1' })
          .mockResolvedValue(null),
      },
      workerOptions: { heartbeatIntervalMs: 5 },
    });

    await expect(harness.createWorker().runOnce()).rejects.toMatchObject({
      code: 'IMAGE_EGRESS_LEASE_LOST',
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(harness.state.job.providerTaskId).toBeUndefined();
  });

  it('preserves safe diagnostics when an unclassified submit failure becomes status_unknown', async () => {
    const submit = jest.fn(async () => {
      const error = new TypeError(
        'response stream ended at https://queue.fal.run/private?fal_key=secret',
      );
      Object.assign(error, {
        code: 'FAL_RESPONSE_BODY_ERROR',
        phase: 'response_body',
        elapsedMs: 420,
        requestBodyBytes: 1024,
        statusCode: 202,
        responseMetadata: {
          falRequestId: 'fal-request-safe-1',
          falErrorType: 'runner_disconnected',
          falRequestTimeoutType: 'user',
        },
      });
      throw error;
    });
    const harness = createHarness({ adapter: { submit } });

    await harness.createWorker().runOnce();
    expect(harness.state.job.status).toBe('status_unknown');
    expect(harness.state.job.errorCode).toBe('IMAGE_EGRESS_SUBMIT_RESULT_UNKNOWN');
    expect(harness.state.job.currentOperation).toBeNull();
    expect(harness.state.job.lastOperationErrorCode).toBe('FAL_RESPONSE_BODY_ERROR');
    expect(harness.state.job.lastOperationAt).toEqual(new Date('2026-08-08T10:00:00.000Z'));
    expect(harness.state.job.providerMetadata.submitDiagnostic).toEqual({
      phase: 'response_body',
      elapsedMs: 420,
      inputImageCount: 1,
      inputBytes: 4,
      requestBodyBytes: 1024,
      httpStatus: 202,
      errorName: 'TypeError',
      falRequestId: 'fal-request-safe-1',
      falErrorType: 'runner_disconnected',
      falRequestTimeoutType: 'user',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [logMessage, logMetadata] = logger.warn.mock.calls[0];
    expect(JSON.parse(logMessage)).toEqual(logMetadata);
    expect(logMetadata).toEqual(
      expect.objectContaining({
        event: 'image_egress_provider_submit_unknown',
        internalTaskId: 'egress-1',
        requestId: 'request-1',
        provider: 'fal',
        model: 'openai/gpt-image-2/edit',
        operation: 'provider_submit',
        status: 'status_unknown',
        errorCode: 'IMAGE_EGRESS_SUBMIT_RESULT_UNKNOWN',
        lastOperationErrorCode: 'FAL_RESPONSE_BODY_ERROR',
        submitDiagnostic: harness.state.job.providerMetadata.submitDiagnostic,
      }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('queue.fal.run/private');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('edit this');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('fal_key=secret');
    await harness.createWorker('recovery-worker').runOnce();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('sanitizes an arbitrary adapter error code before persistence and logging', async () => {
    const submit = jest.fn(async () => {
      throw Object.assign(new Error('private response body'), {
        code: 'BAD_CODE\nhttps://private.example/token',
      });
    });
    const harness = createHarness({ adapter: { submit } });

    await harness.createWorker().runOnce();

    expect(harness.state.job.status).toBe('status_unknown');
    expect(harness.state.job.lastOperationErrorCode).toBe('IMAGE_EGRESS_SUBMIT_ERROR');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private.example');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private response body');
  });

  it('does not report the locally synthesized network status as a Provider HTTP response', async () => {
    const submit = jest.fn(async () => {
      throw Object.assign(new Error('network failed'), {
        code: 'FAL_NETWORK_ERROR',
        phase: 'request_fetch',
        statusCode: 502,
      });
    });
    const harness = createHarness({ adapter: { submit } });

    await harness.createWorker().runOnce();

    expect(harness.state.job.providerMetadata.submitDiagnostic).toEqual(
      expect.objectContaining({ phase: 'request_fetch' }),
    );
    expect(harness.state.job.providerMetadata.submitDiagnostic).not.toHaveProperty('httpStatus');
  });

  it('keeps the actual accepted HTTP status when Fal returns no durable request identity', async () => {
    const originalFetch = global.fetch;
    const originalFalKey = process.env.FAL_KEY;
    process.env.FAL_KEY = 'fal-test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: { get: () => null },
      text: async () => JSON.stringify({ status: 'accepted' }),
    });
    try {
      const harness = createHarness({
        adapter: createFalImageEgressAdapter({ model: 'openai/gpt-image-2/edit' }),
      });
      await harness.createWorker().runOnce();
      expect(harness.state.job.status).toBe('status_unknown');
      expect(harness.state.job.lastOperationErrorCode).toBe('FAL_MISSING_REQUEST_ID');
      expect(harness.state.job.providerMetadata.submitDiagnostic).toEqual(
        expect.objectContaining({ phase: 'response_parse', httpStatus: 202 }),
      );
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
      if (originalFalKey === undefined) {
        delete process.env.FAL_KEY;
      } else {
        process.env.FAL_KEY = originalFalKey;
      }
    }
  });

  it('keeps the last real Fal response phase when the worker budget wins the response body race', async () => {
    jest.useFakeTimers();
    const originalFetch = global.fetch;
    const originalFalKey = process.env.FAL_KEY;
    process.env.FAL_KEY = 'fal-test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: {
        get: (name) =>
          ({
            'x-fal-request-id': 'fal-request-before-body',
            'x-fal-request-timeout-type': 'user',
          })[name.toLowerCase()] ?? null,
      },
      text: jest.fn(() => new Promise(() => {})),
    });
    const adapter = createFalImageEgressAdapter({ model: 'openai/gpt-image-2/edit' });
    const harness = createHarness({
      adapter,
      workerOptions: { submitTimeoutMs: 90_000, heartbeatIntervalMs: 120_000 },
    });

    try {
      const runPromise = harness.createWorker().runOnce();
      for (let index = 0; index < 20 && global.fetch.mock.calls.length === 0; index += 1) {
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(global.fetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(90_000);
      await runPromise;

      const sentBody = global.fetch.mock.calls[0][1].body;
      expect(harness.state.job.status).toBe('status_unknown');
      expect(harness.state.job.lastOperationErrorCode).toBe('IMAGE_EGRESS_OPERATION_TIMEOUT');
      expect(harness.state.job.providerMetadata.submitDiagnostic).toEqual(
        expect.objectContaining({
          phase: 'response_body',
          inputImageCount: 1,
          inputBytes: 4,
          requestBodyBytes: Buffer.byteLength(sentBody, 'utf8'),
          httpStatus: 202,
          falRequestId: 'fal-request-before-body',
          falRequestTimeoutType: 'user',
        }),
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('data:image');
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('fal-test-key');
    } finally {
      global.fetch = originalFetch;
      if (originalFalKey === undefined) {
        delete process.env.FAL_KEY;
      } else {
        process.env.FAL_KEY = originalFalKey;
      }
      jest.useRealTimers();
    }
  });

  it('bounds a hung submit and fails closed without a second Provider call', async () => {
    const submit = jest.fn(
      ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const harness = createHarness({
      adapter: { submit },
      workerOptions: { submitTimeoutMs: 10 },
    });

    await harness.createWorker().runOnce();
    expect(harness.state.job.status).toBe('status_unknown');
    expect(harness.state.job.errorCode).toBe('IMAGE_EGRESS_SUBMIT_RESULT_UNKNOWN');
    await harness.createWorker('recovery-worker').runOnce();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('terminalizes an explicit parsed Provider rejection without calling submit twice', async () => {
    const submit = jest.fn(async () => {
      throw Object.assign(new Error('invalid prompt'), {
        code: 'FAL_BAD_REQUEST',
        submitOutcome: 'rejected',
      });
    });
    const harness = createHarness({ adapter: { submit } });

    await harness.createWorker().runOnce();
    expect(harness.state.job.status).toBe('failed');
    await harness.createWorker('recovery-worker').runOnce();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('acquires its own bounded slot, claims only the Fal allowset, and persists request_id', async () => {
    const harness = createHarness();
    await harness.createWorker().runOnce();

    expect(harness.slotStore.acquireSlot.mock.invocationCallOrder[0]).toBeLessThan(
      harness.jobStore.claimNextJob.mock.invocationCallOrder[0],
    );
    expect(harness.slotStore.acquireSlot).toHaveBeenCalledWith(
      expect.objectContaining({ workerFamily: 'image-egress-v1', maxConcurrency: 1 }),
    );
    expect(harness.jobStore.claimNextJob).toHaveBeenCalledWith(
      expect.objectContaining({
        allowset: IMAGE_EGRESS_PROVIDER_MODEL_ALLOWSET,
        rolloutModes: ['canary'],
      }),
    );
    expect(harness.adapter.submit).toHaveBeenCalledTimes(1);
    expect(harness.state.job).toEqual(
      expect.objectContaining({
        status: 'polling',
        providerTaskId: 'fal-request-1',
        submittedToProvider: true,
        currentOperation: 'status_read',
        jobDeadlineAt: expect.any(Date),
        deadlineAt: new Date('2026-08-08T10:15:00.000Z'),
      }),
    );
    expect(harness.calls.slice(-2)).toEqual(['release-job', 'release-slot']);
  });

  it('persists result and output absolute deadlines before their first network calls', async () => {
    const harness = createHarness({
      job: {
        status: 'polling',
        providerTaskId: 'fal-request-existing',
        submittedToProvider: true,
        currentOperation: 'status_read',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
      },
      adapter: {
        status: jest.fn(async () => ({ state: 'succeeded', providerStatus: 'COMPLETED' })),
      },
    });

    await harness.createWorker().runOnce();
    expect(harness.state.job.currentOperation).toBe('result_read');
    expect(harness.state.job.deadlineAt).toEqual(new Date('2026-08-08T10:03:00.000Z'));

    harness.advance(1);
    await harness.createWorker('result-worker').runOnce();
    expect(harness.state.job.currentOperation).toBe('output_download');
    expect(harness.state.job.deadlineAt).toEqual(new Date('2026-08-08T10:05:00.001Z'));
  });

  it('terminalizes a non-retryable read error instead of reclaiming it forever', async () => {
    const harness = createHarness({
      job: {
        status: 'polling',
        providerTaskId: 'fal-request-existing',
        submittedToProvider: true,
        currentOperation: 'status_read',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
      },
      adapter: {
        status: jest.fn(async () => {
          throw Object.assign(new Error('unauthorized'), { code: 'FAL_HTTP_401', statusCode: 401 });
        }),
      },
    });

    await harness.createWorker().runOnce();
    expect(harness.state.job).toEqual(
      expect.objectContaining({ status: 'failed', errorCode: 'FAL_HTTP_401' }),
    );
    expect(harness.adapter.status).toHaveBeenCalledTimes(1);
  });

  it('never replays ambiguous output storage after a worker restart', async () => {
    const harness = createHarness({
      job: {
        status: 'polling',
        providerTaskId: 'fal-request-existing',
        submittedToProvider: true,
        currentOperation: 'output_storage',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
        providerMetadata: { pendingOutputUrl: 'https://cdn.example/output.png?token=secret' },
      },
    });

    await harness.createWorker().runOnce();
    expect(harness.outputStorage.download).not.toHaveBeenCalled();
    expect(harness.outputStorage.store).not.toHaveBeenCalled();
    expect(harness.state.job).toEqual(
      expect.objectContaining({ status: 'failed', errorCode: 'RESULT_STORAGE_STATUS_UNKNOWN' }),
    );
  });

  it('cleans an uncommitted output when lease ownership is lost during storage', async () => {
    const store = jest.fn(
      async () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                fileRef: { fileId: 'output-uncommitted', contentType: 'image/png', bytes: 5 },
              }),
            15,
          ),
        ),
    );
    const harness = createHarness({
      job: {
        status: 'polling',
        providerTaskId: 'fal-request-existing',
        submittedToProvider: true,
        currentOperation: 'output_download',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
        providerMetadata: { pendingOutputUrl: 'https://cdn.example/output.png?token=secret' },
      },
      jobStore: {
        heartbeatJobClaim: jest
          .fn()
          .mockResolvedValueOnce({ internalTaskId: 'egress-1' })
          .mockResolvedValue(null),
      },
      outputStorage: { store },
      workerOptions: { heartbeatIntervalMs: 5 },
    });

    await expect(harness.createWorker().runOnce()).rejects.toMatchObject({
      code: 'IMAGE_EGRESS_LEASE_LOST',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store).toHaveBeenCalledTimes(1);
    expect(harness.outputStorage.cleanupUncommitted).toHaveBeenCalledWith({
      fileRef: expect.objectContaining({ fileId: 'output-uncommitted' }),
      jobId: 'egress-1',
    });
    expect(harness.state.job.status).toBe('polling');
    expect(harness.state.job.currentOperation).toBe('output_storage');
  });

  it('keeps a terminal job eligible when the audit event was not persisted', async () => {
    const recordUsage = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ durableAccepted: true, ledgerPersisted: true });
    const harness = createHarness({
      job: {
        status: 'failed',
        errorCode: 'FAL_TASK_FAILED',
        completedAt: new Date('2026-08-08T09:59:00.000Z'),
      },
      recordUsage,
    });

    await expect(harness.createWorker('usage-worker-1').runOnce()).rejects.toMatchObject({
      code: 'IMAGE_EGRESS_USAGE_PERSIST_FAILED',
    });
    expect(harness.state.job.usageRecorded).toBe(false);
    expect(harness.state.job.workerEligible).toBe(true);

    await harness.createWorker('usage-worker-2').runOnce();
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(harness.state.job.usageRecorded).toBe(true);
    expect(harness.state.job.workerEligible).toBe(false);
  });

  it('keeps a terminal job eligible until staged-input expiry restoration succeeds', async () => {
    const cleanup = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('mongo unavailable'), {
          code: 'IMAGE_EGRESS_INPUT_CLEANUP_NOT_DURABLE',
        }),
      )
      .mockResolvedValueOnce(undefined);
    const harness = createHarness({
      job: { status: 'failed', errorCode: 'FAL_TASK_FAILED' },
      inputStorage: { cleanup },
    });
    await harness.createWorker().runOnce();
    expect(harness.state.job.workerEligible).toBe(true);
    expect(harness.state.job.nextAttemptAt).toEqual(expect.any(Date));

    harness.advance(
      harness.state.job.nextAttemptAt.getTime() - new Date('2026-08-08T10:00:00.000Z').getTime(),
    );
    await harness.createWorker('cleanup-recovery-worker').runOnce();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(harness.state.job.workerEligible).toBe(false);
  });

  it('retries transient input reads before the only Provider submit', async () => {
    const resolve = jest
      .fn()
      .mockRejectedValueOnce(TRANSIENT)
      .mockResolvedValueOnce({ prompt: 'edit', imageInputs: ['data:image/png;base64,AAAA'] });
    const harness = createHarness({ inputStorage: { resolve } });

    await harness.createWorker().runOnce();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(harness.adapter.submit).toHaveBeenCalledTimes(1);
    expect(harness.state.job.providerTaskId).toBe('fal-request-1');
  });

  it('persists input-read exhaustion and resumes before submit in a later process', async () => {
    const resolve = jest.fn(async () => {
      throw TRANSIENT;
    });
    const harness = createHarness({ inputStorage: { resolve } });

    await harness.createWorker('input-worker-1').runOnce();
    expect(harness.state.job.status).toBe('polling');
    expect(harness.state.job.currentOperation).toBe('input_read');
    expect(harness.adapter.submit).not.toHaveBeenCalled();

    resolve.mockResolvedValue({ prompt: 'edit', imageInputs: ['data:image/png;base64,AAAA'] });
    const scheduled = harness.state.job.nextAttemptAt;
    harness.advance(scheduled.getTime() - new Date('2026-08-08T10:00:00.000Z').getTime());
    await harness.createWorker('input-worker-2').runOnce();
    expect(harness.adapter.submit).toHaveBeenCalledTimes(1);
    expect(harness.state.job.providerTaskId).toBe('fal-request-1');
  });

  it('resumes polling the same request_id after restart without submitting again', async () => {
    const harness = createHarness({
      job: {
        status: 'polling',
        providerTaskId: 'fal-request-existing',
        submittedToProvider: true,
        currentOperation: 'status_read',
        providerMetadata: { statusUrl: 'https://queue.fal.run/status/existing' },
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
      },
    });
    await harness.createWorker('worker-after-restart').runOnce();

    expect(harness.adapter.submit).not.toHaveBeenCalled();
    expect(harness.adapter.status).toHaveBeenCalledWith(
      expect.objectContaining({ providerTaskId: 'fal-request-existing' }),
    );
    expect(harness.state.job.status).toBe('polling');
    expect(harness.state.job.nextAttemptAt).toEqual(expect.any(Date));
    expect(harness.calls.slice(-2)).toEqual(['release-job', 'release-slot']);
  });

  it('retries a transient status read within the turn and then schedules the next short turn', async () => {
    const status = jest.fn().mockRejectedValueOnce(TRANSIENT).mockResolvedValueOnce({
      state: 'pending',
      providerStatus: 'IN_PROGRESS',
    });
    const harness = createHarness({
      job: {
        status: 'polling',
        providerTaskId: 'fal-request-existing',
        submittedToProvider: true,
        currentOperation: 'status_read',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
      },
      adapter: { status },
    });

    await harness.createWorker().runOnce();
    expect(status).toHaveBeenCalledTimes(2);
    expect(harness.state.job.status).toBe('polling');
    expect(harness.state.job.operationAttemptCount).toBe(2);
    expect(harness.state.job.nextAttemptAt).toEqual(expect.any(Date));
  });

  it('persists turn exhaustion and continues later without changing provider identity', async () => {
    const status = jest.fn(async () => {
      throw TRANSIENT;
    });
    const harness = createHarness({
      job: {
        status: 'polling',
        providerTaskId: 'fal-request-existing',
        submittedToProvider: true,
        currentOperation: 'status_read',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
      },
      adapter: { status },
    });
    await harness.createWorker('worker-1').runOnce();

    expect(harness.state.job.status).toBe('polling');
    expect(harness.state.job.failedTurnCount).toBe(1);
    expect(harness.state.job.lastOperationErrorCode).toBe('ETIMEDOUT');
    const scheduled = harness.state.job.nextAttemptAt;

    status.mockResolvedValue({ state: 'succeeded', providerStatus: 'COMPLETED' });
    harness.advance(scheduled.getTime() - new Date('2026-08-08T10:00:00.000Z').getTime());
    await harness.createWorker('worker-2').runOnce();
    expect(harness.adapter.submit).not.toHaveBeenCalled();
    expect(harness.state.job.providerTaskId).toBe('fal-request-existing');
    expect(harness.state.job.currentOperation).toBe('result_read');
  });

  it('recovers result GET, downloads the same output, stores it, then succeeds once', async () => {
    const result = jest
      .fn()
      .mockRejectedValueOnce(TRANSIENT)
      .mockResolvedValueOnce({
        outputUrls: ['https://cdn.example/output.png?token=secret'],
      });
    const harness = createHarness({
      job: {
        status: 'polling',
        providerTaskId: 'fal-request-existing',
        submittedToProvider: true,
        currentOperation: 'result_read',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
      },
      adapter: { result },
    });

    await harness.createWorker().runOnce();
    expect(result).toHaveBeenCalledTimes(2);
    expect(harness.state.job.currentOperation).toBe('output_download');
    const rawUrl = harness.state.job.providerMetadata.pendingOutputUrl;
    harness.advance(1);
    await harness.createWorker('worker-download').runOnce();

    expect(harness.outputStorage.download).toHaveBeenCalledWith(
      expect.objectContaining({ url: rawUrl, provider: 'fal' }),
    );
    expect(harness.outputStorage.store.mock.invocationCallOrder[0]).toBeLessThan(
      harness.recordUsage.mock.invocationCallOrder[0],
    );
    expect(harness.state.job.status).toBe('succeeded');
    expect(harness.state.job.result.fileRef.fileId).toBe('output-1');
    expect(harness.state.job.providerMetadata.pendingOutputUrl).toBeUndefined();
    expect(harness.inputStorage.cleanup).toHaveBeenCalled();
    expect(harness.usageRows.size).toBe(1);
  });

  it('stores Fal GPT Image 2 text output as fileRef before recording Fal usage', async () => {
    const temporaryUrl = 'https://v3.fal.media/files/output.png?token=temporary';
    const harness = createHarness({
      job: {
        businessType: 'image_generation',
        taskType: 'text-to-image',
        provider: 'fal',
        model: 'openai/gpt-image-2',
        modelKey: 'apimart_gpt_image_2_text',
        status: 'polling',
        providerTaskId: 'fal-text-request-1',
        submittedToProvider: true,
        currentOperation: 'result_read',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
      },
      adapter: {
        result: jest.fn(async () => ({ outputUrls: [temporaryUrl] })),
      },
    });

    await harness.createWorker('fal-text-result').runOnce();
    expect(harness.state.job.providerMetadata.pendingOutputUrl).toBe(temporaryUrl);

    harness.advance(1);
    await harness.createWorker('fal-text-storage').runOnce();

    expect(harness.outputStorage.download).toHaveBeenCalledWith(
      expect.objectContaining({ url: temporaryUrl, provider: 'fal' }),
    );
    expect(harness.outputStorage.store).toHaveBeenCalledTimes(1);
    expect(harness.state.job.result).toEqual(
      expect.objectContaining({ fileRef: expect.objectContaining({ fileId: 'output-1' }) }),
    );
    expect(harness.state.job.result.sourceMetadata).toEqual({
      hostname: 'v3.fal.media',
      urlHash: 'safe-hash',
    });
    expect(JSON.stringify(harness.state.job.result)).not.toContain(temporaryUrl);
    expect(JSON.stringify(harness.state.job.result)).not.toContain('token=temporary');
    expect(harness.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fal',
        model: 'openai/gpt-image-2',
        modelKey: 'apimart_gpt_image_2_text',
        businessType: 'image_generation',
        taskType: 'text-to-image',
        status: 'succeeded',
        imageCount: 1,
        billingConfirmed: true,
      }),
    );
    expect(harness.outputStorage.store.mock.invocationCallOrder[0]).toBeLessThan(
      harness.recordUsage.mock.invocationCallOrder[0],
    );
  });
  it.each(['text-to-image', 'edit'])(
    'stores Flare %s output before recording usage',
    async (endpoint) => {
      const temporaryUrl = 'https://v3.fal.media/files/output.png?token=temporary';
      const harness = createHarness({
        job: {
          businessType: 'image_generation',
          taskType: endpoint === 'edit' ? 'single-image-edit' : 'text-to-image',
          provider: 'fal',
          model: `openai/gpt-image-2.5/flare/${endpoint}`,
          modelKey:
            endpoint === 'edit' ? 'fal_gpt_image_2_5_flare_edit' : 'fal_gpt_image_2_5_flare_text',
          status: 'polling',
          providerTaskId: 'fal-text-request-1',
          submittedToProvider: true,
          currentOperation: 'result_read',
          jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
        },
        adapter: {
          result: jest.fn(async () => ({ outputUrls: [temporaryUrl] })),
        },
      });

      await harness.createWorker('fal-text-result').runOnce();
      expect(harness.state.job.providerMetadata.pendingOutputUrl).toBe(temporaryUrl);

      harness.advance(1);
      await harness.createWorker('fal-text-storage').runOnce();

      expect(harness.outputStorage.download).toHaveBeenCalledWith(
        expect.objectContaining({ url: temporaryUrl, provider: 'fal' }),
      );
      expect(harness.outputStorage.store).toHaveBeenCalledTimes(1);
      expect(harness.state.job.result).toEqual(
        expect.objectContaining({ fileRef: expect.objectContaining({ fileId: 'output-1' }) }),
      );
      expect(harness.state.job.result.sourceMetadata).toEqual({
        hostname: 'v3.fal.media',
        urlHash: 'safe-hash',
      });
      expect(JSON.stringify(harness.state.job.result)).not.toContain(temporaryUrl);
      expect(JSON.stringify(harness.state.job.result)).not.toContain('token=temporary');
      expect(harness.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'fal',
          model: `openai/gpt-image-2.5/flare/${endpoint}`,
          modelKey:
            endpoint === 'edit' ? 'fal_gpt_image_2_5_flare_edit' : 'fal_gpt_image_2_5_flare_text',
          businessType: 'image_generation',
          taskType: endpoint === 'edit' ? 'single-image-edit' : 'text-to-image',
          status: 'succeeded',
          imageCount: 1,
          billingConfirmed: true,
        }),
      );
      expect(harness.outputStorage.store.mock.invocationCallOrder[0]).toBeLessThan(
        harness.recordUsage.mock.invocationCallOrder[0],
      );
    },
  );

  it('retries the identical output URL after one transient download failure', async () => {
    const download = jest
      .fn()
      .mockRejectedValueOnce(TRANSIENT)
      .mockResolvedValueOnce({
        buffer: Buffer.from('image'),
        contentType: 'image/png',
        sourceMetadata: { hostname: 'cdn.example', urlHash: 'safe-hash' },
      });
    const signedUrl = 'https://cdn.example/output.png?token=secret';
    const harness = createHarness({
      job: {
        status: 'polling',
        providerTaskId: 'fal-request-existing',
        submittedToProvider: true,
        currentOperation: 'output_download',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
        providerMetadata: { pendingOutputUrl: signedUrl },
      },
      outputStorage: { download },
    });

    await harness.createWorker().runOnce();
    expect(download).toHaveBeenCalledTimes(2);
    expect(download.mock.calls.map(([input]) => input.url)).toEqual([signedUrl, signedUrl]);
    expect(harness.adapter.submit).not.toHaveBeenCalled();
    expect(harness.state.job.status).toBe('succeeded');
  });

  it('does not retry ambiguous output storage and never marks success', async () => {
    const store = jest.fn(async () => {
      throw Object.assign(new Error('storage response lost'), { code: 'RESULT_STORAGE_FAILED' });
    });
    const harness = createHarness({
      job: {
        status: 'polling',
        providerTaskId: 'fal-request-existing',
        submittedToProvider: true,
        currentOperation: 'output_download',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
        providerMetadata: { pendingOutputUrl: 'https://cdn.example/output.png?token=secret' },
      },
      outputStorage: { store },
    });

    await harness.createWorker().runOnce();
    expect(store).toHaveBeenCalledTimes(1);
    expect(harness.adapter.submit).not.toHaveBeenCalled();
    expect(harness.state.job.status).toBe('failed');
    expect(harness.state.job.errorCode).toBe('RESULT_STORAGE_FAILED');
  });

  it('bounds a hung output store and never replays the ambiguous write', async () => {
    const store = jest.fn(
      ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const harness = createHarness({
      job: {
        status: 'polling',
        submittedToProvider: true,
        providerTaskId: 'fal-request-existing',
        currentOperation: 'output_download',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
        providerMetadata: { pendingOutputUrl: 'https://cdn.example/output.png?token=secret' },
      },
      outputStorage: { store },
      workerOptions: { outputStorageTimeoutMs: 10 },
    });

    await harness.createWorker().runOnce();
    expect(harness.state.job.status).toBe('failed');
    expect(harness.state.job.errorCode).toBe('RESULT_STORAGE_STATUS_UNKNOWN');
    await harness.createWorker('recovery-worker').runOnce();
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('clamps a read turn to the remaining persistent operation deadline', async () => {
    const status = jest.fn(
      ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const harness = createHarness({
      job: {
        status: 'polling',
        submittedToProvider: true,
        providerTaskId: 'fal-request-existing',
        providerAcceptedAt: new Date('2026-08-08T09:59:00.000Z'),
        currentOperation: 'status_read',
        deadlineAt: new Date('2026-08-08T10:00:00.010Z'),
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
      },
      adapter: { status },
      retryPolicies: { status_read: { maxAttempts: 1, turnBudgetMs: 100 } },
    });
    const startedAt = Date.now();

    await harness.createWorker().runOnce();
    expect(Date.now() - startedAt).toBeLessThan(80);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('rechecks the job deadline before entering output storage', async () => {
    let harness;
    const download = jest.fn(async () => {
      harness.advance(20);
      return {
        buffer: Buffer.from('image'),
        contentType: 'image/png',
        sourceMetadata: { hostname: 'cdn.example', urlHash: 'safe-hash' },
      };
    });
    harness = createHarness({
      job: {
        status: 'polling',
        submittedToProvider: true,
        providerTaskId: 'fal-request-existing',
        currentOperation: 'output_download',
        jobDeadlineAt: new Date('2026-08-08T10:00:00.010Z'),
        providerMetadata: { pendingOutputUrl: 'https://cdn.example/output.png?token=secret' },
      },
      outputStorage: { download },
    });

    await harness.createWorker().runOnce();
    expect(harness.outputStorage.store).not.toHaveBeenCalled();
    expect(harness.state.job).toEqual(
      expect.objectContaining({ status: 'failed', errorCode: 'IMAGE_GENERATION_TIMEOUT' }),
    );
  });

  it('rechecks the job deadline after lease renewal before starting output storage', async () => {
    let harness;
    harness = createHarness({
      job: {
        status: 'polling',
        submittedToProvider: true,
        providerTaskId: 'fal-request-existing',
        currentOperation: 'output_download',
        jobDeadlineAt: new Date('2026-08-08T10:00:00.010Z'),
        providerMetadata: { pendingOutputUrl: 'https://cdn.example/output.png?token=secret' },
      },
      jobStore: {
        heartbeatJobClaim: jest.fn(async () => {
          harness.advance(20);
          return cloneJob(harness.state.job);
        }),
      },
    });

    await harness.createWorker().runOnce();
    expect(harness.outputStorage.store).not.toHaveBeenCalled();
    expect(harness.state.job).toEqual(
      expect.objectContaining({ status: 'failed', errorCode: 'IMAGE_GENERATION_TIMEOUT' }),
    );
  });

  it('cleans a stored output and fails when the job deadline expires during storage', async () => {
    let harness;
    const store = jest.fn(async () => {
      harness.advance(20);
      return { fileRef: { fileId: 'late-output', contentType: 'image/png', bytes: 5 } };
    });
    harness = createHarness({
      job: {
        status: 'polling',
        submittedToProvider: true,
        providerTaskId: 'fal-request-existing',
        currentOperation: 'output_download',
        jobDeadlineAt: new Date('2026-08-08T10:00:00.010Z'),
        providerMetadata: { pendingOutputUrl: 'https://cdn.example/output.png?token=secret' },
      },
      outputStorage: { store },
    });

    await harness.createWorker().runOnce();
    expect(harness.outputStorage.cleanupUncommitted).toHaveBeenCalledWith({
      fileRef: expect.objectContaining({ fileId: 'late-output' }),
      jobId: 'egress-1',
    });
    expect(harness.state.job).toEqual(
      expect.objectContaining({ status: 'failed', errorCode: 'IMAGE_GENERATION_TIMEOUT' }),
    );
    expect(harness.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', imageCount: 0, billingConfirmed: false }),
    );
  });

  it('fails terminally after the persistent output-fetch deadline without resubmitting', async () => {
    const deadline = new Date('2026-08-08T09:59:59.000Z');
    const harness = createHarness({
      job: {
        status: 'polling',
        providerTaskId: 'fal-request-existing',
        submittedToProvider: true,
        currentOperation: 'output_download',
        deadlineAt: deadline,
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
        providerMetadata: {
          pendingOutputUrl: 'https://cdn.example/output.png?token=secret',
        },
      },
    });

    await harness.createWorker().runOnce();
    expect(harness.outputStorage.download).not.toHaveBeenCalled();
    expect(harness.adapter.submit).not.toHaveBeenCalled();
    expect(harness.state.job).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'IMAGE_OUTPUT_FETCH_FAILED',
        providerTaskId: 'fal-request-existing',
      }),
    );
    expect(harness.state.job.providerMetadata.pendingOutputUrl).toBeUndefined();
    expect(harness.inputStorage.cleanup).toHaveBeenCalled();
  });

  it('fails closed on ambiguous submit and replay upserts one zero-cost audit row', async () => {
    const submit = jest.fn(async () => {
      throw Object.assign(new Error('socket reset'), { code: 'FAL_NETWORK_ERROR' });
    });
    let failUsageFlagOnce = true;
    const harness = createHarness({ adapter: { submit } });
    const originalUpdate = harness.jobStore.updateUsageDelivery;
    harness.jobStore.updateUsageDelivery = jest.fn(async (input) => {
      if (input.state === 'persisted' && failUsageFlagOnce) {
        failUsageFlagOnce = false;
        throw new Error('crash after usage upsert');
      }
      return originalUpdate(input);
    });

    await expect(harness.createWorker('worker-before-crash').runOnce()).rejects.toThrow(
      'crash after usage upsert',
    );
    expect(harness.state.job.status).toBe('status_unknown');
    expect(submit).toHaveBeenCalledTimes(1);

    await harness.createWorker('worker-after-crash').runOnce();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(harness.usageRows.size).toBe(1);
    expect([...harness.usageRows.values()][0]).toEqual(
      expect.objectContaining({
        status: 'status_unknown',
        imageCount: 0,
        costCny: 0,
        billingConfirmed: false,
        metadata: expect.objectContaining({ auditOnly: true, submitOutcome: 'unknown' }),
      }),
    );
    expect(harness.state.job.workerEligible).toBe(false);
  });

  it('marks a non-retryable Provider terminal status failed immediately', async () => {
    const harness = createHarness({
      job: {
        status: 'polling',
        providerTaskId: 'fal-request-existing',
        submittedToProvider: true,
        currentOperation: 'status_read',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
      },
      adapter: {
        status: jest.fn(async () => ({
          state: 'failed',
          providerStatus: 'FAILED',
          errorCode: 'FAL_TASK_FAILED',
        })),
      },
    });
    await harness.createWorker().runOnce();
    expect(harness.state.job.status).toBe('failed');
    expect(harness.state.job.errorCode).toBe('FAL_TASK_FAILED');
    expect(harness.adapter.status).toHaveBeenCalledTimes(1);
  });

  it.each(['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image-preview'])(
    'persists and resumes APIMart %s with the same task ID',
    async (model) => {
      const harness = createHarness({
        job: {
          provider: 'apimart',
          model,
          modelKey: `apimart_${model}`,
        },
        adapter: {
          submit: jest.fn(async () => ({
            providerTaskId: 'gemini-task-1',
            providerMetadata: { responseKeys: ['task_id'] },
            outputUrls: [],
          })),
          status: jest.fn(async () => ({
            state: 'succeeded',
            providerStatus: 'SUCCEEDED',
            outputUrls: ['https://cdn.example/gemini.png?token=secret'],
          })),
        },
      });

      await harness.createWorker('gemini-submit-worker').runOnce();
      expect(harness.state.job.providerTaskId).toBe('gemini-task-1');
      expect(harness.adapter.submit).toHaveBeenCalledTimes(1);
      harness.advance(1);
      await harness.createWorker('gemini-poll-worker').runOnce();
      expect(harness.adapter.submit).toHaveBeenCalledTimes(1);
      expect(harness.adapter.status).toHaveBeenCalledWith(
        expect.objectContaining({ providerTaskId: 'gemini-task-1' }),
      );
      expect(harness.state.job.currentOperation).toBe('output_download');
    },
  );

  it('fails APIMart submit timeout closed and never submits again', async () => {
    const submit = jest.fn(async () => {
      throw Object.assign(new Error('submit timed out'), {
        code: 'APIMART_IMAGE_SUBMIT_TIMEOUT',
        statusCode: 504,
      });
    });
    const harness = createHarness({
      job: {
        provider: 'apimart',
        model: 'gemini-3.1-flash-image-preview',
      },
      adapter: { submit },
    });
    await harness.createWorker('gemini-ambiguous-1').runOnce();
    expect(harness.state.job.status).toBe('status_unknown');
    await harness.createWorker('gemini-ambiguous-2').runOnce();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(harness.usageRows.size).toBe(1);
  });

  it('fails APIMart lost submit response closed without treating submit as retryable', async () => {
    const submit = jest.fn(async () => {
      throw Object.assign(new Error('fetch failed after request dispatch'), {
        code: 'APIMART_SUBMIT_TRANSPORT_ERROR',
      });
    });
    const harness = createHarness({
      job: {
        provider: 'apimart',
        model: 'gemini-3.1-flash-image-preview',
      },
      adapter: { submit },
    });

    await harness.createWorker('gemini-response-lost-1').runOnce();
    expect(harness.state.job.status).toBe('status_unknown');
    await harness.createWorker('gemini-response-lost-2').runOnce();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(harness.usageRows.size).toBe(1);
  });

  it('retries APIMart status transport loss and keeps the same task ID', async () => {
    const status = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('status network loss'), {
          code: 'APIMART_STATUS_TRANSPORT_ERROR',
        }),
      )
      .mockResolvedValueOnce({
        state: 'succeeded',
        providerStatus: 'SUCCEEDED',
        outputUrls: ['https://cdn.example/gemini.png?token=secret'],
      });
    const harness = createHarness({
      job: {
        provider: 'apimart',
        model: 'gemini-3.1-flash-image-preview',
        status: 'polling',
        providerTaskId: 'gemini-task-existing',
        submittedToProvider: true,
        currentOperation: 'status_read',
        jobDeadlineAt: new Date('2026-08-08T10:30:00.000Z'),
      },
      adapter: { status },
    });

    await harness.createWorker().runOnce();
    expect(status).toHaveBeenCalledTimes(2);
    expect(harness.adapter.submit).not.toHaveBeenCalled();
    expect(harness.state.job.providerTaskId).toBe('gemini-task-existing');
    expect(harness.state.job.currentOperation).toBe('output_download');
  });
});

test('durable-only image accounting does not claim Mongo persistence or repeat provider calls', async () => {
  const h = createHarness({
    job: { status: 'succeeded', result: { fileRef: { fileId: 'already-stored' } } },
    recordUsage: async () => ({ durableAccepted: true, ledgerPersisted: false }),
  });
  await h.createWorker().runOnce();
  expect(h.state.job.usageRecorded).toBe(false);
  expect(h.state.job.usageDelivery.state).toBe('durable');
  expect(h.state.job.workerEligible).toBe(false);
  expect(h.adapter.submit).not.toHaveBeenCalled();
});
test('explicitly unaccepted accounting result cannot be treated as truthy success', async () => {
  const h = createHarness({
    job: { status: 'failed' },
    recordUsage: async () => ({ durableAccepted: false, ledgerPersisted: false, reason: 'full' }),
  });
  await expect(h.createWorker().runOnce()).rejects.toMatchObject({
    code: 'IMAGE_EGRESS_USAGE_PERSIST_FAILED',
  });
  expect(h.state.job.usageRecorded).toBe(false);
  expect(h.state.job.workerEligible).toBe(true);
  expect(h.adapter.submit).not.toHaveBeenCalled();
});

test('usage admission failure prevents an egress paid submission', async () => {
  const h = createHarness({
    workerOptions: {
      admitUsage: async () => {
        throw Object.assign(new Error('full'), { code: 'USAGE_CAPTURE_UNAVAILABLE' });
      },
    },
  });
  await expect(h.createWorker().runOnce()).rejects.toMatchObject({
    code: 'USAGE_CAPTURE_UNAVAILABLE',
  });
  expect(h.adapter.submit).not.toHaveBeenCalled();
  expect(h.state.job.submittedToProvider).toBe(false);
});

test('a journal response arriving after ledger persistence cannot downgrade the egress acknowledgement', async () => {
  const h = createHarness({
    job: { status: 'failed' },
    recordUsage: async () => {
      h.state.job.usageRecorded = true;
      h.state.job.usageDelivery = { ...h.state.job.usageDelivery, state: 'persisted' };
      return { durableAccepted: true, ledgerPersisted: false };
    },
  });
  await h.createWorker().runOnce();
  expect(h.state.job.usageRecorded).toBe(true);
  expect(h.state.job.usageDelivery.state).toBe('persisted');
});
