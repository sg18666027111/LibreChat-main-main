const express = require('express');
const request = require('supertest');
const { SystemRoles } = require('librechat-data-provider');

let mockAuthenticatedUser;
const mockCreatePromptTemplate = jest.fn();
const mockListPromptTemplates = jest.fn();
const mockSaveExample = jest.fn();
const mockRemoveExample = jest.fn();
const mockReadExample = jest.fn();
jest.mock('~/server/services/ImageGeneration/promptTemplateExample', () => ({
  saveExampleImage: (...args) => mockSaveExample(...args),
  removeExampleImage: (...args) => mockRemoveExample(...args),
  readExampleImage: (...args) => mockReadExample(...args),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = mockAuthenticatedUser;
    next();
  },
  configMiddleware: (req, _res, next) => {
    req.config = { fileStrategy: 'local' };
    next();
  },
}));

jest.mock('~/server/services/ImageGeneration/promptTemplateStore', () => ({
  CATEGORY_BATCH_PACKAGING: 'batch_packaging',
  MAX_PACKAGING_STYLES_PER_BATCH: 8,
  TEMPLATE_ROLES: ['global_business', 'packaging_style'],
  createPromptTemplate: (...args) => mockCreatePromptTemplate(...args),
  deletePromptTemplate: jest.fn(),
  duplicatePromptTemplate: jest.fn(),
  formatPromptTemplate: jest.fn(),
  listPromptTemplates: (...args) => mockListPromptTemplates(...args),
  restorePromptTemplateDefault: jest.fn(),
  updatePromptTemplate: jest.fn(),
}));

jest.mock('~/server/services/ImageGeneration/siliconflow', () => ({
  TEXT_TO_IMAGE_MODEL: 'siliconflow-text-model',
  IMAGE_TO_IMAGE_MODEL: 'siliconflow-edit-model',
  generateTextToImage: jest.fn(),
  generateImageToImage: jest.fn(),
}));

jest.mock('~/server/services/ImageGeneration/adapters/apimart', () => ({
  generateAPIMartImage: jest.fn(),
}));

jest.mock('~/server/services/ImageGeneration/adapters/fal', () => ({
  generateFalImage: jest.fn(),
}));

jest.mock('~/server/services/ImageGeneration/adapters/ark', () => ({
  generateArkImage: jest.fn(),
}));

jest.mock('~/server/services/ImageGeneration/apimartImg2Async', () => ({
  enqueueAPIMartImg2Job: jest.fn(),
  getAPIMartImg2JobStatus: jest.fn(),
  isAPIMartImg2ResolvedModel: jest.fn(() => false),
  shouldUseAPIMartImg2AsyncForUser: jest.fn(() => false),
}));

jest.mock('~/server/services/ImageGeneration/resultRecorder', () => ({
  recordImageGenerationResult: jest.fn(),
}));

jest.mock('~/server/services/ImageGeneration/resultProxy', () => ({
  extractHostname: jest.fn(() => null),
  getResultImage: jest.fn(() => null),
  isHostAllowed: jest.fn(() => false),
  registerResultImage: jest.fn(),
  registerResultImageBuffer: jest.fn(),
}));

jest.mock('~/server/services/UsageLedgerService', () => ({
  admitImageUsage: jest.fn(async () => null),
  releaseImageUsage: jest.fn(async () => {}),
  buildImageUsageEnvelope: jest.fn(() => null),
  recordImageUsage: jest.fn(),
}));

const imageGenerationRouter = require('./imageGeneration');

const validPayload = {
  name: '运营新增测试模板',
  description: '',
  platform: '通用',
  imageType: '商品主图',
  prompt: '运营新增模板测试提示词',
  formattedPrompt: '',
  activePromptSource: 'original',
  templateRole: 'packaging_style',
  formatWarnings: [],
  isEnabled: true,
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/image-generation', imageGenerationRouter);
  return app;
}

