// Real batch -> persistence -> async contract; only external boundaries are fake.
const mockDb = {};
const mockGenerate = jest.fn();
const mockPoll = jest.fn();
const mockFalSubmit = jest.fn();
const mockFalStatus = jest.fn();
const mockFalResult = jest.fn();
jest.mock('./adapters/fal/common', () => ({
  ...jest.requireActual('./adapters/fal/common'),
  submitFalQueueTask: (...args) => mockFalSubmit(...args),
  readFalQueueStatus: (...args) => mockFalStatus(...args),
  readFalQueueResult: (...args) => mockFalResult(...args),
}));
jest.mock(
  '~/models',
  () =>
    new Proxy(
      {},
      {
        get:
          (_, key) =>
          (...args) =>
            mockDb[key](...args),
      },
    ),
);
jest.mock('@librechat/data-schemas', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('~/server/services/UsageLedgerService', () => ({
  admitImageUsage: jest.fn(async () => null),
  releaseImageUsage: jest.fn(async () => {}),
  buildImageUsageEnvelope: jest.fn(() => null),
  recordImageUsage: jest.fn(),
}));
jest.mock('./adapters/apimart', () => ({ generateAPIMartImage: mockGenerate }));
jest.mock('./adapters/apimart/common', () => ({
  ...jest.requireActual('./adapters/apimart/common'),
  getAPIMartConfig: () => ({ apiKey: 'test-key' }),
  pollTask: mockPoll,
}));
jest.mock('./adapters/fal', () => ({ generateFalImage: jest.fn() }));
jest.mock('./adapters/ark', () => ({ generateArkImage: jest.fn() }));
jest.mock('./siliconflow', () => ({ TEXT_TO_IMAGE_MODEL: 'Qwen/Qwen-Image' }));
jest.mock('./promptTemplateStore', () => ({}));
jest.mock('./normalizeImageOutput', () => ({
  normalizeGeneratedImageOutput: jest.fn(async () => ({
    buffer: Buffer.from('test-output'),
    mimeType: 'image/png',
    width: 800,
    height: 800,
  })),
}));
jest.mock('./batchResultStorage', () => ({
  getBatchResultFilePath: (batch, item) => `/batch/${batch}/${item}/file`,
  toStoredBatchResultImage: ({ url: _url, ...image }) => image,
  toClientBatchResultImage: ({ batchId, itemId, resultImage }) => ({
    ...resultImage,
    url: `/batch/${batchId}/${itemId}/file`,
  }),
  saveBatchResultImage: jest.fn(async () => ({
    fileId: 'stored-result',
    contentType: 'image/png',
  })),
}));
const {
  batchTaskStore,
  getBatchTask,
  retryBatchItem,
  serializeBatchTask,
} = require('./batchPackaging');
const { getReferenceImageMetadata } = require('./batchTaskPersistence');
const { runAPIMartImg2JobAndWait } = require('./apimartImg2Async');
const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));
let record;
let job;
const originalMode = process.env.APIMART_IMG2_ASYNC_MODE;
function matchesJob(args) {
  return (
    job &&
    Object.entries(args).every(
      ([key, value]) =>
        key === 'includeSensitive' ||
        value === undefined ||
        (key === 'tenantId' ? (job[key] || null) === (value || null) : job[key] === value),
    )
  );
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-18T00:00:00Z'));
  jest.clearAllMocks();
  batchTaskStore.clear();
  process.env.APIMART_IMG2_ASYNC_MODE = 'all';
  record = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    batchId: 'batch-1',
    itemId: 'item-1',
    templateId: 'style-1',
    templateName: 'Style',
    title: 'Product',
    prompt: 'draw a box',
    provider: 'apimart',
    model: 'gpt-image-2',
    modelKey: 'apimart_gpt_image_2',
    generationMode: 't2i',
    status: 'submitting',
    submitAttempt: 1,
    retryCount: 0,
    retryMode: 'resubmit_provider',
    createdAt: new Date(),
    updatedAt: new Date(),
    processingLeaseUntil: new Date(Date.now() - 1),
    processingWorkerId: 'old-process',
  };
  job = {
    internalTaskId: 'child-1',
    userId: record.userId,
    tenantId: record.tenantId,
    batchTaskId: record.batchId,
    itemId: record.itemId,
    asyncVersion: 2,
    provider: 'apimart',
    model: record.model,
    businessType: 'batch_image_generation',
    status: 'succeeded',
    providerTaskId: 'paid-task',
    providerStatus: 'SUCCEEDED',
    result: { images: [{ b64_json: 'data:image/png;base64,dGVzdA==' }] },
  };
  mockDb.getImageBatchTaskItems = jest.fn(async ({ userId }) =>
    userId === record.userId ? [clone(record)] : [],
  );
  mockDb.acquireImageBatchTaskLease = jest.fn(async ({ statuses, workerId, leaseMs }) => {
    if (
      !statuses.includes(record.status) ||
      (new Date(record.processingLeaseUntil) > new Date() && record.processingWorkerId !== workerId)
    ) {
      return null;
    }
    record.processingWorkerId = workerId;
    record.processingLeaseUntil = new Date(Date.now() + leaseMs);
    return clone(record);
  });
  mockDb.updateImageBatchTaskItemWithLease = jest.fn(
    async ({ statuses, workerId, updates, unsetFields = [], releaseLease }) => {
      if (
        !statuses.includes(record.status) ||
        workerId !== record.processingWorkerId ||
        new Date(record.processingLeaseUntil) <= new Date()
      ) {
        return null;
      }
      Object.assign(record, clone(updates));
      for (const key of unsetFields) {
        delete record[key];
      }
      if (releaseLease) {
        record.processingWorkerId = null;
        record.processingLeaseUntil = null;
      }
      return clone(record);
    },
  );
  mockDb.updateImageBatchTaskItem = jest.fn(
    async ({
      statuses,
      updates,
      unsetFields = [],
      expectedRetryCount,
      expectedInternalJobItemId,
    }) => {
      if (
        !statuses.includes(record.status) ||
        (expectedRetryCount !== undefined &&
          ((record.retryCount || 0) !== expectedRetryCount ||
            (record.internalJobItemId || null) !== (expectedInternalJobItemId || null)))
      )
        return null;
      Object.assign(record, clone(updates));
      for (const key of unsetFields) delete record[key];
      return clone(record);
    },
  );
  mockDb.getImageGenerationJob = jest.fn(async (args) => (matchesJob(args) ? clone(job) : null));
  mockDb.getImageGenerationJobByBatchItem = jest.fn(async (args) =>
    matchesJob(args) ? clone(job) : null,
  );
  mockDb.findOrCreateImageGenerationJob = jest.fn(async (input) => {
    if (
      job &&
      job.userId === input.userId &&
      job.batchTaskId === input.batchTaskId &&
      job.itemId === input.itemId
    ) {
      return { job: clone(job), deduplicated: true };
    }
    job = clone(input); // callbacks cannot survive database serialization
    return { job: clone(job), deduplicated: false };
  });
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  if (originalMode === undefined) {
    delete process.env.APIMART_IMG2_ASYNC_MODE;
  } else {
    process.env.APIMART_IMG2_ASYNC_MODE = originalMode;
  }
});
async function tick(ms = 0) {
  await jest.advanceTimersByTimeAsync(ms);
}
async function finish(task) {
  await tick();
  expect(task.runnerActive).toBe(false);
  expect(task.items[0].status).toBe('success');
  expect(record).toMatchObject({ status: 'succeeded', resultImage: { fileId: 'stored-result' } });
  expect(mockDb.findOrCreateImageGenerationJob).not.toHaveBeenCalled();
  expect(mockGenerate).not.toHaveBeenCalled();
  expect(mockPoll).not.toHaveBeenCalled();
}
test.each(['submitting', 'processing', 'failed'])(
  'recovers a completed durable job from %s after memory loss',
  async (status) => {
    record.status = status;
    if (status === 'failed') {
      record.retryMode = undefined;
      record.errorKind = 'provider_submit_unknown';
    }
    process.env.APIMART_IMG2_ASYNC_MODE = 'off';
    const task = await getBatchTask('batch-1', 'user-1');
    await finish(task);
    expect(record.internalTaskId).toBe('child-1');
    expect(record.providerTaskId).toBe('paid-task');
    expect(serializeBatchTask(task).items[0]).not.toHaveProperty('internalTaskId');
  },
);
test('keeps the lease alive while a durable job remains queued past fifteen minutes', async () => {
  record.internalTaskId = job.internalTaskId;
  record.internalJobStatus = 'waiting';
  record.status = 'processing';
  record.retryMode = 'resume_polling';
  job.status = 'waiting';
  delete job.providerTaskId;
  const task = await getBatchTask('batch-1', 'user-1');
  await tick(14 * 60 * 1000);
  expect(record.status).toBe('processing');
  expect(new Date(record.processingLeaseUntil).getTime()).toBeGreaterThan(Date.now());
  await tick(2 * 60 * 1000);
  expect(record.status).toBe('processing');
  expect(task.items[0].status).not.toBe('failed');
  job.status = 'succeeded';
  job.providerTaskId = 'paid-task';
  const resumed = await getBatchTask('batch-1', 'user-1');
  await finish(resumed);
});
test('links the enqueued job before waiting without storing callbacks in payload', async () => {
  job = null;
  const seen = [];
  const promise = runAPIMartImg2JobAndWait({
    userId: record.userId,
    tenantId: record.tenantId,
    batchTaskId: record.batchId,
    itemId: record.itemId,
    businessType: 'batch_image_generation',
    provider: 'apimart',
    model: record.model,
    taskType: 'text-to-image',
    providerRequest: { prompt: 'box' },
    onJobUpdate: async (snapshot) => {
      seen.push(snapshot);
    },
  });
  await tick();
  const waitingSeen = seen.map(clone);
  job.status = 'succeeded';
  job.providerTaskId = 'paid-task';
  job.result = { images: [{ b64_json: 'test' }] };
  await tick(1000);
  await promise;
  expect(waitingSeen).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ internalTaskId: job.internalTaskId, status: 'waiting' }),
    ]),
  );
  expect(seen.at(-1)).toMatchObject({ status: 'succeeded', providerTaskId: 'paid-task' });
  expect(job.payload).not.toHaveProperty('onJobUpdate');
});
test('never creates a replacement when the linked durable job is missing', async () => {
  record.internalTaskId = 'missing-child';
  record.internalJobStatus = 'polling';
  record.status = 'processing';
  record.retryMode = 'resume_polling';
  job = null;
  const task = await getBatchTask('batch-1', 'user-1');
  await tick();
  expect(task.items[0].status).toBe('failed');
  expect(mockDb.findOrCreateImageGenerationJob).not.toHaveBeenCalled();
  expect(mockGenerate).not.toHaveBeenCalled();
  expect(mockPoll).not.toHaveBeenCalled();
});
test('does not adopt another users job for a legacy unlinked item', async () => {
  job.userId = 'other-user';
  const task = await getBatchTask('batch-1', 'user-1');
  await tick();
  expect(task.items[0].status).toBe('failed');
  expect(mockDb.findOrCreateImageGenerationJob).not.toHaveBeenCalled();
  expect(record).not.toHaveProperty('internalTaskId');
});

