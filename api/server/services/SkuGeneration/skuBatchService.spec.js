const mockDb = {
  findFileById: jest.fn(),
  createSkuBatchTaskItem: jest.fn(),
  getSkuBatchTaskItems: jest.fn(),
  getSkuBatchTaskItem: jest.fn(),
  updateSkuBatchTaskItem: jest.fn(),
  acquireSkuBatchTaskLease: jest.fn(),
  updateSkuBatchTaskItemWithLease: jest.fn(),
};
const mockComposeSkuImage = jest.fn();
const mockSaveSkuOutputFile = jest.fn();
const mockGetAuthorizedSkuFile = jest.fn();
const mockReadAuthorizedSkuFile = jest.fn();
const mockReadSkuTemplateAsset = jest.fn();

jest.mock('~/models', () => mockDb);
jest.mock('~/server/services/SkuGeneration/composeSkuImage', () => ({
  composeSkuImage: mockComposeSkuImage,
}));
jest.mock('~/server/services/SkuGeneration/skuFileStorage', () => ({
  saveSkuOutputFile: mockSaveSkuOutputFile,
  getAuthorizedSkuFile: mockGetAuthorizedSkuFile,
  getStorageRequest: jest.fn(({ config, userId, tenantId }) => ({
    config,
    user: { id: userId, tenantId },
  })),
  readAuthorizedSkuFile: mockReadAuthorizedSkuFile,
}));
jest.mock('~/server/services/SkuGeneration/skuTemplateAssets', () => ({
  readSkuTemplateAsset: mockReadSkuTemplateAsset,
}));

const {
  cancelSkuBatch,
  createSkuBatch,
  getSkuBatch,
  processSkuBatchItem,
  retrySkuBatchItem,
} = require('./skuBatchService');

function fileRecord(fileId) {
  return { file_id: fileId, source: 'local', filepath: `/tmp/${fileId}`, type: 'image/png' };
}

function taskItem(overrides = {}) {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    batchId: 'batch-1',
    itemId: 'item-1',
    itemIndex: 0,
    sourceFileId: 'source-1',
    leftIconFileId: 'left-1',
    rightIconFileId: 'right-1',
    templateKey: 'sku_red_delivery_label_v1',
    text: '商品卖点',
    status: 'pending',
    retryCount: 0,
    ...overrides,
  };
}

