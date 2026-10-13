const express = require('express');
const request = require('supertest');
const { BSON } = require('bson');

const mockEnqueueAPIMartImg2Job = jest.fn();
const mockGetAPIMartImg2JobStatus = jest.fn();
const mockGenerateAPIMartImage = jest.fn();
const mockShouldUseAPIMartImg2AsyncForUser = jest.fn();
const mockUploadImageBuffer = jest.fn();
const mockUpdateFile = jest.fn();
const mockDeleteFile = jest.fn();
const mockRecordImageUsage = jest.fn();
const mockAdmitImageUsage = jest.fn(async () => null);
const mockRecordImageGenerationResult = jest.fn();
const mockDeleteStorageFile = jest.fn();
const mockGetStrategyFunctions = jest.fn();
const mockFindOrEnqueueImageEgressJob = jest.fn();
const mockGetImageEgressJobStatus = jest.fn();
const mockReadImageEgressJobOutput = jest.fn();
const mockShouldUseImageEgressAsyncForUser = jest.fn();
const mockGenerateFalImage = jest.fn();
const mockGenerateSiliconEdit = jest.fn();
const mockConfigMiddleware = jest.fn();
const mockLoggerInfo = jest.fn();

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

function installRouteMocks() {
  jest.doMock('@librechat/data-schemas', () => ({
    logger: {
      debug: jest.fn(),
      error: jest.fn(),
      info: (...args) => mockLoggerInfo(...args),
      warn: jest.fn(),
    },
  }));
  jest.doMock('~/server/middleware', () => ({
    requireJwtAuth: (req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1' };
      next();
    },
    configMiddleware: (...args) => mockConfigMiddleware(...args),
  }));

  jest.doMock('sharp', () =>
    jest.fn((buffer = tinyPng) => {
      const outputBuffer = Buffer.isBuffer(buffer) ? buffer : tinyPng;
      return {
        metadata: jest.fn().mockResolvedValue({
          format: 'png',
          width: 1,
          height: 1,
          hasAlpha: false,
          channels: 4,
        }),
        rotate: jest.fn(function rotate() {
          return this;
        }),
        flatten: jest.fn(function flatten() {
          return this;
        }),
        removeAlpha: jest.fn(function removeAlpha() {
          return this;
        }),
        png: jest.fn(function png() {
          return this;
        }),
        toBuffer: jest.fn().mockResolvedValue(outputBuffer),
      };
    }),
  );

  jest.doMock('~/server/services/ImageGeneration/prompt', () => ({
    NEGATIVE_PROMPT: '',
    DEFAULT_ASPECT_RATIOS: {},
    PLATFORM_TYPE_ASPECT_RATIOS: {},
    buildDualReferencePrompt: jest.fn(({ prompt }) => prompt),
    buildMultiReferencePrompt: jest.fn(({ prompt }) => prompt),
    buildPrompt: jest.fn(({ prompt }) => prompt),
    buildWhiteBackgroundScenePrompt: jest.fn(({ prompt }) => prompt),
    getImageSize: jest.fn(() => '1024x1024'),
  }));

  jest.doMock('~/server/services/ImageGeneration/siliconflow', () => ({
    TEXT_TO_IMAGE_MODEL: 'siliconflow-text-model',
    IMAGE_TO_IMAGE_MODEL: 'siliconflow-edit-model',
    generateTextToImage: jest.fn(),
    generateImageToImage: (...args) => mockGenerateSiliconEdit(...args),
  }));

  jest.doMock('~/server/services/ImageGeneration/adapters/apimart', () => ({
    generateAPIMartImage: (...args) => mockGenerateAPIMartImage(...args),
  }));

  jest.doMock('~/server/services/ImageGeneration/adapters/fal', () => ({
    generateFalImage: (...args) => mockGenerateFalImage(...args),
  }));

  jest.doMock('~/server/services/ImageGeneration/adapters/ark', () => ({
    generateArkImage: jest.fn(),
  }));

  jest.doMock('~/server/services/ImageGeneration/apimartImg2Async', () => ({
    enqueueAPIMartImg2Job: (...args) => mockEnqueueAPIMartImg2Job(...args),
    getAPIMartImg2JobStatus: (...args) => mockGetAPIMartImg2JobStatus(...args),
    isAPIMartImg2ResolvedModel: jest.requireActual(
      '~/server/services/ImageGeneration/apimartImg2Async',
    ).isAPIMartImg2ResolvedModel,
    shouldUseAPIMartImg2AsyncForUser: (...args) => mockShouldUseAPIMartImg2AsyncForUser(...args),
  }));

  jest.doMock('~/server/services/ImageGeneration/imageEgressAsync', () => ({
    findOrStageAndEnqueueImageEgressJob: (...args) => mockFindOrEnqueueImageEgressJob(...args),
    getImageEgressJobStatus: (...args) => mockGetImageEgressJobStatus(...args),
    isImageEgressAsyncResolvedModel: (resolvedModel) =>
      resolvedModel?.provider === 'fal' && resolvedModel?.model === 'openai/gpt-image-2',
    readImageEgressJobOutput: (...args) => mockReadImageEgressJobOutput(...args),
    shouldUseImageEgressAsyncForUser: (...args) => mockShouldUseImageEgressAsyncForUser(...args),
  }));

  jest.doMock('~/server/services/ImageGeneration/models', () =>
    jest.requireActual('~/server/services/ImageGeneration/models'),
  );

  jest.doMock('~/server/services/ImageGeneration/outputQuality', () => ({
    DEFAULT_OUTPUT_QUALITY: 'standard',
    OUTPUT_QUALITY_OPTIONS: [],
    resolveSingleImageOutputQuality: jest.fn(({ fallbackSize }) => ({
      size: fallbackSize || '1024x1024',
      requestedOutputQuality: 'standard',
      effectiveOutputQuality: 'standard',
      downgraded: false,
    })),
  }));

  jest.doMock('~/server/services/ImageGeneration/resultRecorder', () => ({
    recordImageGenerationResult: (...args) => mockRecordImageGenerationResult(...args),
  }));

  jest.doMock('~/server/services/ImageGeneration/normalizeImageOutput', () => ({
    normalizeGeneratedImageResult: jest.fn(({ result }) => result),
  }));

  jest.doMock('~/server/services/ImageGeneration/resultProxy', () => ({
    extractHostname: jest.fn(() => 'example.test'),
    getResultImage: jest.fn(() => null),
    isHostAllowed: jest.fn(() => true),
    registerResultImage: jest.fn(() => ({
      proxyPath: '/api/image-generation/result-image/token',
      downloadPath: '/api/image-generation/result-image/token/download',
    })),
    registerResultImageBuffer: jest.fn(() => ({
      proxyPath: '/api/image-generation/result-image/token',
      downloadPath: '/api/image-generation/result-image/token/download',
    })),
  }));

  jest.doMock('~/server/services/ImageGeneration/promptTemplateStore', () => ({
    CATEGORY_BATCH_PACKAGING: 'batch_packaging',
    createPromptTemplate: jest.fn(),
    deletePromptTemplate: jest.fn(),
    duplicatePromptTemplate: jest.fn(),
    formatPromptTemplate: jest.fn((template) => template?.prompt || ''),
    listPromptTemplates: jest.fn(async () => []),
    restorePromptTemplateDefault: jest.fn(),
    updatePromptTemplate: jest.fn(),
  }));

  jest.doMock('~/server/services/UsageLedgerService', () => ({
    recordImageUsage: (...args) => mockRecordImageUsage(...args),
    admitImageUsage: (...args) => mockAdmitImageUsage(...args),
  }));

  jest.doMock('~/server/services/Files/process', () => ({
    uploadImageBuffer: (...args) => mockUploadImageBuffer(...args),
  }));

  jest.doMock('~/server/services/Files/strategies', () => ({
    getStrategyFunctions: (...args) => mockGetStrategyFunctions(...args),
  }));

  jest.doMock('~/models', () => ({
    updateFile: (...args) => mockUpdateFile(...args),
    deleteFile: (...args) => mockDeleteFile(...args),
  }));
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/image-generation', imageGenerationRouter);
  return app;
}