test('a new batch item persists its durable link before the provider has accepted work', async () => {
  record.status = 'pending';
  record.submitAttempt = 0;
  record.modelKey = 'apimart_gpt_image_2_text';
  job = null;
  const task = await getBatchTask('batch-1', 'user-1');
  await tick();
  expect(record).toMatchObject({
    status: 'processing',
    internalTaskId: job.internalTaskId,
    internalJobStatus: 'waiting',
  });
  expect(record.providerTaskId).toBeUndefined();
  expect(job.payload).not.toHaveProperty('onProviderTaskSubmitted');
  expect(job.payload).not.toHaveProperty('onProviderPoll');
  job.status = 'succeeded';
  job.providerTaskId = 'paid-task';
  job.result = { images: [{ b64_json: 'data:image/png;base64,dGVzdA==' }] };
  await tick(1000);
  expect(task.items[0].status).toBe('success');
  expect(mockDb.findOrCreateImageGenerationJob).toHaveBeenCalledTimes(1);
  expect(mockGenerate).not.toHaveBeenCalled();
});

test.each(['failed', 'status_unknown', 'cancelled'])(
  'a durable %s result stops recovery without automatic resubmission',
  async (status) => {
    record.internalTaskId = job.internalTaskId;
    record.internalJobStatus = 'polling';
    record.status = 'processing';
    record.retryMode = 'resume_polling';
    job.status = status;
    job.error = 'generation failed';
    job.providerStatus = status === 'failed' ? 'FAILED' : 'IN_PROGRESS';
    const task = await getBatchTask('batch-1', 'user-1');
    await tick();
    expect(task.items[0].status).toBe('failed');
    const fresh = await getBatchTask('batch-1', 'user-1');
    await tick();
    expect(fresh.items[0].status).toBe('failed');
    expect(fresh.runnerActive).toBe(false);
    expect(mockDb.findOrCreateImageGenerationJob).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockPoll).not.toHaveBeenCalled();
  },
);