describe('image generation prompt template create permission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListPromptTemplates.mockResolvedValue([]);
    mockCreatePromptTemplate.mockImplementation(async (payload, userId) => ({
      id: 'created-template',
      key: 'custom_batch_packaging_created',
      category: 'batch_packaging',
      isSystem: false,
      ...payload,
      createdBy: userId,
    }));
  });

  test('forwards a valid template role filter to the store', async () => {
    mockAuthenticatedUser = { id: 'user-1', role: SystemRoles.USER };

    const response = await request(createApp()).get(
      '/api/image-generation/prompt-templates?category=batch_packaging&templateRole=packaging_style',
    );

    expect(response.status).toBe(200);
    expect(mockListPromptTemplates).toHaveBeenCalledWith({
      category: 'batch_packaging',
      includeDisabled: false,
      templateRole: 'packaging_style',
    });
  });

  test('returns the authoritative batch packaging selection limit', async () => {
    mockAuthenticatedUser = { id: 'user-1', role: SystemRoles.USER };

    const response = await request(createApp()).get(
      '/api/image-generation/prompt-templates?category=batch_packaging&templateRole=packaging_style',
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      templates: [],
      limits: { maxPackagingStylesPerBatch: 8 },
    });
  });

  test('rejects an unknown template role filter', async () => {
    mockAuthenticatedUser = { id: 'user-1', role: SystemRoles.USER };

    const response = await request(createApp()).get(
      '/api/image-generation/prompt-templates?category=batch_packaging&templateRole=ambiguous',
    );

    expect(response.status).toBe(400);
    expect(mockListPromptTemplates).not.toHaveBeenCalled();
  });

  test.each([
    ['admin', { id: 'admin-1', role: SystemRoles.ADMIN }, 201, 1],
    [
      'authorized operator',
      {
        id: 'operator-1',
        role: SystemRoles.USER,
        permissions: { imagePromptTemplates: { manage: true } },
      },
      201,
      1,
    ],
    [
      'unauthorized user',
      {
        id: 'user-1',
        role: SystemRoles.USER,
        permissions: { imagePromptTemplates: { manage: false } },
      },
      403,
      0,
    ],
    ['user with missing permissions', { id: 'user-2', role: SystemRoles.USER }, 403, 0],
  ])('%s receives the required create result', async (_name, user, status, createCalls) => {
    mockAuthenticatedUser = user;

    const response = await request(createApp())
      .post('/api/image-generation/prompt-templates')
      .send(validPayload);

    expect(response.status).toBe(status);
    expect(mockCreatePromptTemplate).toHaveBeenCalledTimes(createCalls);
    if (createCalls === 1) {
      expect(response.body.template).toMatchObject({
        name: validPayload.name,
        prompt: validPayload.prompt,
        createdBy: user.id,
      });
      expect(mockCreatePromptTemplate).toHaveBeenCalledWith(validPayload, user.id);
    }
  });
});

describe('prompt template example permission boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveExample.mockResolvedValue({ id: 'template', exampleImageUrl: '/example' });
    mockRemoveExample.mockResolvedValue({ id: 'template', exampleImageUrl: '' });
  });
  test.each([
    ['admin', { id: 'admin', role: SystemRoles.ADMIN }, 200],
    [
      'editor',
      {
        id: 'editor',
        role: SystemRoles.USER,
        permissions: { imagePromptTemplates: { manage: true } },
      },
      200,
    ],
    ['operator', { id: 'operator', role: SystemRoles.USER }, 403],
    [
      'revoked editor',
      {
        id: 'operator',
        role: SystemRoles.USER,
        permissions: { imagePromptTemplates: { manage: false } },
      },
      403,
    ],
  ])(
    '%s can maintain examples only with template edit permission',
    async (_label, user, status) => {
      mockAuthenticatedUser = user;
      const upload = await request(createApp())
        .post('/api/image-generation/prompt-templates/template/example-image')
        .attach('image', Buffer.from('image'), {
          filename: 'example.png',
          contentType: 'image/png',
        });
      const removal = await request(createApp()).delete(
        '/api/image-generation/prompt-templates/template/example-image',
      );
      expect(upload.status).toBe(status);
      expect(removal.status).toBe(status);
      expect(mockSaveExample).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      expect(mockRemoveExample).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    },
  );
  test('ordinary operator reads a shared example without edit permission', async () => {
    mockAuthenticatedUser = { id: 'different-operator', role: SystemRoles.USER };
    mockReadExample.mockResolvedValue({
      stream: require('stream').Readable.from(Buffer.from('image bytes')),
      contentType: 'image/png',
    });
    const response = await request(createApp()).get(
      '/api/image-generation/prompt-templates/template/example-image',
    );
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/image\/png/);
    expect(response.body.toString()).toBe('image bytes');
  });
  test.each(['missing', 'wrong-type', 'multiple', 'oversize'])(
    'rejects %s uploads before storage',
    async (kind) => {
      mockAuthenticatedUser = { id: 'admin', role: SystemRoles.ADMIN };
      let upload = request(createApp()).post(
        '/api/image-generation/prompt-templates/template/example-image',
      );
      if (kind !== 'missing') {
        upload = upload.attach(
          'image',
          Buffer.alloc(kind === 'oversize' ? 8 * 1024 * 1024 + 1 : 4),
          {
            filename: kind === 'wrong-type' ? 'bad.svg' : 'example.png',
            contentType: kind === 'wrong-type' ? 'image/svg+xml' : 'image/png',
          },
        );
      }
      if (kind === 'multiple') upload = upload.attach('image', Buffer.from('other'), 'other.png');
      const response = await upload;
      expect([400, 413]).toContain(response.status);
      expect(mockSaveExample).not.toHaveBeenCalled();
    },
  );
});