let imageGenerationRouter;

describe('image generation APIMart img2 async routes', () => {
  beforeAll(() => {
    jest.resetModules();
    installRouteMocks();
    imageGenerationRouter = require('./imageGeneration');
  });

  beforeEach(() => {
    [
      mockEnqueueAPIMartImg2Job,
      mockGetAPIMartImg2JobStatus,
      mockGenerateAPIMartImage,
      mockShouldUseAPIMartImg2AsyncForUser,
      mockUploadImageBuffer,
      mockUpdateFile,
      mockDeleteFile,
      mockRecordImageUsage,
      mockRecordImageGenerationResult,
      mockDeleteStorageFile,
      mockGetStrategyFunctions,
      mockFindOrEnqueueImageEgressJob,
      mockGetImageEgressJobStatus,
      mockReadImageEgressJobOutput,
      mockShouldUseImageEgressAsyncForUser,
      mockGenerateFalImage,
      mockGenerateSiliconEdit,
      mockConfigMiddleware,
      mockLoggerInfo,
    ].forEach((mock) => mock.mockReset());
    mockConfigMiddleware.mockImplementation((req, _res, next) => {
      req.config = { fileStrategy: 's3' };
      next();
    });
    mockEnqueueAPIMartImg2Job.mockResolvedValue({
      internalTaskId: 'internal-task-1',
      status: 'waiting',
      submittedToProvider: false,
      deduplicated: false,
    });
    mockGetAPIMartImg2JobStatus.mockResolvedValue({
      internalTaskId: 'internal-task-1',
      state: 'success',
      status: 'succeeded',
      submittedToProvider: true,
      images: [{ url: '/api/image-generation/result-image/token', downloadUrl: '/download' }],
    });
    mockGenerateAPIMartImage.mockRejectedValue(new Error('sync APIMart provider should not run'));
    mockGenerateSiliconEdit.mockResolvedValue({
      images: [{ url: 'https://example.test/white-background.png' }],
    });
    mockShouldUseAPIMartImg2AsyncForUser.mockReturnValue(true);
    mockShouldUseImageEgressAsyncForUser.mockReturnValue('canary');
    mockFindOrEnqueueImageEgressJob.mockResolvedValue({
      created: true,
      job: {
        internalTaskId: 'fal-text-task-1',
        status: 'waiting',
        submittedToProvider: false,
      },
    });
    mockRecordImageGenerationResult.mockResolvedValue(undefined);
    mockRecordImageUsage.mockResolvedValue(undefined);
    mockDeleteStorageFile.mockResolvedValue(undefined);
    mockGetStrategyFunctions.mockReturnValue({ deleteFile: mockDeleteStorageFile });
    mockUploadImageBuffer.mockImplementation(async ({ req, metadata }) => {
      if (!req.config) {
        throw new TypeError("Cannot read properties of undefined (reading 'fileStrategy')");
      }
      return {
        file_id: metadata.file_id,
        filename: metadata.filename,
        type: metadata.type,
        bytes: metadata.bytes,
        width: metadata.width,
        height: metadata.height,
        source: 's3',
        filepath: `https://cdn.example.test/images/user-1/${metadata.filename}`,
        storageKey: `r/us-east-2/images/user-1/${metadata.filename}`,
        storageRegion: 'us-east-2',
      };
    });
    mockUpdateFile.mockResolvedValue({ file_id: 'updated-file' });
    mockDeleteFile.mockResolvedValue({});
  });

  afterAll(() => {
    imageGenerationRouter = null;
    jest.resetModules();
  });

  test('capacity rejection returns 503 before sync provider submission while config stays readable', async () => {
    mockShouldUseAPIMartImg2AsyncForUser.mockReturnValue(false);
    mockAdmitImageUsage.mockRejectedValueOnce(
      Object.assign(new Error('暂时无法开始新任务，请稍后再试'), {
        statusCode: 503,
        code: 'USAGE_CAPTURE_UNAVAILABLE',
      }),
    );
    const app = createApp();
    expect((await request(app).get('/api/image-generation/config')).status).toBe(200);
    const response = await request(app).post('/api/image-generation/text-to-image').send({
      modelKey: 'apimart_gpt_image_2_5_flare',
      prompt: 'Synthetic box',
      count: 1,
      aspectRatio: '1:1',
    });
    expect(response.status).toBe(503);
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test('exposes Flare and sends a four-image text request to APIMart durable jobs', async () => {
    const app = createApp();
    const config = await request(app).get('/api/image-generation/config');
    expect(config.body.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelKey: 'apimart_gpt_image_2_5_flare',
          model: 'gpt-image-2.5-flare',
          provider: 'apimart',
        }),
      ]),
    );
    const response = await request(app).post('/api/image-generation/text-to-image').send({
      modelKey: 'apimart_gpt_image_2_5_flare',
      prompt: 'Synthetic box',
      count: 4,
      aspectRatio: '16:9',
    });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      provider: 'apimart',
      model: 'gpt-image-2.5-flare',
      internalTaskId: 'internal-task-1',
    });
    expect(mockEnqueueAPIMartImg2Job).toHaveBeenCalledWith(
      expect.objectContaining({
        modelKey: 'apimart_gpt_image_2_5_flare',
        model: 'gpt-image-2.5-flare',
        taskType: 'text-to-image',
        payload: expect.objectContaining({ count: 4 }),
      }),
    );
    expect(mockFindOrEnqueueImageEgressJob).not.toHaveBeenCalled();
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test('retains every synchronous Flare result and provider cost outside async rollout', async () => {
    mockShouldUseAPIMartImg2AsyncForUser.mockReturnValue(false);
    mockGenerateAPIMartImage.mockResolvedValue({
      taskId: 'flare-sync',
      images: [{ url: 'https://example.test/a.png' }, { url: 'https://example.test/b.png' }],
      cost: 0.02,
      json: { data: { credits_cost: 0.2 } },
    });
    const response = await request(createApp())
      .post('/api/image-generation/text-to-image')
      .send({ modelKey: 'apimart_gpt_image_2_5_flare', prompt: 'Synthetic box', count: 2 });
    expect(response.status).toBe(200);
    expect(response.body.images).toHaveLength(2);
    expect(mockRecordImageUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-2.5-flare',
        modelKey: 'apimart_gpt_image_2_5_flare',
        imageCount: 2,
        metadata: { providerCost: 0.02, providerCreditsCost: 0.2 },
      }),
    );
  });

  test('scoped-routes GPT Image 2 text-to-image to Fal durable async', async () => {
    const app = createApp();

    const response = await request(app).post('/api/image-generation/text-to-image').send({
      modelKey: 'apimart_gpt_image_2_text',
      frontendTaskId: 'frontend-explicit-click-1',
      prompt: 'a safe test prompt',
      platform: '通用',
      imageType: '通用营销图',
      aspectRatio: '1:1',
      count: 1,
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(
      expect.objectContaining({
        state: 'queued',
        status: 'waiting',
        internalTaskId: 'fal-text-task-1',
        deduplicated: false,
        submittedToProvider: false,
        provider: 'fal',
        model: 'openai/gpt-image-2',
      }),
    );
    expect(mockFindOrEnqueueImageEgressJob).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        frontendTaskId: 'frontend-explicit-click-1',
        businessType: 'image_generation',
        taskType: 'text-to-image',
        provider: 'fal',
        model: 'openai/gpt-image-2',
        modelKey: 'apimart_gpt_image_2_text',
        rolloutMode: 'canary',
      }),
    );
    expect(mockEnqueueAPIMartImg2Job).not.toHaveBeenCalled();
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockGenerateFalImage).not.toHaveBeenCalled();
  });

  test('fails closed without APIMart or synchronous Fal fallback when durable async is disabled', async () => {
    const app = createApp();
    mockShouldUseImageEgressAsyncForUser.mockReturnValue(null);

    const response = await request(app).post('/api/image-generation/text-to-image').send({
      modelKey: 'apimart_gpt_image_2_text',
      frontendTaskId: 'frontend-explicit-click-1',
      prompt: 'a safe test prompt',
      platform: '通用',
      imageType: '通用营销图',
      aspectRatio: '1:1',
      count: 1,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        errorCode: 'IMAGE_EGRESS_ASYNC_DISABLED',
      }),
    );
    expect(mockFindOrEnqueueImageEgressJob).not.toHaveBeenCalled();
    expect(mockEnqueueAPIMartImg2Job).not.toHaveBeenCalled();
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockGenerateFalImage).not.toHaveBeenCalled();
  });

  test('returns the original Fal internal task when the same frontend task is replayed', async () => {
    const app = createApp();
    mockFindOrEnqueueImageEgressJob.mockResolvedValueOnce({
      created: false,
      job: {
        internalTaskId: 'fal-text-existing-1',
        status: 'waiting',
        submittedToProvider: false,
      },
    });

    const response = await request(app).post('/api/image-generation/text-to-image').send({
      modelKey: 'apimart_gpt_image_2_text',
      frontendTaskId: 'frontend-explicit-click-1',
      prompt: 'a safe test prompt',
      platform: '通用',
      imageType: '通用营销图',
      aspectRatio: '1:1',
      count: 1,
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(
      expect.objectContaining({
        internalTaskId: 'fal-text-existing-1',
        deduplicated: true,
        submittedToProvider: false,
      }),
    );
    expect(mockFindOrEnqueueImageEgressJob).toHaveBeenCalledWith(
      expect.objectContaining({
        frontendTaskId: 'frontend-explicit-click-1',
        provider: 'fal',
        model: 'openai/gpt-image-2',
      }),
    );
    expect(mockEnqueueAPIMartImg2Job).not.toHaveBeenCalled();
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockGenerateFalImage).not.toHaveBeenCalled();
  });

  test('returns internal APIMart task status without calling the provider', async () => {
    const app = createApp();

    const response = await request(app).get('/api/image-generation/tasks/internal-task-1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        internalTaskId: 'internal-task-1',
        state: 'success',
        status: 'succeeded',
        submittedToProvider: true,
        images: expect.any(Array),
      }),
    );
    expect(mockGetAPIMartImg2JobStatus).toHaveBeenCalledWith({
      internalTaskId: 'internal-task-1',
      userId: 'user-1',
    });
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test.each(['image-to-image', 'multi-reference'])(
    'keeps Sunburst billing for synchronous %s',
    async (route) => {
      mockShouldUseAPIMartImg2AsyncForUser.mockReturnValue(false);
      mockGenerateAPIMartImage.mockResolvedValue({
        images: [{ url: 'https://example.test/output.png' }],
        taskId: 'paid-task',
        cost: 0.017666,
        json: { data: { credits_cost: 0.17666 } },
      });
      let pending = request(createApp())
        .post('/api/image-generation/' + route)
        .field('modelKey', 'apimart_gpt_image_2_5_sunburst')
        .field('prompt', 'Edit packaging');
      if (route === 'image-to-image')
        pending = pending.attach('image', tinyPng, {
          filename: 'product.png',
          contentType: 'image/png',
        });
      else
        pending = pending
          .field('subMode', 'dual-product-replace')
          .attach('images', tinyPng, { filename: 'product.png', contentType: 'image/png' })
          .attach('images', tinyPng, { filename: 'scene.png', contentType: 'image/png' });
      const response = await pending;
      expect(response.status).toBe(200);
      expect(mockRecordImageUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          model: 'gpt-image-2.5-sunburst',
          status: 'succeeded',
          metadata: { providerCost: 0.017666, providerCreditsCost: 0.17666 },
        }),
      );
    },
  );

  test.each(['image-to-image', 'multi-reference'])(
    'queues Sunburst %s using the real registry and async eligibility',
    async (route) => {
      let pending = request(createApp())
        .post('/api/image-generation/' + route)
        .field('modelKey', 'apimart_gpt_image_2_5_sunburst')
        .field('prompt', 'Keep the packaging text')
        .field('aspectRatio', '1:1');
      if (route === 'image-to-image') {
        pending = pending.attach('image', tinyPng, {
          filename: 'reference.png',
          contentType: 'image/png',
        });
      } else {
        pending = pending
          .field('subMode', 'dual-product-replace')
          .attach('images', tinyPng, { filename: 'product.png', contentType: 'image/png' })
          .attach('images', tinyPng, { filename: 'scene.png', contentType: 'image/png' });
      }
      const response = await pending;
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({
        provider: 'apimart',
        model: 'gpt-image-2.5-sunburst',
        modelKey: 'apimart_gpt_image_2_5_sunburst',
      });
      expect(mockEnqueueAPIMartImg2Job).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-image-2.5-sunburst',
          modelKey: 'apimart_gpt_image_2_5_sunburst',
          payload: expect.objectContaining({ imageInputRefs: expect.any(Array) }),
        }),
      );
      expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    },
  );

  test('returns 202 for APIMart image-to-image without synchronously calling the provider', async () => {
    const app = createApp();
    mockEnqueueAPIMartImg2Job.mockResolvedValueOnce({
      internalTaskId: 'internal-i2i-task-1',
      status: 'waiting',
      submittedToProvider: false,
    });

    const response = await request(app)
      .post('/api/image-generation/image-to-image')
      .field('modelKey', 'apimart_gpt_image_2')
      .field('prompt', 'replace the product background')
      .field('platform', '通用')
      .field('imageType', '通用营销图')
      .field('aspectRatio', '1:1')
      .attach('image', tinyPng, { filename: 'product.png', contentType: 'image/png' });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(
      expect.objectContaining({
        state: 'queued',
        status: 'waiting',
        internalTaskId: 'internal-i2i-task-1',
        submittedToProvider: false,
      }),
    );
    expect(mockEnqueueAPIMartImg2Job).toHaveBeenCalledWith(
      expect.objectContaining({
        businessType: 'product_replacement',
        taskType: 'single-image-edit',
        provider: 'apimart',
        model: 'gpt-image-2',
        modelKey: 'apimart_gpt_image_2',
      }),
    );
    const enqueueInput = mockEnqueueAPIMartImg2Job.mock.calls[0][0];
    expect(enqueueInput.payload.imageInputs).toBeUndefined();
    expect(enqueueInput.payload.imageInputRefs).toHaveLength(1);
    expect(enqueueInput.payload.imageInputRefs[0]).toEqual(
      expect.objectContaining({
        kind: 'file',
        index: 0,
        fileId: expect.any(String),
        mimeType: 'image/png',
      }),
    );
    expect(mockUploadImageBuffer).toHaveBeenCalledTimes(1);
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      '[ImageGeneration] async job response written',
      expect.objectContaining({
        requestId: expect.any(String),
        route: '/image-to-image',
        request_received_at: expect.any(String),
        job_created_at: expect.any(String),
        http_response_written_at: expect.any(String),
        internalTaskId: 'internal-i2i-task-1',
        statusCode: 202,
      }),
    );
  });

  test('returns 202 for APIMart multi-reference without synchronously calling the provider', async () => {
    const app = createApp();
    mockEnqueueAPIMartImg2Job.mockResolvedValueOnce({
      internalTaskId: 'internal-multi-task-1',
      status: 'waiting',
      submittedToProvider: false,
    });

    const response = await request(app)
      .post('/api/image-generation/multi-reference')
      .field('modelKey', 'apimart_gpt_image_2')
      .field('prompt', 'combine the product references')
      .field('platform', '通用')
      .field('imageType', '通用营销图')
      .field('aspectRatio', '1:1')
      .field('subMode', 'dual-product-replace')
      .attach('images', tinyPng, { filename: 'reference-1.png', contentType: 'image/png' })
      .attach('images', tinyPng, { filename: 'reference-2.png', contentType: 'image/png' });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(
      expect.objectContaining({
        state: 'queued',
        status: 'waiting',
        internalTaskId: 'internal-multi-task-1',
        submittedToProvider: false,
      }),
    );
    expect(mockEnqueueAPIMartImg2Job).toHaveBeenCalledWith(
      expect.objectContaining({
        businessType: 'product_replacement',
        taskType: 'multi-reference',
        subMode: 'dual-product-replace',
        provider: 'apimart',
        model: 'gpt-image-2',
        modelKey: 'apimart_gpt_image_2',
      }),
    );
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      '[ImageGeneration] async job response written',
      expect.objectContaining({
        requestId: expect.any(String),
        route: '/multi-reference',
        request_received_at: expect.any(String),
        job_created_at: expect.any(String),
        http_response_written_at: expect.any(String),
        internalTaskId: 'internal-multi-task-1',
        statusCode: 202,
      }),
    );
  });

  test('keeps white-background independent from config-dependent input staging', async () => {
    const previousKey = process.env.SILICONFLOW_API_KEY;
    process.env.SILICONFLOW_API_KEY = 'synthetic-test-key';

    try {
      const response = await request(createApp())
        .post('/api/image-generation/white-background')
        .attach('image', tinyPng, { filename: 'product.png', contentType: 'image/png' });

      expect(response.status).toBe(200);
      expect(mockGenerateSiliconEdit).toHaveBeenCalledTimes(1);
      expect(mockConfigMiddleware).not.toHaveBeenCalled();
      expect(mockUploadImageBuffer).not.toHaveBeenCalled();
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        '[ImageGeneration] successful HTTP response written',
        expect.objectContaining({
          requestId: expect.any(String),
          route: '/white-background',
          request_received_at: expect.any(String),
          http_response_written_at: expect.any(String),
          statusCode: 200,
        }),
      );
    } finally {
      if (previousKey === undefined) {
        delete process.env.SILICONFLOW_API_KEY;
      } else {
        process.env.SILICONFLOW_API_KEY = previousKey;
      }
    }
  });

  test('externalizes oversized APIMart multi-reference inputs before creating the async job', async () => {
    const app = createApp();
    const oversizedPng = Buffer.alloc(4_700_000, 0xab);
    mockEnqueueAPIMartImg2Job.mockResolvedValueOnce({
      internalTaskId: 'internal-oversized-multi-task-1',
      status: 'waiting',
      submittedToProvider: false,
    });

    const response = await request(app)
      .post('/api/image-generation/multi-reference')
      .field('modelKey', 'apimart_gpt_image_2')
      .field('frontendTaskId', 'frontend-large-multi-1')
      .field('prompt', 'replace product with large references')
      .field('platform', '通用')
      .field('imageType', '通用营销图')
      .field('aspectRatio', '1:1')
      .field('subMode', 'dual-product-replace')
      .attach('images', oversizedPng, { filename: 'reference-1.png', contentType: 'image/png' })
      .attach('images', oversizedPng, { filename: 'reference-2.png', contentType: 'image/png' })
      .attach('images', oversizedPng, { filename: 'reference-3.png', contentType: 'image/png' });

    expect(response.status).toBe(202);
    const enqueueInput = mockEnqueueAPIMartImg2Job.mock.calls[0][0];
    const legacyInlinePayload = {
      payload: {
        imageInputs: Array.from(
          { length: 3 },
          () => `data:image/png;base64,${oversizedPng.toString('base64')}`,
        ),
      },
    };
    expect(BSON.calculateObjectSize(legacyInlinePayload)).toBeGreaterThan(17 * 1024 * 1024);
    expect(() => BSON.serialize({ payload: enqueueInput.payload })).not.toThrow();
    expect(BSON.calculateObjectSize({ payload: enqueueInput.payload })).toBeLessThan(1024 * 1024);
    expect(enqueueInput.payload.imageInputs).toBeUndefined();
    expect(enqueueInput.payload.imageInputRefs).toHaveLength(3);
    expect(enqueueInput.payload.imageInputRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ index: 0, fileId: expect.any(String), mimeType: 'image/png' }),
        expect.objectContaining({ index: 1, fileId: expect.any(String), mimeType: 'image/png' }),
        expect.objectContaining({ index: 2, fileId: expect.any(String), mimeType: 'image/png' }),
      ]),
    );
    expect(mockUploadImageBuffer).toHaveBeenCalledTimes(3);
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test('cleans staged multi-reference inputs when async job creation fails', async () => {
    const app = createApp();
    const enqueueError = new Error('图片任务元数据过大，请压缩参考图或减少输入后重试。');
    enqueueError.code = 'APIMART_IMG2_JOB_PAYLOAD_TOO_LARGE';
    enqueueError.statusCode = 413;
    mockEnqueueAPIMartImg2Job.mockRejectedValueOnce(enqueueError);

    const response = await request(app)
      .post('/api/image-generation/multi-reference')
      .field('modelKey', 'apimart_gpt_image_2')
      .field('frontendTaskId', 'frontend-job-create-failure-1')
      .field('prompt', 'replace product with references')
      .field('platform', '通用')
      .field('imageType', '通用营销图')
      .field('aspectRatio', '1:1')
      .field('subMode', 'dual-product-replace')
      .attach('images', tinyPng, { filename: 'reference-1.png', contentType: 'image/png' })
      .attach('images', tinyPng, { filename: 'reference-2.png', contentType: 'image/png' });

    expect(response.status).toBe(413);
    expect(response.body).toEqual(
      expect.objectContaining({
        errorCode: 'APIMART_IMG2_JOB_PAYLOAD_TOO_LARGE',
        message: '图片任务元数据过大，请压缩参考图或减少输入后重试。',
      }),
    );
    expect(response.body.message).not.toMatch(/offset|BSON|ERR_OUT_OF_RANGE/i);
    expect(mockUploadImageBuffer).toHaveBeenCalledTimes(2);
    expect(mockDeleteStorageFile).toHaveBeenCalledTimes(2);
    expect(mockDeleteFile).toHaveBeenCalledTimes(2);
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test('cleans newly staged multi-reference inputs when enqueue returns an existing job', async () => {
    const app = createApp();
    mockEnqueueAPIMartImg2Job.mockResolvedValueOnce({
      internalTaskId: 'internal-existing-multi-task-1',
      status: 'waiting',
      submittedToProvider: false,
      deduplicated: true,
    });

    const response = await request(app)
      .post('/api/image-generation/multi-reference')
      .field('modelKey', 'apimart_gpt_image_2')
      .field('frontendTaskId', 'frontend-existing-multi-1')
      .field('prompt', 'replace product with references')
      .field('platform', '通用')
      .field('imageType', '通用营销图')
      .field('aspectRatio', '1:1')
      .field('subMode', 'dual-product-replace')
      .attach('images', tinyPng, { filename: 'reference-1.png', contentType: 'image/png' })
      .attach('images', tinyPng, { filename: 'reference-2.png', contentType: 'image/png' });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(
      expect.objectContaining({
        internalTaskId: 'internal-existing-multi-task-1',
        deduplicated: true,
      }),
    );
    expect(mockUploadImageBuffer).toHaveBeenCalledTimes(2);
    expect(mockDeleteStorageFile).toHaveBeenCalledTimes(2);
    expect(mockDeleteFile).toHaveBeenCalledTimes(2);
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test('returns a safe pre-submit failure when staging APIMart multi-reference input fails', async () => {
    const app = createApp();
    mockUploadImageBuffer.mockRejectedValueOnce(new Error('storage unavailable'));

    const response = await request(app)
      .post('/api/image-generation/multi-reference')
      .field('modelKey', 'apimart_gpt_image_2')
      .field('frontendTaskId', 'frontend-storage-failure-1')
      .field('prompt', 'replace product with references')
      .field('platform', '通用')
      .field('imageType', '通用营销图')
      .field('aspectRatio', '1:1')
      .field('subMode', 'dual-product-replace')
      .attach('images', tinyPng, { filename: 'reference-1.png', contentType: 'image/png' })
      .attach('images', tinyPng, { filename: 'reference-2.png', contentType: 'image/png' });

    expect(response.status).toBe(502);
    expect(response.body).toEqual(
      expect.objectContaining({
        errorCode: 'APIMART_IMG2_INPUT_STORAGE_FAILED',
        message: '参考图暂存失败，请稍后重试。',
      }),
    );
    expect(response.body.message).not.toMatch(/offset|BSON|ERR_OUT_OF_RANGE/i);
    expect(mockEnqueueAPIMartImg2Job).not.toHaveBeenCalled();
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockRecordImageUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordImageUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'multi-reference',
        status: 'failed',
        imageCount: 0,
      }),
    );
  });
});