test.each(['userId', 'tenantId', 'batchTaskId', 'itemId', 'model'])(
  'rejects a linked job with mismatched %s without consuming its result',
  async (field) => {
    record.internalTaskId = job.internalTaskId;
    record.internalJobStatus = 'polling';
    record.status = 'processing';
    record.retryMode = 'resume_polling';
    job[field] = 'foreign';
    const task = await getBatchTask('batch-1', 'user-1');
    await tick();
    expect(task.items[0].status).toBe('failed');
    expect(record.resultImage).toBeUndefined();
    expect(mockDb.findOrCreateImageGenerationJob).not.toHaveBeenCalled();
  },
);

test('stops observing when another worker takes the batch lease', async () => {
  record.internalTaskId = job.internalTaskId;
  record.internalJobStatus = 'waiting';
  record.status = 'processing';
  record.retryMode = 'resume_polling';
  job.status = 'waiting';
  const task = await getBatchTask('batch-1', 'user-1');
  await tick();
  record.processingWorkerId = 'new-owner';
  job.status = 'succeeded';
  await tick(1000);
  expect(task.runnerActive).toBe(false);
  expect(record.status).toBe('processing');
  expect(record.resultImage).toBeUndefined();
  expect(mockDb.findOrCreateImageGenerationJob).not.toHaveBeenCalled();
  expect(mockPoll).not.toHaveBeenCalled();
});

