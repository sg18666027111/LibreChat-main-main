const express = require('express');
const request = require('supertest');

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const mockFindOrEnqueue = jest.fn();
const mockGetEgressStatus = jest.fn();
const mockReadEgressOutput = jest.fn();
const mockShouldUseEgress = jest.fn();
const mockEnqueueV2 = jest.fn();
const mockGetV2Status = jest.fn();
const mockShouldUseV2 = jest.fn();
const mockGenerateFal = jest.fn();
const mockGenerateAPIMart = jest.fn();
const mockGenerateArk = jest.fn();
const mockGenerateSiliconText = jest.fn();
const mockRecordImageUsage = jest.fn();

function installRouteMocks() {
  jest.doMock('@librechat/data-schemas', () => ({
    logger: {
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
  }));
  jest.doMock('~/server/middleware', () => ({
    requireJwtAuth: (req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1' };
      next();
    },
    configMiddleware: (req, _res, next) => {
      req.config = { fileStrategy: 'local' };
      next();
    },
  }));
  jest.doMock('sharp', () =>
    jest.fn((buffer = tinyPng) => {
      const output = Buffer.isBuffer(buffer) ? buffer : tinyPng;
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
        toBuffer: jest.fn().mockResolvedValue(output),
      };
    }),
  );
  jest.doMock('~/server/services/ImageGeneration/prompt', () => ({
    NEGATIVE_PROMPT: '',
    DEFAULT_ASPECT_RATIOS: {},
    PLATFORM_TYPE_ASPECT_RATIOS: {},
    buildDualReferencePrompt: ({ prompt }) => prompt,
    buildMultiReferencePrompt: ({ prompt }) => prompt,
    buildPrompt: ({ prompt }) => prompt,
    buildWhiteBackgroundScenePrompt: ({ prompt }) => prompt,
    getImageSize: () => '1024x1024',
  }));
  jest.doMock('~/server/services/ImageGeneration/siliconflow', () => ({
    TEXT_TO_IMAGE_MODEL: 'siliconflow-text-model',
    IMAGE_TO_IMAGE_MODEL: 'siliconflow-edit-model',
    generateTextToImage: (...args) => mockGenerateSiliconText(...args),
    generateImageToImage: jest.fn(),
  }));
  jest.doMock('~/server/services/ImageGeneration/adapters/fal', () => ({
    generateFalImage: (...args) => mockGenerateFal(...args),
  }));
  jest.doMock('~/server/services/ImageGeneration/adapters/apimart', () => ({
    generateAPIMartImage: (...args) => mockGenerateAPIMart(...args),
  }));
  jest.doMock('~/server/services/ImageGeneration/adapters/ark', () => ({
    generateArkImage: (...args) => mockGenerateArk(...args),
  }));
  jest.doMock('~/server/services/ImageGeneration/apimartImg2Async', () => ({
    enqueueAPIMartImg2Job: (...args) => mockEnqueueV2(...args),
    getAPIMartImg2JobStatus: (...args) => mockGetV2Status(...args),
    isAPIMartImg2ResolvedModel: (model) =>
      model?.provider === 'apimart' && model?.model === 'gpt-image-2',
    shouldUseAPIMartImg2AsyncForUser: (...args) => mockShouldUseV2(...args),
  }));
  jest.doMock('~/server/services/ImageGeneration/apimartImg2InputStorage', () => ({
    cleanupAPIMartImg2InputRefs: jest.fn(),
    stageAPIMartImg2ImageInputs: jest.fn(),
  }));
  jest.doMock('~/server/services/ImageGeneration/imageEgressAsync', () => ({
    findOrStageAndEnqueueImageEgressJob: (...args) => mockFindOrEnqueue(...args),
    getImageEgressJobStatus: (...args) => mockGetEgressStatus(...args),
    isImageEgressAsyncResolvedModel: (model) =>
      (model?.provider === 'fal' &&
        [
          'openai/gpt-image-2',
          'openai/gpt-image-2/edit',
          'openai/gpt-image-2.5/flare/text-to-image',
          'openai/gpt-image-2.5/flare/edit',
          'xai/grok-imagine-image/edit',
          'fal-ai/nano-banana-pro',
        ].includes(model?.model)) ||
      (model?.provider === 'apimart' &&
        ['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image-preview'].includes(
          model?.model,
        )),
    readImageEgressJobOutput: (...args) => mockReadEgressOutput(...args),
    shouldUseImageEgressAsyncForUser: (...args) => mockShouldUseEgress(...args),
  }));
  jest.doMock('~/server/services/ImageGeneration/outputQuality', () => ({
    DEFAULT_OUTPUT_QUALITY: 'standard',
    OUTPUT_QUALITY_OPTIONS: [],
    resolveSingleImageOutputQuality: ({ fallbackSize }) => ({
      size: fallbackSize || '1024x1024',
      requestedOutputQuality: 'standard',
      effectiveOutputQuality: 'standard',
      downgraded: false,
    }),
  }));
  jest.doMock('~/server/services/ImageGeneration/resultRecorder', () => ({
    recordImageGenerationResult: jest.fn(async () => undefined),
  }));
  jest.doMock('~/server/services/ImageGeneration/normalizeImageOutput', () => ({
    normalizeGeneratedImageResult: jest.fn(({ result }) => result),
  }));
  jest.doMock('~/server/services/ImageGeneration/resultProxy', () => ({
    extractHostname: jest.fn(() => 'example.test'),
    getResultImage: jest.fn(() => null),
    isHostAllowed: jest.fn(() => true),
    registerResultImage: jest.fn(({ resultUrl }) => ({
      proxyPath: resultUrl,
      downloadPath: resultUrl,
    })),
    registerResultImageBuffer: jest.fn(),
  }));
  jest.doMock('~/server/services/ImageGeneration/promptTemplateStore', () => ({
    CATEGORY_BATCH_PACKAGING: 'batch_packaging',
    createPromptTemplate: jest.fn(),
    deletePromptTemplate: jest.fn(),
    duplicatePromptTemplate: jest.fn(),
    formatPromptTemplate: jest.fn(),
    listPromptTemplates: jest.fn(async () => []),
    restorePromptTemplateDefault: jest.fn(),
    updatePromptTemplate: jest.fn(),
  }));
  jest.doMock('~/server/services/UsageLedgerService', () => ({
    admitImageUsage: jest.fn(async () => null),
    releaseImageUsage: jest.fn(async () => {}),
    buildImageUsageEnvelope: jest.fn(() => null),
    recordImageUsage: (...args) => mockRecordImageUsage(...args),
  }));
}

