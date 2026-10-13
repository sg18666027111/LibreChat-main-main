const sharp = require('sharp');

const mockGenerateAPIMartImage = jest.fn();
const mockRecordImageUsage = jest.fn();
const mockAdmitImageUsage = jest.fn(async () => null);
const mockReleaseImageUsage = jest.fn(async () => {});
jest.mock('~/server/services/UsageLedgerService', () => ({
  admitImageUsage: (...args) => mockAdmitImageUsage(...args),
  releaseImageUsage: (...args) => mockReleaseImageUsage(...args),
  buildImageUsageEnvelope: (...args) =>
    jest
      .requireActual('~/server/services/UsageDelivery/imageUsage')
      .buildImageUsageEnvelope(...args),
  recordImageUsage: (...args) => mockRecordImageUsage(...args),
}));
const mockRunAPIMartImg2JobAndWait = jest.fn();
const mockShouldUseAPIMartImg2AsyncForUser = jest.fn();
const mockGetPromptTemplateForBatch = jest.fn();
const mockResolvePackagingStyleTemplates = jest.fn();
const mockGenerateTextToImage = jest.fn();
const mockGenerateArkImage = jest.fn();
const mockDownloadProviderResult = jest.fn();
const mockIsHostAllowed = jest.fn(() => true);
const mockPollTask = jest.fn();
const mockPersistentTasks = new Map();
const mockPersistentRecords = new Map();
const mockCreatePersistentBatchTask = jest.fn();
const mockLoadPersistentBatchTask = jest.fn();
const mockAcquirePersistentItemLease = jest.fn();
const mockUpdatePersistentItem = jest.fn();
const mockUpdatePersistentItemWithLease = jest.fn();
const mockSaveBatchResultImage = jest.fn(async ({ output }) => ({
  fileId: 'file-normalized-result',
  filename: 'batch-main-image.png',
  contentType: output.mimeType,
  bytes: output.buffer.length,
  width: output.width,
  height: output.height,
}));
const mockGetAuthorizedBatchResultFile = jest.fn(async () => null);