test('recovers when child creation succeeds but the first batch-link write fails', async () => {
  record.status = 'pending';
  record.submitAttempt = 0;
  record.modelKey = 'apimart_gpt_image_2_text';
  job = null;
  const update = mockDb.updateImageBatchTaskItemWithLease.getMockImplementation();
  let failLink = true;
  mockDb.updateImageBatchTaskItemWithLease.mockImplementation(async (args) => {
    if (args.updates.internalTaskId && failLink) {
      failLink = false;
      throw new Error('transient batch link write failure');
    }
    return update(args);
  });
  const firstTask = await getBatchTask('batch-1', 'user-1');
  await tick();
  expect(firstTask.runnerActive).toBe(false);
  expect(job.status).toBe('waiting');
  expect(record.internalTaskId).toBeUndefined();
  expect(record.status).toBe('failed');

  job.status = 'succeeded';
  job.providerTaskId = 'paid-task';
  job.result = { images: [{ b64_json: 'data:image/png;base64,dGVzdA==' }] };
  batchTaskStore.clear();
  const recovered = await getBatchTask('batch-1', 'user-1');
  await tick();
  expect(recovered.items[0].status).toBe('success');
  expect(record.internalTaskId).toBe(job.internalTaskId);
  expect(mockDb.findOrCreateImageGenerationJob).toHaveBeenCalledTimes(1);
  expect(mockGenerate).not.toHaveBeenCalled();
  expect(mockPoll).not.toHaveBeenCalled();
});

