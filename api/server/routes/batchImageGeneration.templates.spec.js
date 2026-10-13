const express = require('express');
const request = require('supertest');

const mockCreateBatchTask = jest.fn();

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'operator-1', tenantId: 'tenant-1' };
    next();
  },
}));

jest.mock('~/server/middleware/config/app', () => (_req, _res, next) => next());

jest.mock('~/server/services/ImageGeneration/batchPackaging', () => ({
  cancelBatchTask: jest.fn(),
  createBatchTask: (...args) => mockCreateBatchTask(...args),
  getBatchTask: jest.fn(),
  recoverBatchItemResult: jest.fn(),
  retryBatchItem: jest.fn(),
  serializeBatchTask: (task) => task,
}));

jest.mock('~/server/services/ImageGeneration/batchResultStorage', () => ({
  getAuthorizedBatchResultFile: jest.fn(),
  getBatchResultBuffer: jest.fn(),
}));

const batchImageGenerationRouter = require('./batchImageGeneration');

function createApp() {
  const app = express();
  app.use('/api/batch/image-generation', batchImageGenerationRouter);
  return app;
}

describe('batch image generation template selection parsing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateBatchTask.mockResolvedValue({ id: 'batch-1', items: [] });
  });

  test('preserves a missing templateIds field for legacy default resolution', async () => {
    const response = await request(createApp())
      .post('/api/batch/image-generation')
      .field('title', 'Missing selection')
      .field('mode', 't2i');

    expect(response.status).toBe(200);
    expect(mockCreateBatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ templateIds: undefined }),
    );
  });

  test('preserves an explicit empty array so the service can reject it', async () => {
    const response = await request(createApp())
      .post('/api/batch/image-generation')
      .field('title', 'Empty selection')
      .field('mode', 't2i')
      .field('templateIds', '[]');

    expect(response.status).toBe(200);
    expect(mockCreateBatchTask).toHaveBeenCalledWith(expect.objectContaining({ templateIds: [] }));
  });
});