describe('SKU batch service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.findFileById.mockImplementation(async (fileId) => fileRecord(fileId));
    mockDb.createSkuBatchTaskItem.mockImplementation(async (input) => input);
    mockDb.getSkuBatchTaskItems.mockResolvedValue([]);
    mockDb.getSkuBatchTaskItem.mockResolvedValue(null);
    mockDb.updateSkuBatchTaskItem.mockResolvedValue(taskItem({ status: 'cancelled' }));
    mockDb.acquireSkuBatchTaskLease.mockResolvedValue(null);
    mockDb.updateSkuBatchTaskItemWithLease.mockResolvedValue(taskItem({ status: 'succeeded' }));
    mockGetAuthorizedSkuFile.mockImplementation(async ({ fileId }) => fileRecord(fileId));
    mockReadAuthorizedSkuFile.mockResolvedValue({
      buffer: Buffer.from('image'),
      contentType: 'image/png',
    });
    mockComposeSkuImage.mockResolvedValue({
      buffer: Buffer.from('sku-png'),
      mimeType: 'image/png',
      width: 800,
      height: 800,
      templateKey: 'sku_red_delivery_label_v1',
    });
    mockSaveSkuOutputFile.mockResolvedValue({ fileId: 'output-1' });
  });

  test('creates a template-one batch without operator icon file ids', async () => {
    const result = await createSkuBatch({
      userId: 'user-1',
      tenantId: 'tenant-1',
      storageConfig: { paths: {} },
      sourceFileId: 'source-1',
      templateKey: 'sku_red_delivery_label_v1',
      textRows: ['第一条'],
      startWorker: false,
    });

    expect(mockGetAuthorizedSkuFile).toHaveBeenCalledTimes(1);
    expect(mockDb.createSkuBatchTaskItem).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFileId: 'source-1',
        leftIconFileId: undefined,
        rightIconFileId: undefined,
        templateKey: 'sku_red_delivery_label_v1',
      }),
    );
    expect(result.templateKey).toBe('sku_red_delivery_label_v1');
  });

  test('creates one item per non-empty text row and excludes blank rows', async () => {
    const result = await createSkuBatch({
      userId: 'user-1',
      tenantId: 'tenant-1',
      storageConfig: { paths: {} },
      sourceFileId: 'source-1',
      leftIconFileId: 'left-1',
      rightIconFileId: 'right-1',
      templateKey: 'sku_red_delivery_label_v1',
      textRows: ['第一条', '  ', '', '第二条'],
      startWorker: false,
    });

    expect(mockDb.createSkuBatchTaskItem).toHaveBeenCalledTimes(2);
    expect(mockDb.createSkuBatchTaskItem.mock.calls.map(([item]) => item.text)).toEqual([
      '第一条',
      '第二条',
    ]);
    expect(result.outputCount).toBe(2);
    expect(result.status).toBe('pending');
  });

  test('rejects a source or icon that the current user cannot access', async () => {
    mockGetAuthorizedSkuFile.mockImplementation(async ({ fileId }) =>
      fileId === 'left-1' ? null : fileRecord(fileId),
    );

    await expect(
      createSkuBatch({
        userId: 'user-1',
        tenantId: 'tenant-1',
        sourceFileId: 'source-1',
        leftIconFileId: 'left-1',
        rightIconFileId: 'right-1',
        templateKey: 'sku_red_delivery_label_v1',
        textRows: ['商品'],
        startWorker: false,
      }),
    ).rejects.toMatchObject({ code: 'SKU_FILE_NOT_FOUND', field: 'leftIconFileId' });
  });

  test('composes and persists one successful output while releasing its lease', async () => {
    const item = taskItem({ status: 'running' });
    mockDb.acquireSkuBatchTaskLease.mockResolvedValueOnce(item);

    await processSkuBatchItem({
      item,
      userId: 'user-1',
      tenantId: 'tenant-1',
      storageConfig: { paths: {} },
      workerId: 'worker-1',
    });

    expect(mockComposeSkuImage).toHaveBeenCalledWith({
      sourceBuffer: Buffer.from('image'),
      leftIconBuffer: Buffer.from('image'),
      rightIconBuffer: Buffer.from('image'),
      text: '商品卖点',
      templateKey: 'sku_red_delivery_label_v1',
    });
    expect(mockSaveSkuOutputFile).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: 'batch-1',
        itemId: 'item-1',
        output: expect.objectContaining({ mimeType: 'image/png' }),
      }),
    );
    expect(mockDb.updateSkuBatchTaskItemWithLease).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: 'batch-1',
        itemId: 'item-1',
        workerId: 'worker-1',
        updates: expect.objectContaining({ status: 'succeeded', outputFileId: 'output-1' }),
      }),
    );
  });

  test('resolves built-in template assets when no icon overrides exist', async () => {
    const item = taskItem({
      status: 'running',
      leftIconFileId: undefined,
      rightIconFileId: undefined,
    });
    mockDb.acquireSkuBatchTaskLease.mockResolvedValueOnce(item);
    mockReadSkuTemplateAsset.mockResolvedValue({
      buffer: Buffer.from('template-image'),
      contentType: 'image/png',
    });

    await processSkuBatchItem({
      item,
      userId: 'user-1',
      tenantId: 'tenant-1',
      storageConfig: { paths: {} },
      workerId: 'worker-1',
    });

    expect(mockReadSkuTemplateAsset).toHaveBeenCalledWith({
      templateKey: 'sku_red_delivery_label_v1',
      slot: 'leftIcon',
    });
    expect(mockReadSkuTemplateAsset).toHaveBeenCalledWith({
      templateKey: 'sku_red_delivery_label_v1',
      slot: 'rightIcon',
    });
    expect(mockGetAuthorizedSkuFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'source-1' }),
    );
    expect(mockComposeSkuImage).toHaveBeenCalledWith(
      expect.objectContaining({
        leftIconBuffer: Buffer.from('template-image'),
        rightIconBuffer: Buffer.from('template-image'),
        templateKey: 'sku_red_delivery_label_v1',
      }),
    );
  });

  test('serializes a mixed result as partial_failed and keeps successful output URLs', async () => {
    mockDb.getSkuBatchTaskItems.mockResolvedValue([
      taskItem({ itemId: 'item-1', itemIndex: 0, status: 'succeeded', outputFileId: 'output-1' }),
      taskItem({ itemId: 'item-2', itemIndex: 1, status: 'failed', error: '合成失败' }),
    ]);

    const result = await getSkuBatch('batch-1', { userId: 'user-1', tenantId: 'tenant-1' });

    expect(result).toMatchObject({
      batchId: 'batch-1',
      status: 'partial_failed',
      outputCount: 2,
      completedCount: 1,
      failedCount: 1,
    });
    expect(result.items[0]).toMatchObject({
      outputFileId: 'output-1',
      previewUrl: '/api/sku-generation/files/output-1',
      downloadUrl: '/api/sku-generation/files/output-1?download=1',
    });
  });

  test('cancels pending items and retries only a failed item', async () => {
    mockDb.getSkuBatchTaskItems.mockResolvedValue([
      taskItem({ itemId: 'item-1', status: 'pending' }),
      taskItem({ itemId: 'item-2', status: 'running' }),
    ]);
    await cancelSkuBatch('batch-1', { userId: 'user-1', tenantId: 'tenant-1' });
    expect(mockDb.updateSkuBatchTaskItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'item-1',
        statuses: ['pending'],
        updates: expect.objectContaining({ status: 'cancelled' }),
      }),
    );
    expect(mockDb.updateSkuBatchTaskItem).not.toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'item-2' }),
    );

    mockDb.getSkuBatchTaskItem.mockResolvedValue(taskItem({ status: 'failed', retryCount: 1 }));
    await retrySkuBatchItem('batch-1', 'item-1', { userId: 'user-1', tenantId: 'tenant-1' });
    expect(mockDb.updateSkuBatchTaskItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'item-1',
        statuses: ['failed'],
        updates: expect.objectContaining({ status: 'pending', retryCount: 2 }),
      }),
    );
  });
});