async function createPngDataUri(width, height) {
  const buffer = await sharp({
    create: { width, height, channels: 4, background: '#22c55e' },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

jest.mock('~/server/services/ImageGeneration/adapters/apimart', () => ({
  generateAPIMartImage: mockGenerateAPIMartImage,
}));

jest.mock('~/server/services/ImageGeneration/apimartImg2Async', () => ({
  isAPIMartImg2ResolvedModel: jest.requireActual(
    '~/server/services/ImageGeneration/apimartImg2Async',
  ).isAPIMartImg2ResolvedModel,
  runAPIMartImg2JobAndWait: (...args) => mockRunAPIMartImg2JobAndWait(...args),
  shouldUseAPIMartImg2AsyncForUser: (...args) => mockShouldUseAPIMartImg2AsyncForUser(...args),
}));

jest.mock('~/server/services/ImageGeneration/adapters/fal', () => ({
  generateFalImage: jest.fn(),
}));

jest.mock('~/server/services/ImageGeneration/adapters/ark', () => ({
  generateArkImage: mockGenerateArkImage,
}));

jest.mock('~/server/services/ImageGeneration/siliconflow', () => ({
  TEXT_TO_IMAGE_MODEL: 'Qwen/Qwen-Image',
  generateTextToImage: mockGenerateTextToImage,
}));

jest.mock('~/server/services/ImageGeneration/providerResultDownload', () => ({
  downloadProviderResult: mockDownloadProviderResult,
}));

jest.mock('~/server/services/ImageGeneration/adapters/apimart/common', () => ({
  ...jest.requireActual('~/server/services/ImageGeneration/adapters/apimart/common'),
  pollTask: mockPollTask,
}));

jest.mock('~/server/services/ImageGeneration/resultProxy', () => ({
  registerResultImage: jest.fn(() => ({
    proxyPath: '/api/image-generation/result/generated.png',
    downloadPath: '/api/image-generation/result/generated.png?download=1',
  })),
  extractHostname: jest.fn(() => 'example.com'),
  isHostAllowed: mockIsHostAllowed,
}));

jest.mock('~/server/services/ImageGeneration/batchResultStorage', () => ({
  getAuthorizedBatchResultFile: mockGetAuthorizedBatchResultFile,
  saveBatchResultImage: mockSaveBatchResultImage,
  /**
   * 必须镜像真实 toStoredBatchResultImage 的幂等语义（client 形态二次映射时保留
   * fileId/contentType）。真实实现的双重映射回归由 batchResultStorage.spec.js 覆盖。
   */
  toStoredBatchResultImage: jest.fn((image) => {
    const { url: _url, proxiedUrl: _proxiedUrl, downloadUrl: _downloadUrl, ...stored } = image;
    return stored;
  }),
  toClientBatchResultImage: jest.fn(({ resultImage }) => ({
    ...resultImage,
    url: '/api/batch/image-generation/batch-test/items/item-test/file',
    proxiedUrl: '/api/batch/image-generation/batch-test/items/item-test/file',
    downloadUrl: '/api/batch/image-generation/batch-test/items/item-test/file?download=1',
  })),
}));

jest.mock('~/server/services/ImageGeneration/promptTemplateStore', () => ({
  getPromptTemplateForBatch: mockGetPromptTemplateForBatch,
  resolvePackagingStyleTemplates: mockResolvePackagingStyleTemplates,
}));

jest.mock('~/server/services/ImageGeneration/batchTaskPersistence', () => ({
  ...jest.requireActual('~/server/services/ImageGeneration/batchTaskPersistence'),
  acquirePersistentItemLease: mockAcquirePersistentItemLease,
  createPersistentBatchTask: mockCreatePersistentBatchTask,
  loadPersistentBatchTask: mockLoadPersistentBatchTask,
  updatePersistentItem: mockUpdatePersistentItem,
  updatePersistentItemWithLease: mockUpdatePersistentItemWithLease,
  updatePersistentUsageDelivery: async ({ batchId, itemId, eventId, revision, state }) => {
    const record = mockPersistentRecords.get(`${batchId}:${itemId}`);
    if (
      !record ||
      record.usageContext?.eventId !== eventId ||
      record.usageDelivery?.revision !== revision ||
      record.usageDelivery.state === 'persisted'
    )
      return null;
    record.usageDelivery = { ...record.usageDelivery, state };
    record.usageRecorded = state === 'persisted';
    return { ...record };
  },
}));

const {
  batchTaskStore,
  createBatchTask,
  getBatchResultError,
  getBatchTask,
  retryBatchItem,
  recoverBatchItemResult,
  serializeBatchTask,
} = require('./batchPackaging');

const flushAsyncWork = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

async function waitForBatchItem(task) {
  for (let index = 0; index < 100; index += 1) {
    if (['success', 'failed', 'cancelled'].includes(task.items[0].status)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Batch item did not finish: ${task.items[0].status}`);
}

describe('batchPackaging prompt assembly', () => {
  let square1024;

  beforeAll(async () => {
    square1024 = await createPngDataUri(1024, 1024);
  });

  beforeEach(() => {
    batchTaskStore.clear();
    mockRecordImageUsage.mockReset();
    mockPersistentTasks.clear();
    mockPersistentRecords.clear();
    mockCreatePersistentBatchTask.mockReset();
    mockCreatePersistentBatchTask.mockImplementation(async (task) => {
      mockPersistentTasks.set(task.id, task);
      for (const item of task.items) {
        mockPersistentRecords.set(`${task.id}:${item.itemId}`, {
          ...item,
          status: item.persistenceStatus,
          userId: task.userId,
          batchId: task.id,
          provider: task.provider,
          model: task.model,
        });
      }
    });
    mockLoadPersistentBatchTask.mockReset();
    mockLoadPersistentBatchTask.mockImplementation(async (batchId) => {
      return mockPersistentTasks.get(batchId) || null;
    });
    mockAcquirePersistentItemLease.mockReset();
    mockAcquirePersistentItemLease.mockImplementation(async ({ batchId, itemId, statuses }) => {
      const record = mockPersistentRecords.get(`${batchId}:${itemId}`);
      return record && statuses.includes(record.status) ? { ...record } : null;
    });
    const updateRecord = async ({ batchId, itemId, statuses, updates, unsetFields = [] }) => {
      const key = `${batchId}:${itemId}`;
      const record = mockPersistentRecords.get(key);
      if (!record || !statuses.includes(record.status)) {
        return null;
      }
      Object.assign(record, updates);
      for (const field of unsetFields) {
        delete record[field];
      }
      mockPersistentRecords.set(key, record);
      return { ...record };
    };
    mockUpdatePersistentItem.mockReset();
    mockUpdatePersistentItem.mockImplementation(updateRecord);
    mockUpdatePersistentItemWithLease.mockReset();
    mockUpdatePersistentItemWithLease.mockImplementation(updateRecord);
    mockAdmitImageUsage.mockReset().mockResolvedValue(null);
    mockReleaseImageUsage.mockClear();
    mockRecordImageUsage.mockReset();
    mockGenerateAPIMartImage.mockReset();
    mockGenerateAPIMartImage.mockResolvedValue({
      data: [{ b64_json: square1024, width: 1024, height: 1024 }],
    });
    mockRunAPIMartImg2JobAndWait.mockReset();
    mockRunAPIMartImg2JobAndWait.mockImplementation(({ providerRequest }) =>
      mockGenerateAPIMartImage(providerRequest),
    );
    mockShouldUseAPIMartImg2AsyncForUser.mockReset();
    mockShouldUseAPIMartImg2AsyncForUser.mockReturnValue(true);
    mockGenerateTextToImage.mockReset();
    mockGenerateTextToImage.mockResolvedValue({
      data: [{ url: 'https://example.com/generated.png', width: 1024, height: 1024 }],
    });
    mockGenerateArkImage.mockReset();
    mockGenerateArkImage.mockResolvedValue({
      images: [{ b64_json: square1024, width: 1024, height: 1024 }],
    });
    mockGetPromptTemplateForBatch.mockReset();
    mockResolvePackagingStyleTemplates.mockReset();
    mockResolvePackagingStyleTemplates.mockImplementation(async (templateIds) =>
      (templateIds || ['white_box_1']).map((key) => ({
        _id: `${key}-mongo-id`,
        key,
        name: key === 'white_box_1' ? '白底盒装' : key,
        category: 'batch_packaging',
        templateRole: 'packaging_style',
        prompt: key === 'white_box_1' ? '方形透明保鲜盒' : `DB prompt for ${key}`,
        isEnabled: true,
      })),
    );
    mockSaveBatchResultImage.mockClear();
    mockGetAuthorizedBatchResultFile.mockReset();
    mockGetAuthorizedBatchResultFile.mockResolvedValue(null);
    mockDownloadProviderResult.mockReset();
    mockIsHostAllowed.mockReset();
    mockIsHostAllowed.mockReturnValue(true);
    mockPollTask.mockReset();
  });

  test.each([
    { mode: 't2i', modelKey: 'fal_nano_banana_pro' },
    { mode: 't2i', model: 'fal-ai/nano-banana-pro' },
    { mode: 'i2i', modelKey: 'apimart_gemini_3_1_flash' },
    { mode: 'i2i', model: 'gemini-3.1-flash-image-preview' },
    { mode: 'i2i', modelKey: 'apimart_gemini_2_5_flash' },
    { mode: 'i2i', model: 'gemini-2.5-flash-image-preview' },
    { mode: 'i2i', modelKey: 'fal_grok_imagine_image_edit' },
    { mode: 'i2i', model: 'xai/grok-imagine-image/edit' },
  ])('rejects retired batch selection %j before creating a task', async (selection) => {
    await expect(
      createBatchTask({
        userId: 'user-1',
        title: '商品标题',
        referenceImage: square1024,
        ...selection,
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_MODEL_UNSUPPORTED', statusCode: 400 });
    expect(batchTaskStore.size).toBe(0);
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockRunAPIMartImg2JobAndWait).not.toHaveBeenCalled();
  });

  test.each([
    ['apimart_gemini_3_1_flash', 'gemini-3.1-flash-image-preview', 'apimart', true],
    ['apimart_gemini_2_5_flash', 'gemini-2.5-flash-image-preview', 'apimart', true],
    ['fal_grok_imagine_image_edit', 'xai/grok-imagine-image/edit', 'fal', true],
    ['fal_nano_banana_pro', 'fal-ai/nano-banana-pro', 'fal', true],
    ['apimart_gemini_3_1_flash', 'gemini-3.1-flash-image-preview', 'apimart', false],
    ['apimart_gemini_2_5_flash', 'gemini-2.5-flash-image-preview', 'apimart', false],
  ])(
    'recovers paid retired %s results (saved result: %s) without new submission',
    async (modelKey, model, provider, hasResult) => {
      const image = { b64_json: square1024, width: 1024, height: 1024 };
      const item = {
        itemId: 'item-retired',
        templateId: 'white_box_1',
        templateName: '包装',
        prompt: '原提示词',
        status: 'pending',
        persistenceStatus: hasResult ? 'processing_result' : 'processing',
        providerTaskId: 'paid-task',
        providerStatus: hasResult ? 'SUCCEEDED' : 'IN_PROGRESS',
        retryMode: hasResult ? 'reprocess_result' : 'resume_polling',
        submitAttempt: 1,
        retryCount: 0,
        ...(hasResult ? { providerResult: { provider, status: 'succeeded', image } } : {}),
      };
      const recovered = {
        id: 'batch-retired',
        userId: 'user-1',
        title: '旧任务',
        mode: 't2i',
        modelKey,
        model,
        provider,
        status: 'pending',
        items: [item],
        outputWidth: 800,
        outputHeight: 800,
      };
      mockPersistentTasks.set(recovered.id, recovered);
      mockPersistentRecords.set(`${recovered.id}:${item.itemId}`, {
        ...item,
        status: item.persistenceStatus,
      });
      mockPollTask.mockResolvedValue({ images: [image], status: 'success' });
      const { generateFalImage } = require('~/server/services/ImageGeneration/adapters/fal');
      generateFalImage.mockClear();

      const task = await getBatchTask(recovered.id, 'user-1');
      await waitForBatchItem(task);

      expect(task.items[0].status).toBe('success');
      expect(task.items[0].submitAttempt).toBe(1);
      expect(task.items[0].resultImage.fileId).toBe('file-normalized-result');
      expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
      expect(mockRunAPIMartImg2JobAndWait).not.toHaveBeenCalled();
      expect(generateFalImage).not.toHaveBeenCalled();
      if (hasResult) {
        expect(mockPollTask).not.toHaveBeenCalled();
      } else {
        expect(mockPollTask).toHaveBeenCalledWith(
          expect.objectContaining({ taskId: 'paid-task', model }),
        );
      }
    },
  );

  test('rejects the whole batch before enqueue when only some reservations fit', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({ prompt: 'Product {{title}}' });
    mockAdmitImageUsage
      .mockResolvedValueOnce({ reservationId: 'first' })
      .mockRejectedValueOnce(
        Object.assign(new Error('full'), { code: 'USAGE_CAPTURE_UNAVAILABLE' }),
      );
    await expect(
      createBatchTask({
        userId: 'user-1',
        title: '测试',
        mode: 't2i',
        modelKey: 'apimart_gpt_image_2_text',
        templateIds: ['white_box_1', 'second'],
      }),
    ).rejects.toMatchObject({ code: 'USAGE_CAPTURE_UNAVAILABLE' });
    expect(mockCreatePersistentBatchTask).not.toHaveBeenCalled();
    expect(mockReleaseImageUsage).toHaveBeenCalledWith({ reservationId: 'first' });
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });
  test('a ledger exception does not change a successfully stored batch image into failure', async () => {
    mockAdmitImageUsage.mockImplementation(
      async (input) =>
        input.usageContext || {
          source: 'batch',
          sourceKey: `batch_image_generation:${input.requestId}:${input.itemId}`,
          eventId: `batch_image_generation:${input.requestId}:${input.itemId}`,
          reservationId: 'reserved',
          occurredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          reportingSubjectId: 'subject',
          pricing: { kind: 'confirmed_cost', costCny: 0.25 },
        },
    );
    mockGetPromptTemplateForBatch.mockResolvedValue({ prompt: 'Product {{title}}' });
    mockShouldUseAPIMartImg2AsyncForUser.mockReturnValue(false);
    mockRecordImageUsage.mockRejectedValue(new Error('ledger unavailable'));
    const task = await createBatchTask({
      userId: '507f1f77bcf86cd799439011',
      title: '测试',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);
    await flushAsyncWork();
    expect(task.items[0].status).toBe('success');
    const source = mockPersistentRecords.get(`${task.id}:${task.items[0].itemId}`);
    expect(source.usageDelivery).toMatchObject({
      state: 'pending',
      envelope: { event: { status: 'succeeded', imageCount: 1 }, pricing: { costCny: 0.25 } },
    });
    expect(source.usageDelivery.envelope.event).not.toHaveProperty('prompt');
    expect(mockGenerateAPIMartImage).toHaveBeenCalledTimes(1);
  });
  test('the durable child owns usage when its batch parent observes the same successful result', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({ prompt: 'Product {{title}}' });
    mockRunAPIMartImg2JobAndWait.mockImplementationOnce(
      async ({ onJobUpdate, providerRequest }) => {
        await onJobUpdate({ internalTaskId: 'paid-child', status: 'polling' });
        return mockGenerateAPIMartImage(providerRequest);
      },
    );
    const task = await createBatchTask({
      userId: 'user-1',
      title: '测试',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);
    expect(task.items[0].status).toBe('success');
    expect(mockRecordImageUsage).not.toHaveBeenCalled();
  });

  test('uses the default global prompt template when promptTemplateId is omitted', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}，强调真实商品包装。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });

    const prompt = task.items[0].prompt;
    expect(task.id).toMatch(/^batch_[a-f0-9]{32}$/);
    expect(task.items[0].itemId).toMatch(/^item_[a-f0-9]{32}$/);
    expect(mockGetPromptTemplateForBatch).toHaveBeenCalledWith(undefined);
    expect(prompt).toContain('默认全局提示词：标题 红枣核桃糕，强调真实商品包装。');
    expect(prompt).toContain('包装款式参考：');
    expect(prompt).toContain('方形透明保鲜盒');
    expect(prompt).toContain('输出规格要求：');
    expect(prompt).toContain('必须生成 1:1 方图');
    expect(prompt).toContain('最终交付尺寸为 800x800');
    expect(prompt).toContain('禁止虚假功效、医疗暗示、治疗承诺或夸张保证');
    await flushAsyncWork();
  });

  test('composes and persists a custom DB packaging prompt with its canonical key', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'global-id',
      key: 'batch_packaging_default',
      name: 'Global business prompt',
      prompt: 'UNIQUE_GLOBAL_BUSINESS_MARKER {{title}}',
    });
    mockResolvePackagingStyleTemplates.mockResolvedValue([
      {
        _id: '507f1f77bcf86cd799439011',
        key: 'custom_test_style',
        name: 'Custom DB style',
        prompt: 'UNIQUE_CUSTOM_PACKAGING_MARKER',
      },
    ]);

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['custom_test_style'],
    });

    expect(task.items[0]).toMatchObject({
      templateId: 'custom_test_style',
      templateName: 'Custom DB style',
    });
    expect(task.items[0].prompt).toContain('UNIQUE_CUSTOM_PACKAGING_MARKER');
    expect(task.items[0].prompt).toContain('UNIQUE_GLOBAL_BUSINESS_MARKER');
    expect(mockCreatePersistentBatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            templateId: 'custom_test_style',
            templateName: 'Custom DB style',
            prompt: expect.stringContaining('UNIQUE_CUSTOM_PACKAGING_MARKER'),
          }),
        ],
      }),
    );
    await flushAsyncWork();
  });

  test('uses a DB-modified system prompt instead of the stale static prompt', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'global-id',
      key: 'batch_packaging_default',
      name: 'Global business prompt',
      prompt: 'Global {{title}}',
    });
    mockResolvePackagingStyleTemplates.mockResolvedValue([
      {
        _id: 'system-mongo-id',
        key: 'white_box_1',
        name: 'DB system style',
        prompt: 'DB_MODIFIED_WHITE_BOX_PROMPT',
      },
    ]);

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });

    expect(task.items[0].prompt).toContain('DB_MODIFIED_WHITE_BOX_PROMPT');
    expect(task.items[0].prompt).not.toContain('方形透明保鲜盒');
    await flushAsyncWork();
  });

  test('fails a mixed valid and invalid selection before any provider call', async () => {
    const validationError = Object.assign(new Error('包装模板不可用。'), { statusCode: 400 });
    mockResolvePackagingStyleTemplates.mockRejectedValue(validationError);
    mockGetPromptTemplateForBatch.mockResolvedValue({
      key: 'batch_packaging_default',
      prompt: 'Global {{title}}',
    });

    await expect(
      createBatchTask({
        userId: 'user-1',
        title: '红枣核桃糕',
        mode: 't2i',
        modelKey: 'apimart_gpt_image_2_text',
        templateIds: ['white_box_1', 'unknown'],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await flushAsyncWork();
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockCreatePersistentBatchTask).not.toHaveBeenCalled();
  });

  test('fails an over-limit selection before persistence or any provider call', async () => {
    const validationError = Object.assign(new Error('每批最多选择 8 个包装样式。'), {
      statusCode: 400,
    });
    mockResolvePackagingStyleTemplates.mockRejectedValue(validationError);

    await expect(
      createBatchTask({
        userId: 'user-1',
        title: '红枣核桃糕',
        mode: 't2i',
        modelKey: 'apimart_gpt_image_2_text',
        templateIds: Array.from({ length: 9 }, (_, index) => `packaging_style_${index + 1}`),
      }),
    ).rejects.toMatchObject({
      message: '每批最多选择 8 个包装样式。',
      statusCode: 400,
    });

    await flushAsyncWork();
    expect(mockCreatePersistentBatchTask).not.toHaveBeenCalled();
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockRunAPIMartImg2JobAndWait).not.toHaveBeenCalled();
    expect(mockGenerateTextToImage).not.toHaveBeenCalled();
    expect(mockGenerateArkImage).not.toHaveBeenCalled();
  });

  test('runs Flare text batch items through durable jobs with separate identity and billing', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'template',
      prompt: 'Generate {{title}}',
    });
    mockRunAPIMartImg2JobAndWait.mockResolvedValueOnce({
      images: [{ b64_json: square1024, width: 1024, height: 1024 }],
      cost: 0.02,
      json: { data: { credits_cost: 0.2 } },
      taskId: 'flare-batch',
      status: 'success',
    });
    const task = await createBatchTask({
      userId: 'user-1',
      title: 'Synthetic box',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_5_flare',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);
    expect(task).toMatchObject({
      model: 'gpt-image-2.5-flare',
      modelKey: 'apimart_gpt_image_2_5_flare',
      provider: 'apimart',
    });
    expect(task.items[0].status).toBe('success');
    expect(mockRunAPIMartImg2JobAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-2.5-flare',
        taskType: 'text-to-image',
        providerRequest: expect.objectContaining({ size: '1024x1024', count: 1 }),
      }),
    );
    expect(mockRecordImageUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelKey: 'apimart_gpt_image_2_5_flare',
        metadata: { providerCost: 0.02, providerCreditsCost: 0.2 },
      }),
    );
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test('runs optional Sunburst batch editing through durable jobs and stores its model identity', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({ _id: 'template', prompt: 'Edit {{title}}' });
    mockRunAPIMartImg2JobAndWait.mockResolvedValueOnce({
      images: [{ b64_json: square1024, width: 1024, height: 1024 }],
      cost: 0.017666,
      json: { data: { credits_cost: 0.17666 } },
      taskId: 'sunburst-batch-task',
      status: 'success',
    });
    const task = await createBatchTask({
      userId: 'user-1',
      title: 'Synthetic product',
      mode: 'i2i',
      modelKey: 'apimart_gpt_image_2_5_sunburst',
      referenceImage: square1024,
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);
    expect(task).toMatchObject({
      provider: 'apimart',
      model: 'gpt-image-2.5-sunburst',
      modelKey: 'apimart_gpt_image_2_5_sunburst',
    });
    expect(task.items[0].status).toBe('success');
    expect(mockRunAPIMartImg2JobAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-2.5-sunburst',
        modelKey: 'apimart_gpt_image_2_5_sunburst',
        taskType: 'single-image-edit',
        providerRequest: expect.objectContaining({
          model: 'gpt-image-2.5-sunburst',
          size: '1024x1024',
          imageInputs: [square1024],
        }),
      }),
    );
    expect(mockRecordImageUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: { providerCost: 0.017666, providerCreditsCost: 0.17666 },
      }),
    );
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test('routes APIMart GPT Image 2 batch items through durable internal jobs', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '生成包装：{{title}}',
    });
    mockRunAPIMartImg2JobAndWait.mockResolvedValueOnce({
      images: [{ b64_json: square1024, width: 1024, height: 1024 }],
      taskId: 'provider-task-from-internal-job',
      status: 'success',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      tenantId: 'tenant-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);

    expect(mockRunAPIMartImg2JobAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        businessType: 'batch_image_generation',
        taskType: 'text-to-image',
        provider: 'apimart',
        model: 'gpt-image-2',
        modelKey: 'apimart_gpt_image_2_text',
      }),
    );
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test('keeps APIMart GPT Image 2 batch items on the sync path outside async rollout', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '生成包装：{{title}}',
    });
    mockShouldUseAPIMartImg2AsyncForUser.mockReturnValue(false);

    const task = await createBatchTask({
      userId: 'user-1',
      tenantId: 'tenant-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);

    expect(mockShouldUseAPIMartImg2AsyncForUser).toHaveBeenCalledWith('user-1');
    expect(mockRunAPIMartImg2JobAndWait).not.toHaveBeenCalled();
    expect(mockGenerateAPIMartImage).toHaveBeenCalledTimes(1);
  });

  test('uses the selected global prompt template when promptTemplateId is provided', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'selected-template-id',
      key: 'custom_batch_packaging_selected',
      name: '指定全局模板',
      prompt: '指定全局提示词：{{title}} 使用运营确认版本。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '山楂丸',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
      promptTemplateId: 'selected-template-id',
    });

    expect(mockGetPromptTemplateForBatch).toHaveBeenCalledWith('selected-template-id');
    expect(task.items[0].prompt).toContain('指定全局提示词：山楂丸 使用运营确认版本。');
    expect(task.items[0].prompt).toContain('包装款式参考：');
    await flushAsyncWork();
  });

  test('stores a clear operator-safe error when APIMart GPT Image 2 times out', async () => {
    const timeoutError = new Error(
      'Task timeout: status IN_PROGRESS for 982 seconds (limit: 900s)',
    );
    timeoutError.code = 'IMAGE_GENERATION_TIMEOUT';
    timeoutError.timeoutMs = 900000;
    timeoutError.providerTaskId = 'task-timeout-1';
    mockGenerateAPIMartImage.mockRejectedValueOnce(timeoutError);
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await flushAsyncWork();

    expect(task.items[0].status).toBe('failed');
    expect(task.items[0].error).toBe(
      '供应商仍在处理本次任务，系统将继续检查原任务。请勿重复提交，以免产生重复费用。',
    );
    expect(task.items[0].error).not.toContain('建议重试');
    expect(task.items[0].error).not.toContain('简化提示词');
    expect(task.items[0].error).not.toContain('切换 Seedream');
    expect(task.items[0].providerStatus).toBe('IN_PROGRESS');
    expect(task.items[0].retryMode).toBe('resume_polling');
    expect(task.items[0].error).not.toContain('982 seconds');
  });

  test('stores a clear operator-safe error when APIMart GPT Image 2 returns no image', async () => {
    const noImageError = new Error(
      'Upstream did not return the expected image. Please adjust your prompt. https://example.com/result.png',
    );
    noImageError.statusCode = 502;
    mockGenerateAPIMartImage.mockRejectedValueOnce(noImageError);
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await flushAsyncWork();

    expect(task.items[0].status).toBe('failed');
    expect(task.items[0].error).toBe(
      'APIMart GPT Image 2 未返回有效图片结果，可能是提示词过长、内容过复杂或上游返回异常。建议简化提示词或切换 Seedream 5.0 Pro。',
    );
    expect(task.items[0].error).not.toContain('https://example.com');
  });

  test('keeps non-APIMart batch errors unchanged', async () => {
    mockGenerateTextToImage.mockRejectedValueOnce(new Error('SiliconFlow temporary failure'));
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      model: 'Qwen/Qwen-Image',
      templateIds: ['white_box_1'],
    });
    await flushAsyncWork();

    expect(task.provider).toBe('siliconflow');
    expect(task.items[0].status).toBe('failed');
    expect(task.items[0].error).toBe('SiliconFlow temporary failure');
  });

  test('passes 1:1 1024x1024 constraints to Ark batch text-to-image requests', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'ark_seedream_5_0_t2i',
      templateIds: ['white_box_1'],
    });
    await flushAsyncWork();

    expect(mockGenerateArkImage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'text-to-image',
        aspectRatio: '1:1',
        size: '1024x1024',
        imageSize: '1024x1024',
        width: 1024,
        height: 1024,
        isBatchMainImage: true,
        imageInputs: [],
      }),
    );
    expect(mockGenerateArkImage.mock.calls[0][0]).not.toHaveProperty('outputQuality');
  });

  test('passes 1:1 1024x1024 constraints to Ark batch image-to-image requests', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 'i2i',
      modelKey: 'ark_seedream_5_0_t2i',
      referenceImage: 'data:image/png;base64,AAAA',
      templateIds: ['white_box_1'],
    });
    await flushAsyncWork();

    expect(mockGenerateArkImage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'single-image-edit',
        aspectRatio: '1:1',
        size: '1024x1024',
        imageSize: '1024x1024',
        width: 1024,
        height: 1024,
        isBatchMainImage: true,
        imageInputs: ['data:image/png;base64,AAAA'],
      }),
    );
    expect(mockGenerateArkImage.mock.calls[0][0]).not.toHaveProperty('outputQuality');
  });

  test.each([
    ['already square at delivery size', 800, 800, false],
    ['larger square', 1024, 1024, true],
    ['portrait provider drift', 768, 1024, true],
  ])(
    'delivers APIMart %s as real 800x800 pixels',
    async (_label, width, height, _expectedNormalized) => {
      const dataUri = await createPngDataUri(width, height);
      mockGenerateAPIMartImage.mockResolvedValueOnce({
        data: [{ b64_json: dataUri, width, height }],
      });
      mockGetPromptTemplateForBatch.mockResolvedValue({
        _id: 'default-template-id',
        key: 'batch_packaging_default',
        name: '默认批量包装主图提示词',
        prompt: '默认全局提示词：标题 {{title}}。',
      });

      const task = await createBatchTask({
        userId: 'user-1',
        title: '红枣核桃糕',
        mode: 't2i',
        modelKey: 'apimart_gpt_image_2_text',
        templateIds: ['white_box_1'],
      });
      await waitForBatchItem(task);

      expect(task.items[0].status).toBe('success');
      expect(task.items[0].resultImage).toMatchObject({
        width: 800,
        height: 800,
      });
      expect(task.items[0].resultImage).toHaveProperty('fileId', 'file-normalized-result');
      expect(task.items[0].resultImage).not.toHaveProperty('b64_json');
      expect(mockUpdatePersistentItemWithLease).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            resultImage: expect.not.objectContaining({ url: expect.anything() }),
          }),
        }),
      );
      const registeredBuffer = mockSaveBatchResultImage.mock.calls.at(-1)[0].output.buffer;
      expect(await sharp(registeredBuffer).metadata()).toMatchObject({ width: 800, height: 800 });
      expect(mockGenerateAPIMartImage).toHaveBeenCalledWith(
        expect.objectContaining({ size: '1024x1024', width: 1024, height: 1024 }),
      );
    },
  );

  test('delivers Ark Seedream 1024x1024 output as real 800x800 pixels', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'ark_seedream_5_0_t2i',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);

    expect(task.items[0].resultImage).toMatchObject({
      width: 800,
      height: 800,
      fileId: 'file-normalized-result',
    });
    const registeredBuffer = mockSaveBatchResultImage.mock.calls.at(-1)[0].output.buffer;
    expect(await sharp(registeredBuffer).metadata()).toMatchObject({ width: 800, height: 800 });
  });

  test('accepts a dynamic APIMart provider result without widening the static allowlist', async () => {
    const resultBuffer = Buffer.from(square1024.split(',')[1], 'base64');
    mockIsHostAllowed.mockReturnValue(false);
    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: resultBuffer,
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    mockGenerateAPIMartImage.mockResolvedValueOnce({
      resultUrl: 'https://temporary-result-cdn.example/signed.png?signature=secret',
      taskId: 'task-paid-1',
    });
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);

    expect(task.items[0].status).toBe('success');
    expect(task.items[0].resultImage).toMatchObject({ width: 800, height: 800 });
    expect(mockDownloadProviderResult).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'apimart' }),
    );
    expect(mockIsHostAllowed).not.toHaveBeenCalledWith('temporary-result-cdn.example');
  });

  test('reprocesses a completed APIMart result without submitting another paid task', async () => {
    const rejected = new Error('blocked');
    rejected.code = 'RESULT_URL_REJECTED';
    rejected.errorKind = 'result_url_rejected';
    rejected.hostname = 'temporary-result-cdn.example';
    mockDownloadProviderResult.mockRejectedValueOnce(rejected);
    mockGenerateAPIMartImage.mockResolvedValueOnce({
      resultUrl: 'https://temporary-result-cdn.example/signed.png?signature=secret',
      cost: 0.017666,
      json: { data: { credits_cost: 0.17666 } },
      taskId: 'task-paid-1',
    });
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);

    expect(task.items[0]).toMatchObject({
      status: 'failed',
      errorKind: 'result_url_rejected',
      retryMode: 'reprocess_result',
      error: '生成结果地址未通过安全校验，请重试或联系管理员。',
    });
    expect(mockRecordImageUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: { providerCost: 0.017666, providerCreditsCost: 0.17666 },
      }),
    );
    expect(mockGenerateAPIMartImage).toHaveBeenCalledTimes(1);

    const resultBuffer = Buffer.from(square1024.split(',')[1], 'base64');
    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: resultBuffer,
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    batchTaskStore.clear();
    await retryBatchItem(task.id, 'white_box_1', 'user-1');
    await waitForBatchItem(task);

    expect(mockRecordImageUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: { providerCost: 0.017666, providerCreditsCost: 0.17666 },
      }),
    );
    expect(task.items[0].status).toBe('success');
    expect(mockGenerateAPIMartImage).toHaveBeenCalledTimes(1);
  });

  test('renews the lease throughout provider result processing', async () => {
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认全局提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);

    expect(mockUpdatePersistentItemWithLease).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ['processing_result'],
        updates: expect.objectContaining({
          status: 'processing_result',
          processingLeaseUntil: expect.any(Date),
        }),
      }),
    );
  });

  test('resumes polling the original APIMart task after a processing timeout', async () => {
    const timeout = new Error('timeout');
    timeout.code = 'IMAGE_GENERATION_TIMEOUT';
    timeout.providerTaskId = 'task-processing-1';
    timeout.providerStatus = 'IN_PROGRESS';
    mockGenerateAPIMartImage.mockRejectedValueOnce(timeout);
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);
    expect(task.items[0].retryMode).toBe('resume_polling');
    expect(task.items[0].submitAttempt).toBe(1);
    expect(task.items[0].providerTaskId).toBe('task-processing-1');

    const resultBuffer = Buffer.from(square1024.split(',')[1], 'base64');
    mockPollTask.mockResolvedValueOnce({
      resultUrl: 'https://temporary-result-cdn.example/refreshed.png?signature=new',
      status: 'success',
    });
    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: resultBuffer,
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    await retryBatchItem(task.id, 'white_box_1', 'user-1');
    await waitForBatchItem(task);

    expect(task.items[0].status).toBe('success');
    expect(task.items[0].submitAttempt).toBe(1);
    expect(task.items[0].providerTaskId).toBe('task-processing-1');
    expect(mockGenerateAPIMartImage).toHaveBeenCalledTimes(1);
    expect(mockPollTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-processing-1' }),
    );
  });

  test('repolls the original task when a signed APIMart result URL expired', async () => {
    const expired = new Error('expired');
    expired.code = 'RESULT_URL_EXPIRED';
    expired.errorKind = 'result_download_failed';
    expired.retryMode = 'resume_polling';
    expired.hostname = 'temporary-result-cdn.example';
    mockDownloadProviderResult.mockRejectedValueOnce(expired);
    mockGenerateAPIMartImage.mockResolvedValueOnce({
      resultUrl: 'https://temporary-result-cdn.example/expired.png?signature=old',
      taskId: 'task-paid-1',
    });
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);
    expect(task.items[0].retryMode).toBe('resume_polling');

    mockPollTask.mockResolvedValueOnce({
      resultUrl: 'https://temporary-result-cdn.example/refreshed.png?signature=new',
      status: 'success',
    });
    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: Buffer.from(square1024.split(',')[1], 'base64'),
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    await retryBatchItem(task.id, 'white_box_1', 'user-1');
    await waitForBatchItem(task);

    expect(task.items[0].status).toBe('success');
    expect(mockGenerateAPIMartImage).toHaveBeenCalledTimes(1);
    expect(mockPollTask).toHaveBeenCalledTimes(1);
  });

  test('reprocesses locally after normalization failure without regenerating', async () => {
    const normalizationFailure = new Error('sharp failed');
    normalizationFailure.code = 'IMAGE_OUTPUT_NORMALIZE_FAILED';
    normalizationFailure.errorKind = 'normalization_failed';
    mockDownloadProviderResult.mockRejectedValueOnce(normalizationFailure);
    mockGenerateAPIMartImage.mockResolvedValueOnce({
      resultUrl: 'https://temporary-result-cdn.example/signed.png?signature=secret',
      taskId: 'task-paid-1',
    });
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);
    expect(task.items[0]).toMatchObject({
      errorKind: 'normalization_failed',
      retryMode: 'reprocess_result',
    });

    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: Buffer.from(square1024.split(',')[1], 'base64'),
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    batchTaskStore.clear();
    await retryBatchItem(task.id, 'white_box_1', 'user-1');
    await waitForBatchItem(task);

    expect(task.items[0].status).toBe('success');
    expect(mockGenerateAPIMartImage).toHaveBeenCalledTimes(1);
  });

  test('persists APIMart providerTaskId before the submit call returns', async () => {
    const events = [];
    mockGenerateAPIMartImage.mockImplementationOnce(async (request) => {
      await request.onProviderTaskSubmitted({
        providerTaskId: 'task-paid-immediate',
        providerStatus: 'IN_PROGRESS',
      });
      events.push('provider-returned');
      return {
        data: [{ b64_json: square1024, width: 1024, height: 1024 }],
        taskId: 'task-paid-immediate',
      };
    });
    mockUpdatePersistentItemWithLease.mockImplementation(
      async ({ batchId, itemId, statuses, updates, unsetFields = [] }) => {
        const key = `${batchId}:${itemId}`;
        const record = mockPersistentRecords.get(key);
        if (!record || !statuses.includes(record.status)) {
          return null;
        }
        Object.assign(record, updates);
        for (const field of unsetFields) {
          delete record[field];
        }
        if (updates.providerTaskId) {
          events.push(`persisted:${updates.providerTaskId}`);
        }
        return { ...record };
      },
    );
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);

    expect(events.indexOf('persisted:task-paid-immediate')).toBeLessThan(
      events.indexOf('provider-returned'),
    );
  });

  test('restores a processing task after the process cache is cleared', async () => {
    const recovered = {
      id: 'batch-recovered-1',
      userId: 'user-1',
      title: '恢复任务',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      provider: 'apimart',
      status: 'pending',
      outputWidth: 800,
      outputHeight: 800,
      runnerActive: false,
      items: [
        {
          itemId: 'item-recovered-1',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          prompt: '恢复提示词',
          status: 'pending',
          persistenceStatus: 'processing',
          providerTaskId: 'task-original-1',
          providerStatus: 'IN_PROGRESS',
          retryMode: 'resume_polling',
          retryCount: 1,
          submitAttempt: 1,
        },
      ],
    };
    mockPersistentTasks.set(recovered.id, recovered);
    mockPersistentRecords.set(`${recovered.id}:item-recovered-1`, {
      ...recovered.items[0],
      status: 'processing',
    });
    mockPollTask.mockImplementationOnce(async ({ context }) => {
      await context.onProviderPoll({ providerStatus: 'SUCCEEDED' });
      return {
        resultUrl: 'https://temporary-result-cdn.example/recovered.png?signature=secret',
        status: 'success',
      };
    });
    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: Buffer.from(square1024.split(',')[1], 'base64'),
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    batchTaskStore.clear();

    const task = await getBatchTask(recovered.id, 'user-1');
    await waitForBatchItem(task);

    expect(task.items[0].status).toBe('success');
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockPollTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-original-1' }),
    );
  });

  test('reprocesses an APIMart result without resubmitting when only the provider task id remains', async () => {
    const recovered = {
      id: 'batch-reprocess-poll-1',
      userId: 'user-1',
      title: '恢复结果',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      provider: 'apimart',
      status: 'pending',
      outputWidth: 800,
      outputHeight: 800,
      items: [
        {
          itemId: 'item-reprocess-poll-1',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          prompt: '恢复提示词',
          status: 'failed',
          persistenceStatus: 'failed',
          providerTaskId: 'task-result-only-1',
          providerStatus: 'SUCCEEDED',
          retryMode: 'reprocess_result',
          retryCount: 1,
          submitAttempt: 1,
        },
      ],
    };
    mockPersistentTasks.set(recovered.id, recovered);
    mockPersistentRecords.set(`${recovered.id}:item-reprocess-poll-1`, {
      ...recovered.items[0],
      status: 'failed',
    });
    mockPollTask.mockResolvedValueOnce({
      resultUrl: 'https://temporary-result-cdn.example/reprocess.png?signature=secret',
      status: 'success',
    });
    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: Buffer.from(square1024.split(',')[1], 'base64'),
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    batchTaskStore.clear();

    await retryBatchItem(recovered.id, 'white_box_1', 'user-1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockPollTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-result-only-1' }),
    );
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test('keeps derived safe retry context when retrying a legacy failed APIMart item', async () => {
    const recovered = {
      id: 'batch-legacy-failed-succeeded-1',
      userId: 'user-1',
      title: '恢复旧失败态',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      provider: 'apimart',
      status: 'failed',
      outputWidth: 800,
      outputHeight: 800,
      items: [
        {
          itemId: 'item-legacy-failed-succeeded-1',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          prompt: '恢复提示词',
          status: 'failed',
          persistenceStatus: 'failed',
          providerTaskId: 'task-legacy-succeeded-1',
          providerStatus: 'SUCCEEDED',
          retryMode: 'resume_polling',
          retryCount: 1,
          submitAttempt: 1,
        },
      ],
    };
    mockPersistentTasks.set(recovered.id, recovered);
    mockPersistentRecords.set(`${recovered.id}:item-legacy-failed-succeeded-1`, {
      ...recovered.items[0],
      status: 'failed',
      retryMode: undefined,
    });
    mockPollTask.mockResolvedValueOnce({
      resultUrl: 'https://temporary-result-cdn.example/legacy.png?signature=secret',
      status: 'success',
    });
    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: Buffer.from(square1024.split(',')[1], 'base64'),
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    batchTaskStore.clear();

    const retriedTask = await retryBatchItem(recovered.id, 'white_box_1', 'user-1');
    await waitForBatchItem(retriedTask);
    const persisted = mockPersistentRecords.get(`${recovered.id}:item-legacy-failed-succeeded-1`);

    expect(retriedTask.items[0].status).toBe('success');
    expect(mockPollTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-legacy-succeeded-1' }),
    );
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(persisted.submitAttempt).toBe(1);
    expect(persisted.providerTaskId).toBe('task-legacy-succeeded-1');
  });

  test('rejects provider submit unknown retry without submitting a new paid task', async () => {
    const recovered = {
      id: 'batch-submit-unknown-1',
      userId: 'user-1',
      title: '提交状态未知',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      provider: 'apimart',
      status: 'failed',
      outputWidth: 800,
      outputHeight: 800,
      items: [
        {
          itemId: 'item-submit-unknown-1',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          prompt: '恢复提示词',
          status: 'failed',
          persistenceStatus: 'failed',
          errorKind: 'provider_submit_unknown',
          providerTaskId: 'task-submit-unknown-1',
          retryMode: 'resubmit_provider',
          retryCount: 1,
          submitAttempt: 1,
        },
      ],
    };
    mockPersistentTasks.set(recovered.id, recovered);
    mockPersistentRecords.set(`${recovered.id}:item-submit-unknown-1`, {
      ...recovered.items[0],
      status: 'failed',
    });
    batchTaskStore.clear();

    await expect(retryBatchItem(recovered.id, 'white_box_1', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'BATCH_ITEM_RETRY_NOT_SAFE',
    });

    const persisted = mockPersistentRecords.get(`${recovered.id}:item-submit-unknown-1`);
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockPollTask).not.toHaveBeenCalled();
    expect(persisted.submitAttempt).toBe(1);
    expect(persisted.providerTaskId).toBe('task-submit-unknown-1');
  });

  test('recovers a succeeded APIMart item with a missing stored file without resubmitting', async () => {
    const recovered = {
      id: 'batch-bad-success-1',
      userId: 'user-1',
      title: '恢复坏成功态',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      provider: 'apimart',
      status: 'done',
      outputWidth: 800,
      outputHeight: 800,
      items: [
        {
          itemId: 'item-bad-success-1',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          prompt: '恢复提示词',
          status: 'success',
          persistenceStatus: 'succeeded',
          providerTaskId: 'task-bad-success-1',
          providerStatus: 'SUCCEEDED',
          retryMode: 'reprocess_result',
          retryCount: 0,
          submitAttempt: 1,
          resultImage: {
            fileId: null,
            filename: 'old.png',
            width: 800,
            height: 800,
          },
        },
      ],
    };
    mockPersistentTasks.set(recovered.id, recovered);
    mockPersistentRecords.set(`${recovered.id}:item-bad-success-1`, {
      ...recovered.items[0],
      status: 'succeeded',
    });
    mockPollTask.mockResolvedValueOnce({
      resultUrl: 'https://temporary-result-cdn.example/recovered.png?signature=secret',
      status: 'success',
    });
    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: Buffer.from(square1024.split(',')[1], 'base64'),
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    batchTaskStore.clear();

    const task = await recoverBatchItemResult(recovered.id, 'item-bad-success-1', 'user-1');
    await waitForBatchItem(task);

    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockPollTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-bad-success-1' }),
    );
    expect(mockSaveBatchResultImage).toHaveBeenCalled();
    expect(task.items[0]).toMatchObject({
      status: 'success',
      providerTaskId: 'task-bad-success-1',
      submitAttempt: 1,
    });
    expect(task.items[0].resultImage.fileId).toBe('file-normalized-result');
  });

  test('does not recover a succeeded item when its stored file still exists', async () => {
    const recovered = {
      id: 'batch-good-success-1',
      userId: 'user-1',
      title: '已有文件',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      provider: 'apimart',
      status: 'done',
      outputWidth: 800,
      outputHeight: 800,
      items: [
        {
          itemId: 'item-good-success-1',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          prompt: '恢复提示词',
          status: 'success',
          persistenceStatus: 'succeeded',
          providerTaskId: 'task-good-success-1',
          providerStatus: 'SUCCEEDED',
          retryMode: 'reprocess_result',
          retryCount: 0,
          submitAttempt: 1,
          resultImage: { fileId: 'file-existing-result', width: 800, height: 800 },
        },
      ],
    };
    mockPersistentTasks.set(recovered.id, recovered);
    mockPersistentRecords.set(`${recovered.id}:item-good-success-1`, {
      ...recovered.items[0],
      status: 'succeeded',
    });
    mockGetAuthorizedBatchResultFile.mockResolvedValueOnce({ file_id: 'file-existing-result' });

    const task = await recoverBatchItemResult(recovered.id, 'item-good-success-1', 'user-1');

    expect(task.items[0].status).toBe('success');
    expect(mockUpdatePersistentItem).not.toHaveBeenCalled();
    expect(mockPollTask).not.toHaveBeenCalled();
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test('rejects bad-success recovery when providerTaskId is missing', async () => {
    const recovered = {
      id: 'batch-unsafe-success-1',
      userId: 'user-1',
      title: '缺任务 ID',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      provider: 'apimart',
      status: 'done',
      outputWidth: 800,
      outputHeight: 800,
      items: [
        {
          itemId: 'item-unsafe-success-1',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          prompt: '恢复提示词',
          status: 'success',
          persistenceStatus: 'succeeded',
          providerStatus: 'SUCCEEDED',
          retryMode: 'reprocess_result',
          submitAttempt: 1,
          resultImage: { fileId: null, width: 800, height: 800 },
        },
      ],
    };
    mockPersistentTasks.set(recovered.id, recovered);

    await expect(
      recoverBatchItemResult(recovered.id, 'item-unsafe-success-1', 'user-1'),
    ).rejects.toMatchObject({ code: 'recovery_missing_provider_task_id' });
    expect(mockPollTask).not.toHaveBeenCalled();
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test('recovers a hydrated succeeded item whose runtime retryMode was normalized away', async () => {
    const recovered = {
      id: 'batch-hydrated-success-1',
      userId: 'user-1',
      title: '水合恢复',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      provider: 'apimart',
      status: 'done',
      outputWidth: 800,
      outputHeight: 800,
      items: [
        {
          itemId: 'item-hydrated-success-1',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          prompt: '恢复提示词',
          status: 'success',
          persistenceStatus: 'succeeded',
          providerTaskId: 'task-hydrated-success-1',
          providerStatus: 'SUCCEEDED',
          /** 真实水合形态：terminal 记录的运行时 retryMode 被归一化为 undefined */
          retryMode: undefined,
          persistedRetryMode: 'reprocess_result',
          retryCount: 0,
          submitAttempt: 1,
          resultImage: { fileId: null, filename: 'old.png', width: 800, height: 800 },
        },
      ],
    };
    mockPersistentTasks.set(recovered.id, recovered);
    mockPersistentRecords.set(`${recovered.id}:item-hydrated-success-1`, {
      ...recovered.items[0],
      status: 'succeeded',
      retryMode: 'reprocess_result',
    });
    mockPollTask.mockResolvedValueOnce({
      resultUrl: 'https://temporary-result-cdn.example/hydrated.png?signature=secret',
      status: 'success',
    });
    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: Buffer.from(square1024.split(',')[1], 'base64'),
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    batchTaskStore.clear();

    const task = await recoverBatchItemResult(recovered.id, 'item-hydrated-success-1', 'user-1');
    await waitForBatchItem(task);

    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(mockPollTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-hydrated-success-1' }),
    );
    expect(task.items[0]).toMatchObject({
      status: 'success',
      providerTaskId: 'task-hydrated-success-1',
      submitAttempt: 1,
    });
    expect(task.items[0].resultImage.fileId).toBe('file-normalized-result');

    /** 关键：断言“落库”的 resultImage.fileId 非空（此前只断言内存态，漏掉了双重映射坏成功态） */
    const persisted = mockPersistentRecords.get('batch-hydrated-success-1:item-hydrated-success-1');
    expect(persisted.status).toBe('succeeded');
    expect(persisted.resultImage.fileId).toBe('file-normalized-result');
    expect(persisted.submitAttempt).toBe(1);
  });

  test('recovers legacy succeeded item missing persisted retryMode via strict derivation', async () => {
    const recovered = {
      id: 'batch-legacy-success-1',
      userId: 'user-1',
      title: '旧数据恢复',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      provider: 'apimart',
      status: 'done',
      outputWidth: 800,
      outputHeight: 800,
      items: [
        {
          itemId: 'item-legacy-success-1',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          prompt: '恢复提示词',
          status: 'success',
          persistenceStatus: 'succeeded',
          providerTaskId: 'task-legacy-success-1',
          providerStatus: 'SUCCEEDED',
          retryMode: undefined,
          persistedRetryMode: undefined,
          retryCount: 0,
          submitAttempt: 1,
          resultImage: { fileId: null, width: 800, height: 800 },
        },
      ],
    };
    mockPersistentTasks.set(recovered.id, recovered);
    mockPersistentRecords.set(`${recovered.id}:item-legacy-success-1`, {
      ...recovered.items[0],
      status: 'succeeded',
    });
    mockPollTask.mockResolvedValueOnce({
      resultUrl: 'https://temporary-result-cdn.example/legacy.png?signature=secret',
      status: 'success',
    });
    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: Buffer.from(square1024.split(',')[1], 'base64'),
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    batchTaskStore.clear();

    const task = await recoverBatchItemResult(recovered.id, 'item-legacy-success-1', 'user-1');
    await waitForBatchItem(task);

    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
    expect(task.items[0].resultImage.fileId).toBe('file-normalized-result');
    expect(task.items[0].submitAttempt).toBe(1);
  });

  test('rejects recovery with precise errorKind for unknown providerStatus and explicit non-reprocess retryMode', async () => {
    const baseItem = {
      templateId: 'white_box_1',
      templateName: '白底盒装',
      prompt: '恢复提示词',
      status: 'success',
      persistenceStatus: 'succeeded',
      providerTaskId: 'task-kind-1',
      retryCount: 0,
      submitAttempt: 1,
      resultImage: { fileId: null, width: 800, height: 800 },
    };

    const badProviderStatus = {
      id: 'batch-kind-provider-1',
      userId: 'user-1',
      title: '未知供应商状态',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      provider: 'apimart',
      status: 'done',
      outputWidth: 800,
      outputHeight: 800,
      items: [
        {
          ...baseItem,
          itemId: 'item-kind-provider-1',
          providerStatus: 'COMPLETED',
          persistedRetryMode: 'reprocess_result',
        },
      ],
    };
    mockPersistentTasks.set(badProviderStatus.id, badProviderStatus);
    await expect(
      recoverBatchItemResult(badProviderStatus.id, 'item-kind-provider-1', 'user-1'),
    ).rejects.toMatchObject({ code: 'recovery_provider_status_mismatch', statusCode: 409 });

    const badRetryMode = {
      id: 'batch-kind-retry-1',
      userId: 'user-1',
      title: '显式非重处理模式',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      provider: 'apimart',
      status: 'done',
      outputWidth: 800,
      outputHeight: 800,
      items: [
        {
          ...baseItem,
          itemId: 'item-kind-retry-1',
          providerStatus: 'SUCCEEDED',
          persistedRetryMode: 'resume_polling',
        },
      ],
    };
    mockPersistentTasks.set(badRetryMode.id, badRetryMode);
    await expect(
      recoverBatchItemResult(badRetryMode.id, 'item-kind-retry-1', 'user-1'),
    ).rejects.toMatchObject({ code: 'recovery_retry_mode_mismatch', statusCode: 409 });

    expect(mockPollTask).not.toHaveBeenCalled();
    expect(mockGenerateAPIMartImage).not.toHaveBeenCalled();
  });

  test('returns the active cache runner when polling reloads the same task from Mongo', async () => {
    const recovered = {
      id: 'batch-active-runner-1',
      userId: 'user-1',
      title: '活跃任务',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      provider: 'apimart',
      status: 'pending',
      outputWidth: 800,
      outputHeight: 800,
      items: [
        {
          itemId: 'item-active-runner-1',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          prompt: '恢复提示词',
          status: 'pending',
          persistenceStatus: 'processing',
          providerTaskId: 'task-original-active-1',
          providerStatus: 'IN_PROGRESS',
          retryMode: 'resume_polling',
          retryCount: 1,
          submitAttempt: 1,
        },
      ],
    };
    mockPersistentTasks.set(recovered.id, recovered);
    mockPersistentRecords.set(`${recovered.id}:item-active-runner-1`, {
      ...recovered.items[0],
      status: 'processing',
    });
    mockLoadPersistentBatchTask.mockImplementation(async (batchId) => {
      const persisted = mockPersistentTasks.get(batchId);
      return persisted ? structuredClone(persisted) : null;
    });
    const activeTask = structuredClone(recovered);
    activeTask.runnerActive = true;
    batchTaskStore.set(recovered.id, activeTask);

    const loadedTask = await getBatchTask(recovered.id, 'user-1');

    expect(loadedTask).toBe(activeTask);
    expect(batchTaskStore.get(recovered.id)).toBe(activeTask);
  });

  test('never serializes the internal signed provider result URL', () => {
    const serialized = serializeBatchTask({
      id: 'batch-safe-dto',
      title: '安全 DTO',
      mode: 't2i',
      provider: 'apimart',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      status: 'failed',
      items: [
        {
          itemId: 'item-safe',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          status: 'failed',
          provider: 'apimart',
          model: 'gpt-image-2',
          modelKey: 'apimart_gpt_image_2_text',
          submitAttempt: 1,
          errorKind: 'provider_submit_unknown',
          providerResult: {
            image: { url: 'https://cdn.example/image.png?signature=must-not-leak' },
          },
          retryCount: 0,
        },
      ],
    });

    expect(JSON.stringify(serialized)).not.toContain('signature=must-not-leak');
    expect(serialized).toMatchObject({
      provider: 'apimart',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'gpt-image-2',
      items: [
        {
          provider: 'apimart',
          model: 'gpt-image-2',
          modelKey: 'apimart_gpt_image_2_text',
          submitAttempt: 1,
          errorKind: 'provider_submit_unknown',
        },
      ],
    });
    expect(serialized.items[0]).not.toHaveProperty('providerResult');
  });

  test('serializes only stable batch result metadata, never a result URL', () => {
    const serialized = serializeBatchTask({
      id: 'batch-stable-result',
      title: '安全 DTO',
      mode: 't2i',
      model: 'gpt-image-2',
      status: 'done',
      items: [
        {
          itemId: 'item-stable-result',
          templateId: 'white_box_1',
          templateName: '白底盒装',
          status: 'success',
          resultImage: {
            fileId: 'file-stable-result',
            url: '/api/batch/image-generation/batch-stable-result/items/item-stable-result/file',
            proxiedUrl: '/api/batch/image-generation/old-proxy-token',
            downloadUrl:
              '/api/batch/image-generation/batch-stable-result/items/item-stable-result/file?download=1',
          },
          retryCount: 0,
        },
      ],
    });

    expect(serialized.items[0].resultImage).toEqual({ fileId: 'file-stable-result' });
    expect(JSON.stringify(serialized)).not.toContain('old-proxy-token');
  });

  test('a new paid retry cannot overwrite an undelivered previous attempt', async () => {
    mockShouldUseAPIMartImg2AsyncForUser.mockReturnValue(false);
    mockGenerateAPIMartImage.mockRejectedValueOnce(
      Object.assign(new Error('failed'), {
        code: 'APIMART_PROVIDER_FAILED',
        providerStatus: 'FAILED',
      }),
    );
    mockGetPromptTemplateForBatch.mockResolvedValue({ prompt: 'Product {{title}}' });
    const task = await createBatchTask({
      userId: 'user-1',
      title: '测试',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);
    const item = task.items[0];
    item.usageContext = { eventId: 'old-attempt', reservationId: 'old-attempt' };
    item.usageDelivery = {
      revision: 1,
      state: 'pending',
      envelope: { event: { usageEventId: 'old-attempt' } },
    };
    Object.assign(mockPersistentRecords.get(`${task.id}:${item.itemId}`), {
      usageContext: item.usageContext,
      usageDelivery: item.usageDelivery,
    });
    mockRecordImageUsage.mockResolvedValue({ durableAccepted: false, ledgerPersisted: false });
    await expect(retryBatchItem(task.id, 'white_box_1', 'user-1')).rejects.toMatchObject({
      code: 'USAGE_CAPTURE_UNAVAILABLE',
    });
    expect(mockPersistentRecords.get(`${task.id}:${item.itemId}`).usageContext.eventId).toBe(
      'old-attempt',
    );
    expect(mockGenerateAPIMartImage).toHaveBeenCalledTimes(1);
  });

  test('resubmits only after the provider itself failed', async () => {
    const providerFailure = new Error('provider failed');
    providerFailure.code = 'APIMART_PROVIDER_FAILED';
    providerFailure.providerStatus = 'FAILED';
    mockGenerateAPIMartImage.mockRejectedValueOnce(providerFailure);
    mockGetPromptTemplateForBatch.mockResolvedValue({
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      prompt: '默认全局提示词：标题 {{title}}。',
    });

    const task = await createBatchTask({
      userId: 'user-1',
      title: '红枣核桃糕',
      mode: 't2i',
      modelKey: 'apimart_gpt_image_2_text',
      templateIds: ['white_box_1'],
    });
    await waitForBatchItem(task);
    expect(task.items[0].retryMode).toBe('resubmit_provider');

    mockGenerateAPIMartImage.mockResolvedValueOnce({
      data: [{ b64_json: square1024, width: 1024, height: 1024 }],
      taskId: 'task-paid-2',
    });
    await retryBatchItem(task.id, 'white_box_1', 'user-1');
    await waitForBatchItem(task);

    expect(task.items[0].status).toBe('success');
    expect(mockGenerateAPIMartImage).toHaveBeenCalledTimes(2);
  });

  test.each([
    [
      'RESULT_URL_REJECTED',
      'result_url_rejected',
      '生成结果地址未通过安全校验，请重试或联系管理员。',
    ],
    ['RESULT_DOWNLOAD_FAILED', 'result_download_failed', '生成已完成，但图片下载失败，请重试。'],
    ['INVALID_RESULT_IMAGE', 'invalid_image', '生成结果不是有效图片，请重试。'],
    ['IMAGE_OUTPUT_NORMALIZE_FAILED', 'normalization_failed', '图片尺寸处理失败，请重试。'],
  ])('maps %s to an operator-safe result error', (code, errorKind, message) => {
    const error = new Error('technical details');
    error.code = code;
    error.errorKind = errorKind;

    expect(getBatchResultError(error)).toEqual({ errorKind, message });
  });

  test('maps aborted provider result processing to a safe reprocessable result error', () => {
    const error = new Error('This operation was aborted');

    expect(getBatchResultError(error)).toEqual({
      errorKind: 'result_download_failed',
      message: '生成已完成，但图片下载失败，请重试。',
    });
  });
});