let router;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/image-generation', router);
  return app;
}

describe('gated image-egress-v1 routes', () => {
  beforeAll(() => {
    jest.resetModules();
    installRouteMocks();
    router = require('./imageGeneration');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockShouldUseEgress.mockReturnValue('canary');
    mockShouldUseV2.mockReturnValue(true);
    mockFindOrEnqueue.mockResolvedValue({
      created: true,
      job: { internalTaskId: 'egress-task-1', status: 'waiting', submittedToProvider: false },
    });
    mockEnqueueV2.mockResolvedValue({
      internalTaskId: 'v2-task-1',
      status: 'waiting',
      submittedToProvider: false,
    });
    mockGenerateFal.mockResolvedValue({
      taskId: 'fal-sync-1',
      images: [{ url: 'https://example.test/fal.png' }],
    });
    mockGenerateAPIMart.mockResolvedValue({
      taskId: 'apimart-sync-1',
      images: [{ url: 'https://example.test/apimart.png' }],
    });
    mockGenerateArk.mockResolvedValue({
      taskId: 'ark-sync-1',
      images: [{ url: 'https://example.test/ark.png' }],
    });
    mockGenerateSiliconText.mockResolvedValue({
      images: [{ url: 'https://example.test/silicon.png' }],
    });
  });

  afterAll(() => {
    router = null;
    jest.resetModules();
  });

  it.each([1, 2])(
    'rejects retired Nano Banana count %s before provider submission',
    async (count) => {
      const response = await request(createApp()).post('/api/image-generation/text-to-image').send({
        modelKey: 'fal_nano_banana_pro',
        frontendTaskId: 'front-retired-nano',
        prompt: 'draw an image',
        platform: '通用',
        imageType: '通用营销图',
        aspectRatio: '1:1',
        count,
      });

      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe('IMAGE_MODEL_UNSUPPORTED');
      expect(mockGenerateFal).not.toHaveBeenCalled();
      expect(mockFindOrEnqueue).not.toHaveBeenCalled();
      expect(mockEnqueueV2).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['fal_gpt_image_2_edit', 'openai/gpt-image-2/edit'],
    ['fal_gpt_image_2_5_flare_edit', 'openai/gpt-image-2.5/flare/edit'],
  ])('queues single-reference %s after preprocessing', async (modelKey, model) => {
    const response = await request(createApp())
      .post('/api/image-generation/image-to-image')
      .field('modelKey', modelKey)
      .field('frontendTaskId', `front-${modelKey}`)
      .field('prompt', 'edit it')
      .field('platform', '通用')
      .field('imageType', '通用营销图')
      .field('aspectRatio', '1:1')
      .attach('image', tinyPng, { filename: 'input.png', contentType: 'image/png' });

    expect(response.status).toBe(202);
    expect(mockFindOrEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'single-image-edit',
        provider: 'fal',
        model,
        imageInputs: [expect.stringMatching(/^data:image\/png;base64,/)],
      }),
    );
    expect(mockGenerateFal).not.toHaveBeenCalled();
  });

  it.each(['fal_gpt_image_2_edit', 'fal_gpt_image_2_5_flare_edit'])(
    'queues Fal multi-reference %s without route-owned staging',
    async (modelKey) => {
      const response = await request(createApp())
        .post('/api/image-generation/multi-reference')
        .field('modelKey', modelKey)
        .field('frontendTaskId', 'front-multi-1')
        .field('subMode', 'multi-reference')
        .field('prompt', 'combine references')
        .field('platform', '通用')
        .field('imageType', '通用营销图')
        .field('aspectRatio', '1:1')
        .attach('images', tinyPng, { filename: 'one.png', contentType: 'image/png' })
        .attach('images', tinyPng, { filename: 'two.png', contentType: 'image/png' });

      expect(response.status).toBe(202);
      expect(mockFindOrEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: 'multi-reference',
          subMode: 'multi-reference',
          imageInputs: [expect.any(String), expect.any(String)],
        }),
      );
    },
  );

  it('keeps Fal image edit synchronous when off or canary-denied', async () => {
    mockShouldUseEgress.mockReturnValue(null);
    const response = await request(createApp())
      .post('/api/image-generation/image-to-image')
      .field('modelKey', 'fal_gpt_image_2_edit')
      .field('prompt', 'edit image')
      .field('platform', '通用')
      .field('imageType', '通用营销图')
      .field('aspectRatio', '1:1')
      .attach('image', tinyPng, { filename: 'input.png', contentType: 'image/png' });
    expect(response.status).toBe(200);
    expect(mockGenerateFal).toHaveBeenCalledTimes(1);
    expect(mockFindOrEnqueue).not.toHaveBeenCalled();
  });

  it('routes only GPT Image 2 text-to-image to Fal image-egress v3', async () => {
    const response = await request(createApp()).post('/api/image-generation/text-to-image').send({
      modelKey: 'apimart_gpt_image_2_text',
      frontendTaskId: 'front-fal-img2-1',
      prompt: 'draw an image',
      platform: '通用',
      imageType: '通用营销图',
      aspectRatio: '1:1',
      count: 1,
    });
    expect(response.status).toBe(202);
    expect(response.body).toEqual(
      expect.objectContaining({
        internalTaskId: 'egress-task-1',
        modelKey: 'apimart_gpt_image_2_text',
        provider: 'fal',
        model: 'openai/gpt-image-2',
      }),
    );
    expect(mockFindOrEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        frontendTaskId: 'front-fal-img2-1',
        provider: 'fal',
        model: 'openai/gpt-image-2',
        modelKey: 'apimart_gpt_image_2_text',
        taskType: 'text-to-image',
        rolloutMode: 'canary',
        payload: expect.objectContaining({ count: 1 }),
        imageInputs: [],
      }),
    );
    expect(mockEnqueueV2).not.toHaveBeenCalled();
    expect(mockGenerateFal).not.toHaveBeenCalled();
  });

  it('routes Flare text to its explicit fal endpoint', async () => {
    const response = await request(createApp()).post('/api/image-generation/text-to-image').send({
      modelKey: 'fal_gpt_image_2_5_flare_text',
      frontendTaskId: 'front-fal-img2-1',
      prompt: 'draw an image',
      platform: '通用',
      imageType: '通用营销图',
      aspectRatio: '1:1',
      count: 1,
    });
    expect(response.status).toBe(202);
    expect(response.body).toEqual(
      expect.objectContaining({
        internalTaskId: 'egress-task-1',
        modelKey: 'fal_gpt_image_2_5_flare_text',
        provider: 'fal',
        model: 'openai/gpt-image-2.5/flare/text-to-image',
      }),
    );
    expect(mockFindOrEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        frontendTaskId: 'front-fal-img2-1',
        provider: 'fal',
        model: 'openai/gpt-image-2.5/flare/text-to-image',
        modelKey: 'fal_gpt_image_2_5_flare_text',
        taskType: 'text-to-image',
        rolloutMode: 'canary',
        payload: expect.objectContaining({ count: 1 }),
        imageInputs: [],
      }),
    );
    expect(mockEnqueueV2).not.toHaveBeenCalled();
    expect(mockGenerateFal).not.toHaveBeenCalled();
  });

  it.each([2, 4])('rejects GPT Image 2 text count %s before enqueue', async (count) => {
    const response = await request(createApp()).post('/api/image-generation/text-to-image').send({
      modelKey: 'apimart_gpt_image_2_text',
      prompt: 'draw multiple images',
      platform: '通用',
      imageType: '通用营销图',
      aspectRatio: '1:1',
      count,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({ errorCode: 'IMAGE_MODEL_COUNT_UNSUPPORTED' }),
    );
    expect(mockFindOrEnqueue).not.toHaveBeenCalled();
    expect(mockEnqueueV2).not.toHaveBeenCalled();
    expect(mockGenerateFal).not.toHaveBeenCalled();
    expect(mockRecordImageUsage).not.toHaveBeenCalled();
  });

  it('fails closed instead of returning a synchronous Fal temporary URL when v3 is disabled', async () => {
    mockShouldUseEgress.mockReturnValue(null);

    const response = await request(createApp()).post('/api/image-generation/text-to-image').send({
      modelKey: 'apimart_gpt_image_2_text',
      prompt: 'durable output only',
      platform: '通用',
      imageType: '通用营销图',
      aspectRatio: '1:1',
      count: 1,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({ errorCode: 'IMAGE_EGRESS_ASYNC_DISABLED' }),
    );
    expect(mockFindOrEnqueue).not.toHaveBeenCalled();
    expect(mockGenerateFal).not.toHaveBeenCalled();
    expect(mockEnqueueV2).not.toHaveBeenCalled();
  });

  it('exposes the scoped Fal model and its single-output capability in text config', async () => {
    const response = await request(createApp()).get('/api/image-generation/config');

    expect(response.status).toBe(200);
    expect(response.body.counts).toEqual([1, 2, 4]);
    expect(response.body.models[0]).toMatchObject({ provider: 'fal' });
    expect(response.body.editModels[0]).toMatchObject({
      provider: 'fal',
      modelKey: 'fal_gpt_image_2_edit',
    });
    expect(
      response.body.models.find((entry) => entry.modelKey === 'apimart_gpt_image_2_text'),
    ).toEqual(
      expect.objectContaining({
        provider: 'fal',
        model: 'openai/gpt-image-2',
        supportedCounts: [1],
        asyncOnly: true,
      }),
    );
  });

  it.each([
    { modelKey: 'apimart_gemini_3_1_flash' },
    { modelKey: 'apimart_gemini_2_5_flash' },
    { modelKey: 'fal_grok_imagine_image_edit' },
    { model: 'gemini-3.1-flash-image-preview' },
    { model: 'gemini-2.5-flash-image-preview' },
    { model: 'xai/grok-imagine-image/edit' },
  ])(
    'rejects retired image selection %j even when async rollout admits the user',
    async (selection) => {
      const response = await request(createApp())
        .post('/api/image-generation/image-to-image')
        .field(selection)
        .field('frontendTaskId', 'front-retired-edit')
        .field('prompt', 'edit image')
        .field('platform', '通用')
        .field('imageType', '通用营销图')
        .field('aspectRatio', '1:1')
        .attach('image', tinyPng, { filename: 'input.png', contentType: 'image/png' });

      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe('IMAGE_MODEL_UNSUPPORTED');
      expect(mockFindOrEnqueue).not.toHaveBeenCalled();
      expect(mockEnqueueV2).not.toHaveBeenCalled();
      expect(mockGenerateFal).not.toHaveBeenCalled();
      expect(mockGenerateAPIMart).not.toHaveBeenCalled();
    },
  );

  it.each([null, 'canary', 'all'])(
    'does not offer retired models with rollout %s',
    async (rollout) => {
      mockShouldUseEgress.mockReturnValue(rollout);
      const response = await request(createApp()).get('/api/image-generation/config');
      expect(response.status).toBe(200);
      expect(
        [...response.body.models, ...response.body.editModels].map((entry) => entry.modelKey),
      ).not.toEqual(expect.arrayContaining(['fal_nano_banana_pro']));
      for (const key of [
        'apimart_gemini_3_1_flash',
        'apimart_gemini_2_5_flash',
        'fal_grok_imagine_image_edit',
      ]) {
        expect(response.body.editModels.map((entry) => entry.modelKey)).not.toContain(key);
      }
    },
  );

  it('keeps Ark and SiliconFlow outside v3', async () => {
    const ark = await request(createApp()).post('/api/image-generation/text-to-image').send({
      modelKey: 'ark_seedream_5_0_t2i',
      prompt: 'ark image',
      platform: '通用',
      imageType: '通用营销图',
      aspectRatio: '1:1',
      count: 1,
    });
    const silicon = await request(createApp()).post('/api/image-generation/text-to-image').send({
      model: 'siliconflow-text-model',
      prompt: 'silicon image',
      platform: '通用',
      imageType: '通用营销图',
      aspectRatio: '1:1',
      count: 1,
    });
    expect(ark.status).toBe(200);
    expect(silicon.status).toBe(200);
    expect(mockGenerateArk).toHaveBeenCalledTimes(1);
    expect(mockGenerateSiliconText).toHaveBeenCalledTimes(1);
    expect(mockFindOrEnqueue).not.toHaveBeenCalled();
  });

  it('serves owned v3 status before falling back to v2', async () => {
    mockGetEgressStatus.mockResolvedValueOnce({
      internalTaskId: 'egress-task-1',
      state: 'success',
      status: 'succeeded',
      images: [{ url: '/api/image-generation/tasks/egress-task-1/result-image' }],
    });
    const response = await request(createApp()).get('/api/image-generation/tasks/egress-task-1');
    expect(response.status).toBe(200);
    expect(response.body.images[0].url).toBe(
      '/api/image-generation/tasks/egress-task-1/result-image',
    );
    expect(mockGetV2Status).not.toHaveBeenCalled();

    mockGetEgressStatus.mockResolvedValueOnce(null);
    mockGetV2Status.mockResolvedValueOnce({ internalTaskId: 'v2-task-1', state: 'running' });
    const fallback = await request(createApp()).get('/api/image-generation/tasks/v2-task-1');
    expect(fallback.status).toBe(200);
    expect(mockGetV2Status).toHaveBeenCalledWith({
      internalTaskId: 'v2-task-1',
      userId: 'user-1',
    });
  });

  it('serves a durable output only to the authenticated job owner', async () => {
    mockReadEgressOutput.mockResolvedValue({ buffer: tinyPng, contentType: 'image/png' });
    const response = await request(createApp()).get(
      '/api/image-generation/tasks/egress-task-1/result-image',
    );
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^image\/png/);
    expect(response.body).toEqual(tinyPng);
    expect(mockReadEgressOutput).toHaveBeenCalledWith({
      internalTaskId: 'egress-task-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
  });

  it('maps missing or expired durable output to an explicit terminal result error', async () => {
    mockReadEgressOutput.mockResolvedValue(null);
    const response = await request(createApp()).get(
      '/api/image-generation/tasks/egress-task-1/result-image',
    );
    expect(response.status).toBe(404);
    expect(response.body.errorCode).toBe('RESULT_FILE_MISSING');
    expect(mockGenerateFal).not.toHaveBeenCalled();
  });
});