test('keeps output-processing failure terminal on status reads until an explicit result retry', async () => {
  const { normalizeGeneratedImageOutput } = require('./normalizeImageOutput');
  normalizeGeneratedImageOutput.mockRejectedValueOnce(
    Object.assign(new Error('invalid image'), {
      code: 'IMAGE_OUTPUT_INVALID',
    }),
  );
  const task = await getBatchTask('batch-1', 'user-1');
  await tick();
  expect(task.items[0].status).toBe('failed');
  expect(record.retryMode).toBe('reprocess_result');
  expect(record.providerResult).toMatchObject({ status: 'succeeded' });
  const reads = mockDb.getImageGenerationJob.mock.calls.length;
  const fresh = await getBatchTask('batch-1', 'user-1');
  await tick();
  expect(fresh.items[0]).toMatchObject({ status: 'failed', retryMode: 'reprocess_result' });
  expect(normalizeGeneratedImageOutput).toHaveBeenCalledTimes(1);
  expect(mockDb.getImageGenerationJob).toHaveBeenCalledTimes(reads);
});

function failedAttempt() {
  Object.assign(record, {
    status: 'failed',
    modelKey: 'apimart_gpt_image_2_text',
    internalTaskId: 'child-1',
    internalJobStatus: 'failed',
    providerTaskId: 'old-provider-task',
    providerStatus: 'FAILED',
    retryMode: 'resubmit_provider',
    processingWorkerId: null,
    processingLeaseUntil: null,
  });
  Object.assign(job, {
    status: 'failed',
    providerStatus: 'FAILED',
    providerTaskId: 'old-provider-task',
  });
}
async function completeNewAttempt(task) {
  job.status = 'succeeded';
  job.providerTaskId = 'new-provider-task';
  job.result = { images: [{ b64_json: 'data:image/png;base64,dGVzdA==' }] };
  await tick(1000);
  expect(task.items[0].status).toBe('success');
  expect(record.providerTaskId).toBe('new-provider-task');
}
test('explicit retry creates a new durable attempt while repeated clicks reuse it', async () => {
  failedAttempt();
  const task = await retryBatchItem('batch-1', 'style-1', 'user-1');
  const attemptIdentity = record.internalJobItemId;
  expect(attemptIdentity).toBeTruthy();
  expect(attemptIdentity).not.toBe('item-1');
  expect(record.internalTaskId).toBeUndefined();
  expect(record.providerTaskId).toBeUndefined();
  await tick();
  expect(job.internalTaskId).not.toBe('child-1');
  expect(job.itemId).toBe(attemptIdentity);
  expect(record.internalJobStatus).toBe('waiting');
  expect(record.providerStatus).toBeUndefined();
  await retryBatchItem('batch-1', 'style-1', 'user-1');
  await tick();
  expect(record.retryCount).toBe(1);
  expect(mockDb.findOrCreateImageGenerationJob).toHaveBeenCalledTimes(1);
  expect(serializeBatchTask(task).items[0].itemId).toBe('item-1');
  expect(serializeBatchTask(task).items[0]).not.toHaveProperty('internalJobItemId');
  await completeNewAttempt(task);
});
test('concurrent explicit retries reserve only one durable attempt', async () => {
  failedAttempt();
  const results = await Promise.allSettled([
    retryBatchItem('batch-1', 'style-1', 'user-1'),
    retryBatchItem('batch-1', 'style-1', 'user-1'),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(record.internalJobItemId).toBeTruthy();
  await tick();
  expect(record.retryCount).toBe(1);
  expect(mockDb.findOrCreateImageGenerationJob).toHaveBeenCalledTimes(1);
  await completeNewAttempt(results.find((r) => r.status === 'fulfilled').value);
});
test('recovers a retry child after enqueue succeeds and linkage fails', async () => {
  failedAttempt();
  const update = mockDb.updateImageBatchTaskItemWithLease.getMockImplementation();
  let failLink = true;
  mockDb.updateImageBatchTaskItemWithLease.mockImplementation(async (args) => {
    if (args.updates.internalTaskId && failLink) {
      failLink = false;
      throw new Error('link unavailable');
    }
    return update(args);
  });
  await retryBatchItem('batch-1', 'style-1', 'user-1');
  await tick();
  expect(job.internalTaskId).not.toBe('child-1');
  expect(record.internalTaskId).toBeUndefined();
  expect(record.retryMode).toBeUndefined();
  expect(record.providerStatus).toBeUndefined();
  batchTaskStore.clear();
  const recovered = await getBatchTask('batch-1', 'user-1');
  await tick();
  expect(record.internalTaskId).toBe(job.internalTaskId);
  await completeNewAttempt(recovered);
  expect(mockDb.findOrCreateImageGenerationJob).toHaveBeenCalledTimes(1);
});
test('unknown acceptance cannot reserve a new attempt', async () => {
  failedAttempt();
  record.internalJobStatus = 'status_unknown';
  record.providerStatus = 'IN_PROGRESS';
  delete record.retryMode;
  await expect(retryBatchItem('batch-1', 'style-1', 'user-1')).rejects.toMatchObject({
    code: 'BATCH_ITEM_RETRY_NOT_SAFE',
  });
  expect(record.internalJobItemId).toBeUndefined();
  expect(mockDb.findOrCreateImageGenerationJob).not.toHaveBeenCalled();
});
test('result-only retry keeps the existing paid attempt', async () => {
  failedAttempt();
  record.internalJobItemId = 'existing-attempt';
  record.internalJobStatus = 'succeeded';
  record.providerStatus = 'SUCCEEDED';
  record.retryMode = 'reprocess_result';
  record.providerResult = {
    status: 'succeeded',
    image: { b64_json: 'data:image/png;base64,dGVzdA==' },
  };
  const task = await retryBatchItem('batch-1', 'style-1', 'user-1');
  await tick();
  expect(task.items[0].status).toBe('success');
  expect(record.internalJobItemId).toBe('existing-attempt');
  expect(record.internalTaskId).toBe('child-1');
  expect(mockDb.findOrCreateImageGenerationJob).not.toHaveBeenCalled();
});
function cacheReference(overrides = {}) {
  const referenceImage = 'data:image/png;base64,cmVmZXJlbmNl';
  record.generationMode = 'i2i';
  record.modelKey = 'apimart_gpt_image_2';
  Object.assign(record, getReferenceImageMetadata(referenceImage));
  batchTaskStore.set('batch-1', {
    id: 'batch-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    mode: 'i2i',
    createdAt: Date.now(),
    runnerActive: false,
    referenceImage,
    ...overrides,
  });
  return referenceImage;
}
test('status hydration preserves matching cached reference for a real image retry', async () => {
  failedAttempt();
  const referenceImage = cacheReference();
  const status = await getBatchTask('batch-1', 'user-1');
  expect(status.referenceImage).toBe(referenceImage);
  const task = await retryBatchItem('batch-1', 'style-1', 'user-1');
  await tick();
  expect(job.payload.imageInputs).toEqual([referenceImage]);
  await completeNewAttempt(task);
});
test.each([
  { userId: 'other-user' },
  { tenantId: 'other-tenant' },
  { mode: 't2i' },
  { referenceImage: 'data:image/png;base64,d3Jvbmc=' },
  { createdAt: new Date('2026-09-16T00:00:00Z').getTime() },
])('does not reuse mismatched or expired cached reference: %j', async (override) => {
  failedAttempt();
  cacheReference(override);
  const task = await getBatchTask('batch-1', 'user-1');
  expect(task.referenceImage).toBeUndefined();
  await retryBatchItem('batch-1', 'style-1', 'user-1');
  await tick();
  expect(mockDb.findOrCreateImageGenerationJob).not.toHaveBeenCalled();
});

test('a delayed retry cannot replace a newer attempt with unknown acceptance', async () => {
  failedAttempt();
  const update = mockDb.updateImageBatchTaskItem.getMockImplementation();
  const pending = [];
  mockDb.updateImageBatchTaskItem.mockImplementation(
    (args) => new Promise((resolve) => pending.push({ args, resolve })),
  );
  const first = retryBatchItem('batch-1', 'style-1', 'user-1');
  const second = retryBatchItem('batch-1', 'style-1', 'user-1').catch((error) => error);
  while (pending.length < 2) await Promise.resolve();
  pending[0].resolve(await update(pending[0].args));
  await first;
  const newIdentity = record.internalJobItemId;
  Object.assign(record, {
    status: 'failed',
    internalJobStatus: 'status_unknown',
    errorKind: 'provider_submit_unknown',
    retryMode: undefined,
  });
  pending[1].resolve(await update(pending[1].args));
  const rejected = await second;
  expect(rejected.code).toBe('BATCH_TASK_STATE_CONFLICT');
  expect(record.internalJobItemId).toBe(newIdentity);
  expect(record.internalJobStatus).toBe('status_unknown');
  expect(record.retryCount).toBe(1);
});
test('batch recovery keeps the durable child as the sole owner of a retried usage event', async () => {
  failedAttempt();
  const task = await retryBatchItem('batch-1', 'style-1', 'user-1');
  await tick();
  await completeNewAttempt(task);
  const { recordImageUsage } = require('~/server/services/UsageLedgerService');
  expect(recordImageUsage).not.toHaveBeenCalled();
  expect(job.itemId).toBe(record.internalJobItemId);
  expect(job.requestId).toBe(task.id);
});

describe('fal Flare batch recovery', () => {
  const metadata = {
    statusUrl: 'https://queue.fal.run/openai/gpt-image-2.5/requests/paid/status',
    responseUrl: 'https://queue.fal.run/openai/gpt-image-2.5/requests/paid',
  };
  beforeEach(() => {
    job = null;
    Object.assign(record, {
      provider: 'fal',
      model: 'openai/gpt-image-2.5/flare/text-to-image',
      modelKey: 'fal_gpt_image_2_5_flare_text',
      status: 'processing',
      providerTaskId: 'paid-fal',
      retryMode: 'resume_polling',
      providerResult: { status: 'processing', providerMetadata: metadata },
    });
    mockFalStatus.mockResolvedValue({ state: 'succeeded', providerStatus: 'COMPLETED' });
    mockFalResult.mockResolvedValue({ outputUrls: ['https://v3.fal.media/output.png'] });
  });

  test.each(['t2i', 'i2i'])(
    'resumes paid %s after memory loss without references or a second submit',
    async (mode) => {
      record.generationMode = mode;
      if (mode === 'i2i') {
        record.model = 'openai/gpt-image-2.5/flare/edit';
        record.modelKey = 'fal_gpt_image_2_5_flare_edit';
        record.hasReferenceImage = true;
      }
      const task = await getBatchTask('batch-1', 'user-1');
      await finish(task);
      expect(mockFalSubmit).not.toHaveBeenCalled();
      expect(mockFalStatus).toHaveBeenCalledWith(
        expect.objectContaining({ providerTaskId: 'paid-fal', statusUrl: metadata.statusUrl }),
      );
      expect(mockFalResult).toHaveBeenCalledWith(
        expect.objectContaining({ responseUrl: metadata.responseUrl }),
      );
      expect(record.submitAttempt).toBe(1);
      expect(JSON.stringify(serializeBatchTask(task))).not.toContain(metadata.statusUrl);
    },
  );

  test.each(['t2i', 'i2i'])(
    'persists the %s queue identity before the first status request',
    async (mode) => {
      record.status = 'pending';
      record.submitAttempt = 0;
      delete record.providerTaskId;
      delete record.providerResult;
      delete record.retryMode;
      if (mode === 'i2i') {
        cacheReference();
        record.model = 'openai/gpt-image-2.5/flare/edit';
        record.modelKey = 'fal_gpt_image_2_5_flare_edit';
      }
      mockFalSubmit.mockResolvedValue({
        providerTaskId: 'new-fal',
        providerMetadata: metadata,
        outputUrls: [],
      });
      mockFalStatus.mockImplementation(async () => {
        expect(record).toMatchObject({
          status: 'processing',
          providerTaskId: 'new-fal',
          providerResult: { providerMetadata: metadata },
        });
        return { state: 'succeeded', providerStatus: 'COMPLETED' };
      });
      const task = await getBatchTask('batch-1', 'user-1');
      await finish(task);
      expect(mockFalSubmit).toHaveBeenCalledTimes(1);
      expect(mockFalSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ num_images: 1, quality: 'medium' }),
        }),
      );
    },
  );

  test('leaves a paid task recoverable after a transient status error without finalizing usage', async () => {
    mockFalStatus.mockRejectedValueOnce(new Error('temporary disconnect'));
    const task = await getBatchTask('batch-1', 'user-1');
    await tick();
    expect(record).toMatchObject({
      status: 'processing',
      retryMode: 'resume_polling',
      providerTaskId: 'paid-fal',
    });
    expect(record.usageDelivery).toBeUndefined();
    batchTaskStore.clear();
    mockFalStatus.mockResolvedValue({ state: 'succeeded', providerStatus: 'COMPLETED' });
    await finish(await getBatchTask('batch-1', 'user-1'));
    expect(mockFalSubmit).not.toHaveBeenCalled();
    expect(task.runnerActive).toBe(false);
  });

  test('retries a failed download using the paid result without polling or generating again', async () => {
    const { normalizeGeneratedImageOutput } = require('./normalizeImageOutput');
    normalizeGeneratedImageOutput.mockRejectedValueOnce(
      Object.assign(new Error('download failed'), { code: 'RESULT_DOWNLOAD_FAILED' }),
    );
    await getBatchTask('batch-1', 'user-1');
    await tick();
    expect(record).toMatchObject({
      status: 'failed',
      retryMode: 'reprocess_result',
      providerResult: { status: 'succeeded' },
    });
    const statusReads = mockFalStatus.mock.calls.length;
    const resultReads = mockFalResult.mock.calls.length;
    await finish(await retryBatchItem('batch-1', 'style-1', 'user-1'));
    expect(mockFalSubmit).not.toHaveBeenCalled();
    expect(mockFalStatus).toHaveBeenCalledTimes(statusReads);
    expect(mockFalResult).toHaveBeenCalledTimes(resultReads);
    expect(record.submitAttempt).toBe(1);
  });

  test('a definitive provider failure allows an explicit new attempt, never an automatic one', async () => {
    mockFalStatus.mockResolvedValueOnce({ state: 'failed', providerStatus: 'FAILED' });
    await getBatchTask('batch-1', 'user-1');
    await tick();
    expect(record).toMatchObject({
      status: 'failed',
      retryMode: 'resubmit_provider',
      providerStatus: 'FAILED',
    });
    expect(mockFalSubmit).not.toHaveBeenCalled();
    mockFalSubmit.mockResolvedValueOnce({
      providerTaskId: 'retry-fal',
      providerMetadata: metadata,
      outputUrls: [],
    });
    await finish(await retryBatchItem('batch-1', 'style-1', 'user-1'));
    expect(record).toMatchObject({ providerTaskId: 'retry-fal', submitAttempt: 2 });
    expect(mockFalSubmit).toHaveBeenCalledTimes(1);
  });

  test.each([
    { code: 'FAL_NO_IMAGE' },
    { code: 'FAL_HTTP_404', statusCode: 404, providerResponseParsed: true },
  ])(
    'shows permanent result-read failure %j and only retries the existing task explicitly',
    async (details) => {
      mockFalResult.mockRejectedValueOnce(Object.assign(new Error('result unavailable'), details));
      const task = await getBatchTask('batch-1', 'user-1');
      await tick();
      expect(task.items[0]).toMatchObject({ status: 'failed', retryMode: 'resume_polling' });
      expect(record).toMatchObject({
        status: 'failed',
        providerTaskId: 'paid-fal',
        providerResult: { providerMetadata: metadata },
      });
      batchTaskStore.clear();
      const readCount = mockFalResult.mock.calls.length;
      await getBatchTask('batch-1', 'user-1');
      await tick();
      expect(mockFalResult).toHaveBeenCalledTimes(readCount);
      await finish(await retryBatchItem('batch-1', 'style-1', 'user-1'));
      expect(mockFalSubmit).not.toHaveBeenCalled();
    },
  );

  test('refuses to resubmit after an ambiguous submission', async () => {
    record.status = 'pending';
    delete record.providerTaskId;
    delete record.providerResult;
    delete record.retryMode;
    mockFalSubmit.mockRejectedValue(
      Object.assign(new Error('connection lost'), { submitOutcome: 'unknown' }),
    );
    await getBatchTask('batch-1', 'user-1');
    await tick();
    await expect(retryBatchItem('batch-1', 'style-1', 'user-1')).rejects.toMatchObject({
      code: 'BATCH_ITEM_RETRY_NOT_SAFE',
    });
    expect(mockFalSubmit).toHaveBeenCalledTimes(1);
  });
});
