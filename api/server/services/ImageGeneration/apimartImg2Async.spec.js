const mockFindOrCreateImageGenerationJob = jest.fn();
const mockCreateImageGenerationJob = jest.fn();
const mockLoggerInfo = jest.fn();
const mockStartWorker = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: (...args) => mockLoggerInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('~/models', () => ({
  findOrCreateImageGenerationJob: (...args) => mockFindOrCreateImageGenerationJob(...args),
  createImageGenerationJob: (...args) => mockCreateImageGenerationJob(...args),
}));

jest.mock('~/server/services/UsageLedgerService', () => ({
  admitImageUsage: jest.fn(async () => null),
  releaseImageUsage: jest.fn(async () => {}),
  buildImageUsageEnvelope: jest.fn(() => null),
  recordImageUsage: jest.fn(),
}));

jest.mock('~/server/services/ImageGeneration/adapters/apimart', () => ({
  generateAPIMartImage: jest.fn(),
  resumeAPIMartImage: jest.fn(),
}));

jest.mock('~/server/services/ImageGeneration/adapters/apimart/common', () => ({
  getAPIMartConfig: jest.fn(() => ({ apiKey: 'test-apimart-key' })),
}));

jest.mock('~/server/services/ImageGeneration/resultProxy', () => ({
  extractHostname: jest.fn(() => 'example.test'),
  registerResultImage: jest.fn(),
  registerResultImageBuffer: jest.fn(),
}));

jest.mock('~/server/services/ImageGeneration/apimartImg2JobWorker', () => ({
  createAPIMartImg2JobWorker: (...args) => mockStartWorker(...args),
  createAPIMartImg2ProviderAdapter: jest.fn(),
  createMongoAPIMartImg2JobStore: jest.fn(),
}));

function createJobInput(overrides = {}) {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    requestId: 'request-1',
    frontendTaskId: 'frontend-task-1',
    businessType: 'image_generation',
    taskType: 'text-to-image',
    provider: 'apimart',
    model: 'gpt-image-2',
    modelKey: 'apimart_gpt_image_2_text',
    payload: { prompt: 'not logged' },
    ...overrides,
  };
}

describe('APIMart img2 async rollout service', () => {
  test('enqueues Sunburst with its own identity and the existing shared resource', async () => {
    process.env.APIMART_IMG2_ASYNC_MODE = 'all';
    const { isAPIMartImg2ResolvedModel, enqueueAPIMartImg2Job } = require('./apimartImg2Async');
    expect(
      isAPIMartImg2ResolvedModel({ provider: 'apimart', model: 'gpt-image-2.5-sunburst' }),
    ).toBe(true);
    expect(isAPIMartImg2ResolvedModel({ provider: 'fal', model: 'gpt-image-2.5-sunburst' })).toBe(
      false,
    );
    await enqueueAPIMartImg2Job(createJobInput());
    const oldInput = mockFindOrCreateImageGenerationJob.mock.calls[0][0];
    await enqueueAPIMartImg2Job(
      createJobInput({
        model: 'gpt-image-2.5-sunburst',
        modelKey: 'apimart_gpt_image_2_5_sunburst',
        taskType: 'multi-reference',
      }),
    );
    const newInput = mockFindOrCreateImageGenerationJob.mock.calls[1][0];
    expect(newInput).toMatchObject({
      model: 'gpt-image-2.5-sunburst',
      modelKey: 'apimart_gpt_image_2_5_sunburst',
      resourceKey: oldInput.resourceKey,
      workerEligible: true,
      asyncVersion: 2,
    });
    expect(newInput.resourceKey).toMatch(/^apimart:[a-f0-9]+:gpt-image-2$/);
  });

  const originalAsyncMode = process.env.APIMART_IMG2_ASYNC_MODE;
  const originalCanaryUserIds = process.env.APIMART_IMG2_ASYNC_CANARY_USER_IDS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test';
    delete process.env.APIMART_IMG2_ASYNC_MODE;
    delete process.env.APIMART_IMG2_ASYNC_CANARY_USER_IDS;
    mockFindOrCreateImageGenerationJob.mockResolvedValue({
      job: {
        internalTaskId: 'internal-task-1',
        status: 'waiting',
        submittedToProvider: false,
        queueEnteredAt: new Date('2026-08-05T00:00:00.000Z'),
      },
      deduplicated: false,
    });
  });

  afterAll(() => {
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

  test('does not enqueue an async job when rollout mode is off', async () => {
    const { enqueueAPIMartImg2Job } = require('./apimartImg2Async');

    await expect(enqueueAPIMartImg2Job(createJobInput())).rejects.toMatchObject({
      code: 'APIMART_IMG2_ASYNC_DISABLED',
      statusCode: 400,
    });
    expect(mockFindOrCreateImageGenerationJob).not.toHaveBeenCalled();
    expect(mockCreateImageGenerationJob).not.toHaveBeenCalled();
  });

  test('enqueues canary jobs with v2 worker eligibility metadata', async () => {
    process.env.APIMART_IMG2_ASYNC_MODE = 'canary';
    process.env.APIMART_IMG2_ASYNC_CANARY_USER_IDS = 'user-1';
    const { enqueueAPIMartImg2Job } = require('./apimartImg2Async');

    const job = await enqueueAPIMartImg2Job(createJobInput());

    expect(job).toEqual(
      expect.objectContaining({
        internalTaskId: 'internal-task-1',
        status: 'waiting',
        submittedToProvider: false,
        deduplicated: false,
      }),
    );
    expect(mockFindOrCreateImageGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        asyncVersion: 2,
        rolloutMode: 'canary',
        workerEligible: true,
      }),
    );
  });

  test('rejects oversized inline image payloads before Mongo BSON serialization', async () => {
    process.env.APIMART_IMG2_ASYNC_MODE = 'canary';
    process.env.APIMART_IMG2_ASYNC_CANARY_USER_IDS = 'user-1';
    const { enqueueAPIMartImg2Job } = require('./apimartImg2Async');
    const largeImage = Buffer.alloc(4_700_000, 0xab);
    const oversizedImageInputs = Array.from(
      { length: 3 },
      () => `data:image/png;base64,${largeImage.toString('base64')}`,
    );

    await expect(
      enqueueAPIMartImg2Job(
        createJobInput({
          taskType: 'multi-reference',
          modelKey: 'apimart_gpt_image_2',
          payload: {
            prompt: 'oversized inline payload',
            imageInputs: oversizedImageInputs,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'APIMART_IMG2_JOB_PAYLOAD_TOO_LARGE',
      statusCode: 413,
    });
    expect(mockFindOrCreateImageGenerationJob).not.toHaveBeenCalled();
  });
});
