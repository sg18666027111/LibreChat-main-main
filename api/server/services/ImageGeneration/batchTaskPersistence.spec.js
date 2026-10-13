const mockDb = {
  acquireImageBatchTaskLease: jest.fn(),
  createImageBatchTaskItem: jest.fn(),
  getImageBatchTaskItems: jest.fn(),
  getImageGenerationJobByBatchItem: jest.fn(async () => null),
  updateImageBatchTaskItem: jest.fn(),
  updateImageBatchTaskItemWithLease: jest.fn(),
};

jest.mock('~/models', () => mockDb);

const {
  BATCH_CANCELLED_TTL_MS,
  BATCH_FAILED_TTL_MS,
  BATCH_SUCCEEDED_TTL_MS,
  buildPersistentItem,
  createPersistentBatchTask,
  getTerminalExpiry,
  getRecoveryMode,
  loadPersistentBatchTask,
} = require('./batchTaskPersistence');

const persistedBase = {
  userId: 'user-1',
  batchId: 'batch-1',
  itemId: 'item-1',
  templateId: 'white_box_1',
  templateName: '白底盒装',
  title: '测试商品',
  provider: 'apimart',
  model: 'gpt-image-2',
  modelKey: 'apimart_gpt_image_2_text',
  generationMode: 't2i',
  prompt: '测试提示词',
  status: 'processing',
  providerTaskId: 'task-paid-1',
  providerStatus: 'IN_PROGRESS',
  retryMode: 'resume_polling',
  retryCount: 0,
  submitAttempt: 1,
  outputWidth: 800,
  outputHeight: 800,
  expiresAt: new Date(Date.now() + 60_000),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('batchTaskPersistence', () => {
  test('creates every item in Mongo before batch execution starts', async () => {
    mockDb.createImageBatchTaskItem.mockResolvedValue({});
    const task = {
      id: 'batch-1',
      userId: 'user-1',
      title: '测试商品',
      mode: 't2i',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      outputWidth: 800,
      outputHeight: 800,
      items: [
        {
          itemId: 'item-1',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          prompt: '测试提示词',
          status: 'pending',
          persistenceStatus: 'pending',
          retryCount: 0,
          submitAttempt: 0,
          retryMode: 'resubmit_provider',
        },
      ],
    };

    await createPersistentBatchTask(task);

    expect(mockDb.createImageBatchTaskItem).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: 'batch-1',
        itemId: 'item-1',
        status: 'pending',
      }),
    );
  });

  test('does not persist reference image data or set TTL on active work', () => {
    const record = buildPersistentItem(
      {
        id: 'batch-1',
        userId: 'user-1',
        title: '测试商品',
        mode: 'i2i',
        provider: 'apimart',
        model: 'gpt-image-2',
        referenceImage: 'data:image/png;base64,c2VjcmV0LWltYWdl',
      },
      {
        itemId: 'item-1',
        templateId: 'white_box_1',
        templateName: '白底盒装',
        prompt: '测试提示词',
      },
    );

    expect(record).toMatchObject({
      hasReferenceImage: true,
      referenceImageMimeType: 'image/png',
      referenceImageFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(record).not.toHaveProperty('referenceImage');
    expect(record.expiresAt).toBeUndefined();
  });

  test('sets expiry only for terminal task states', () => {
    const now = 1_000;
    expect(getTerminalExpiry('pending', now)).toBeUndefined();
    expect(getTerminalExpiry('processing', now)).toBeUndefined();
    expect(getTerminalExpiry('succeeded', now).getTime()).toBe(now + BATCH_SUCCEEDED_TTL_MS);
    expect(getTerminalExpiry('failed', now).getTime()).toBe(now + BATCH_FAILED_TTL_MS);
    expect(getTerminalExpiry('cancelled', now).getTime()).toBe(now + BATCH_CANCELLED_TTL_MS);
  });

  test('restores a processing item from Mongo and resumes its original task', async () => {
    mockDb.getImageBatchTaskItems.mockResolvedValue([persistedBase]);

    const task = await loadPersistentBatchTask('batch-1', 'user-1');

    expect(mockDb.getImageBatchTaskItems).toHaveBeenCalledWith({
      batchId: 'batch-1',
      userId: 'user-1',
      includeSensitive: true,
    });
    expect(task.items[0]).toMatchObject({
      itemId: 'item-1',
      status: 'pending',
      persistenceStatus: 'processing',
      providerTaskId: 'task-paid-1',
      retryMode: 'resume_polling',
    });
  });

  test('restores provider_succeeded for result-only reprocessing', async () => {
    mockDb.getImageBatchTaskItems.mockResolvedValue([
      {
        ...persistedBase,
        status: 'provider_succeeded',
        providerResult: { image: { url: 'https://cdn.example/image.png?signature=secret' } },
        retryMode: 'reprocess_result',
      },
    ]);

    const task = await loadPersistentBatchTask('batch-1', 'user-1');

    expect(task.items[0]).toMatchObject({
      persistenceStatus: 'provider_succeeded',
      retryMode: 'reprocess_result',
    });
    expect(task.items[0].providerResult.image.url).toContain('signature=secret');
  });

  test('restores a completed result using its stable file identifier after process restart', async () => {
    mockDb.getImageBatchTaskItems.mockResolvedValue([
      {
        ...persistedBase,
        status: 'succeeded',
        resultImage: {
          fileId: 'file-persistent-result',
          filename: 'batch-main-image.png',
          contentType: 'image/png',
          bytes: 1024,
          width: 800,
          height: 800,
        },
      },
    ]);

    const task = await loadPersistentBatchTask('batch-1', 'user-1');

    expect(task.items[0]).toMatchObject({
      status: 'success',
      resultImage: {
        fileId: 'file-persistent-result',
        url: '/api/batch/image-generation/batch-1/items/item-1/file',
        downloadUrl: '/api/batch/image-generation/batch-1/items/item-1/file?download=1',
      },
    });
    expect(JSON.stringify(task.items[0].resultImage)).not.toContain('signature=');
  });

  test('keeps the persisted retryMode visible on hydrated succeeded items for result recovery', async () => {
    mockDb.getImageBatchTaskItems.mockResolvedValue([
      {
        ...persistedBase,
        status: 'succeeded',
        providerStatus: 'SUCCEEDED',
        providerTaskId: 'task-recovery-1',
        retryMode: 'reprocess_result',
        resultImage: { fileId: null, filename: 'broken.png', width: 800, height: 800 },
      },
    ]);

    const task = await loadPersistentBatchTask('batch-1', 'user-1');

    /** 运行时 retryMode 对 terminal 记录归一化为 undefined，但持久化原值必须保留给恢复判断 */
    expect(task.items[0].retryMode).toBeUndefined();
    expect(task.items[0].persistedRetryMode).toBe('reprocess_result');
    expect(task.items[0].persistenceStatus).toBe('succeeded');
  });

  test('does not resubmit an uncertain submitting item without providerTaskId', () => {
    expect(getRecoveryMode({ status: 'submitting', providerTaskId: null })).toBe('submit_unknown');
  });

  test('keeps a submitting item with an active lease pending for client polling', async () => {
    mockDb.getImageBatchTaskItems.mockResolvedValue([
      {
        ...persistedBase,
        status: 'submitting',
        providerTaskId: null,
        providerStatus: undefined,
        retryMode: 'resubmit_provider',
        errorKind: undefined,
        error: undefined,
        processingWorkerId: 'worker-live',
        processingLeaseUntil: new Date(Date.now() + 60_000),
      },
    ]);

    const task = await loadPersistentBatchTask('batch-1', 'user-1');

    expect(task).toMatchObject({
      status: 'pending',
      items: [
        expect.objectContaining({
          status: 'pending',
          persistenceStatus: 'submitting',
          providerTaskId: null,
          retryMode: undefined,
          errorKind: undefined,
          error: undefined,
        }),
      ],
    });
  });

  test('shows submit_unknown only after submitting lease is no longer active', async () => {
    mockDb.getImageBatchTaskItems.mockResolvedValue([
      {
        ...persistedBase,
        status: 'submitting',
        providerTaskId: null,
        providerStatus: undefined,
        retryMode: 'resubmit_provider',
        errorKind: undefined,
        error: undefined,
        processingWorkerId: 'worker-stale',
        processingLeaseUntil: new Date(Date.now() - 1_000),
      },
    ]);

    const task = await loadPersistentBatchTask('batch-1', 'user-1');

    expect(task).toMatchObject({
      status: 'failed',
      items: [
        expect.objectContaining({
          status: 'failed',
          persistenceStatus: 'submitting',
          retryMode: undefined,
          error: '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。',
        }),
      ],
    });
  });

  test('resubmits only provider-confirmed failed items', () => {
    expect(
      getRecoveryMode({
        status: 'failed',
        providerTaskId: 'task-succeeded-1',
        providerStatus: 'SUCCEEDED',
      }),
    ).toBe('resume_polling');
    expect(
      getRecoveryMode({
        status: 'failed',
        providerTaskId: 'task-succeeded-1',
        providerStatus: 'SUCCEEDED',
        providerResult: { image: { url: 'https://cdn.example/image.png' } },
      }),
    ).toBe('reprocess_result');
    expect(
      getRecoveryMode({
        status: 'failed',
        providerStatus: 'FAILED',
        retryMode: 'resubmit_provider',
      }),
    ).toBe('resubmit_provider');
    expect(
      getRecoveryMode({
        status: 'failed',
        retryMode: 'reprocess_result',
        providerResult: { image: { url: 'https://cdn.example/image.png' } },
      }),
    ).toBe('reprocess_result');
    expect(
      getRecoveryMode({
        status: 'failed',
        providerStatus: 'NO_RESULT',
        retryMode: 'resubmit_provider',
      }),
    ).toBe('resubmit_provider');
    expect(
      getRecoveryMode({
        status: 'failed',
        providerStatus: 'UNKNOWN',
        retryMode: 'resubmit_provider',
      }),
    ).toBe('submit_unknown');
  });
});
