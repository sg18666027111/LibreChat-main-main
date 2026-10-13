const express = require('express');
const request = require('supertest');

const mockCreateSkuBatch = jest.fn();
const mockGetSkuBatch = jest.fn();
const mockCancelSkuBatch = jest.fn();
const mockRetrySkuBatchItem = jest.fn();
const mockSaveSkuSourceFile = jest.fn();
const mockGetAuthorizedSkuFile = jest.fn();
const mockReadAuthorizedSkuFile = jest.fn();
const mockReadSkuTemplateAsset = jest.fn();

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    if (req.headers['x-test-user']) {
      req.user = { id: req.headers['x-test-user'], tenantId: req.headers['x-test-tenant'] || null };
      return next();
    }
    return res.status(401).json({ message: 'Unauthorized' });
  },
}));
jest.mock('~/server/middleware/config/app', () => (req, res, next) => {
  req.config = { paths: {} };
  next();
});
jest.mock('~/server/services/SkuGeneration/skuBatchService', () => ({
  createSkuBatch: mockCreateSkuBatch,
  getSkuBatch: mockGetSkuBatch,
  cancelSkuBatch: mockCancelSkuBatch,
  retrySkuBatchItem: mockRetrySkuBatchItem,
}));
jest.mock('~/server/services/SkuGeneration/skuFileStorage', () => ({
  saveSkuSourceFile: mockSaveSkuSourceFile,
  getAuthorizedSkuFile: mockGetAuthorizedSkuFile,
  readAuthorizedSkuFile: mockReadAuthorizedSkuFile,
}));
jest.mock('~/server/services/SkuGeneration/skuTemplateAssets', () => ({
  readSkuTemplateAsset: mockReadSkuTemplateAsset,
}));

const router = require('../skuGeneration');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sku-generation', router);
  return app;
}

describe('SKU generation routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveSkuSourceFile.mockResolvedValue({
      fileId: 'file-1',
      filename: 'source.png',
      contentType: 'image/png',
      bytes: 12,
      width: 800,
      height: 800,
    });
    mockGetSkuBatch.mockResolvedValue({ batchId: 'batch-1', status: 'pending', items: [] });
    mockGetAuthorizedSkuFile.mockResolvedValue({
      file_id: 'file-1',
      filename: 'sku.png',
      type: 'image/png',
    });
    mockReadAuthorizedSkuFile.mockResolvedValue({
      buffer: Buffer.from('png'),
      contentType: 'image/png',
    });
    mockReadSkuTemplateAsset.mockResolvedValue({
      buffer: Buffer.from('png'),
      contentType: 'image/png',
      filename: 'sku-red-delivery-left.png',
    });
  });

  test('requires authentication for all SKU endpoints', async () => {
    const response = await request(createApp()).get('/api/sku-generation/batches/batch-1');
    expect(response.status).toBe(401);
  });

  test('rejects unsupported source uploads and accepts an image upload', async () => {
    await request(createApp())
      .post('/api/sku-generation/sources')
      .set('x-test-user', 'user-1')
      .attach('file', Buffer.from('text'), { filename: 'source.txt', contentType: 'text/plain' })
      .expect(400);

    const response = await request(createApp())
      .post('/api/sku-generation/sources')
      .set('x-test-user', 'user-1')
      .field('kind', 'source')
      .attach('file', Buffer.from('png'), { filename: 'source.png', contentType: 'image/png' })
      .expect(200);

    expect(response.body.fileId).toBe('file-1');
    expect(mockSaveSkuSourceFile).toHaveBeenCalledWith(expect.objectContaining({ kind: 'source' }));
  });

  test('creates a batch and hides another user batch as not found', async () => {
    mockCreateSkuBatch.mockResolvedValue({ batchId: 'batch-1', status: 'pending', items: [] });
    await request(createApp())
      .post('/api/sku-generation/batches')
      .set('x-test-user', 'user-1')
      .send({
        sourceFileId: 'source-1',
        templateKey: 'sku_red_delivery_label_v1',
        textRows: ['商品'],
      })
      .expect(200);
    expect(mockCreateSkuBatch).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));

    mockGetSkuBatch.mockResolvedValueOnce(null);
    await request(createApp())
      .get('/api/sku-generation/batches/batch-1')
      .set('x-test-user', 'other-user')
      .expect(404);
  });

  test('serves authenticated built-in template assets', async () => {
    const response = await request(createApp())
      .get('/api/sku-generation/templates/sku_red_delivery_label_v1/assets/leftIcon')
      .set('x-test-user', 'user-1')
      .expect(200);

    expect(response.headers['content-type']).toMatch(/image\/png/);
    expect(response.headers['content-disposition']).toMatch(/^inline/);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(mockReadSkuTemplateAsset).toHaveBeenCalledWith({
      templateKey: 'sku_red_delivery_label_v1',
      slot: 'leftIcon',
    });
  });

  test('requires authentication for built-in template assets', async () => {
    const response = await request(createApp())
      .get('/api/sku-generation/templates/sku_red_delivery_label_v1/assets/leftIcon')
      .expect(401);
    expect(response.status).toBe(401);
  });

  test('returns a business error for an unknown built-in template asset', async () => {
    mockReadSkuTemplateAsset.mockRejectedValueOnce(
      Object.assign(new Error('不支持的 SKU 模板素材：unknown'), {
        code: 'SKU_TEMPLATE_ASSET_UNKNOWN',
        statusCode: 400,
      }),
    );
    const response = await request(createApp())
      .get('/api/sku-generation/templates/sku_red_delivery_label_v1/assets/unknown')
      .set('x-test-user', 'user-1');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'SKU_TEMPLATE_ASSET_UNKNOWN' });
  });

  test('returns inline files by default and attachment files for download requests', async () => {
    const app = createApp();
    const inlineResponse = await request(app)
      .get('/api/sku-generation/files/file-1')
      .set('x-test-user', 'user-1');
    expect(inlineResponse.status).toBe(200);
    expect(inlineResponse.headers['content-type']).toMatch(/image\/png/);
    expect(inlineResponse.headers['content-disposition']).toMatch(/^inline/);

    const downloadResponse = await request(app)
      .get('/api/sku-generation/files/file-1?download=1')
      .set('x-test-user', 'user-1');
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers['content-disposition']).toMatch(/^attachment/);
  });
});
