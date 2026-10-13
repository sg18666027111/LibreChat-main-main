jest.mock('./common', () => ({
  getFalConfig: jest.fn(() => ({ apiKey: 'test-key' })),
  getFalTimeoutMs: () => 300000,
  getFalPollIntervalMs: () => 3000,
  submitFalQueueTask: jest.fn(),
  readFalQueueStatus: jest.fn(),
  readFalQueueResult: jest.fn(),
}));
jest.mock('@librechat/api', () => ({ uploadFalImages: jest.fn() }));
const common = require('./common');
const { createFalImageEgressAdapter } = require('./imageEgressFalAdapter');
const { resolveSingleImageOutputQuality } = require('../../outputQuality');
const { waitForFlareBatchResult } = require('./flareBatch');

beforeEach(() => jest.clearAllMocks());

test('a lost batch lease stops its waiter without changing the conflict code', async () => {
  common.readFalQueueStatus.mockResolvedValue({ state: 'pending', providerStatus: 'IN_PROGRESS' });
  const error = Object.assign(new Error('lease lost'), { code: 'BATCH_TASK_STATE_CONFLICT' });
  await expect(
    waitForFlareBatchResult({
      model: 'openai/gpt-image-2.5/flare/text-to-image',
      providerTaskId: 'paid',
      onProviderPoll: async () => {
        throw error;
      },
    }),
  ).rejects.toMatchObject({ code: 'BATCH_TASK_STATE_CONFLICT' });
  expect(common.readFalQueueResult).not.toHaveBeenCalled();
});

test('batch status reads receive a deadline signal so stalled reads can be interrupted', async () => {
  common.readFalQueueStatus.mockRejectedValue(new Error('network read failed'));
  await expect(
    waitForFlareBatchResult({
      model: 'openai/gpt-image-2.5/flare/text-to-image',
      providerTaskId: 'paid',
    }),
  ).rejects.toMatchObject({ code: 'FAL_BATCH_WAIT_INTERRUPTED' });
  expect(common.readFalQueueStatus.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
});

test.each(['text-to-image', 'edit'])(
  'Flare %s submits one PNG at medium quality',
  async (endpoint) => {
    const model = `openai/gpt-image-2.5/flare/${endpoint}`;
    const adapter = createFalImageEgressAdapter({ model });
    await adapter.submit({
      request: {
        prompt: 'product box',
        count: 1,
        size: '1536x864',
        imageInputs: ['https://v3.fal.media/product.png'],
        outputQuality: 'ultra',
      },
    });
    expect(common.submitFalQueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        model,
        payload: {
          prompt: 'product box',
          num_images: 1,
          quality: 'medium',
          output_format: 'png',
          image_size: { width: 1536, height: 864 },
          ...(endpoint === 'edit' ? { image_urls: ['https://v3.fal.media/product.png'] } : {}),
        },
      }),
    );
  },
);

test.each(['text-to-image', 'edit'])(
  'Flare %s rejects multiple outputs before submit',
  async (endpoint) => {
    const adapter = createFalImageEgressAdapter({
      model: `openai/gpt-image-2.5/flare/${endpoint}`,
    });
    await expect(
      adapter.submit({
        request: { prompt: 'box', count: 2, imageInputs: ['https://v3.fal.media/a.png'] },
      }),
    ).rejects.toMatchObject({
      code: 'IMAGE_MODEL_COUNT_UNSUPPORTED',
      submitOutcome: 'definitely_not_submitted',
    });
    expect(common.submitFalQueueTask).not.toHaveBeenCalled();
  },
);

test('Flare edit validates references and uploads large inputs before submitting', async () => {
  const adapter = createFalImageEgressAdapter({ model: 'openai/gpt-image-2.5/flare/edit' });
  await expect(adapter.submit({ request: { prompt: 'box' } })).rejects.toMatchObject({
    code: 'FAL_BAD_REQUEST',
  });
  await expect(
    adapter.submit({
      request: { prompt: 'box', imageInputs: Array(17).fill('https://v3.fal.media/a.png') },
    }),
  ).rejects.toMatchObject({ code: 'FAL_BAD_REQUEST' });
  require('@librechat/api').uploadFalImages.mockResolvedValue(['https://v3.fal.media/upload.png']);
  const prepared = await adapter.prepare({
    request: { prompt: 'box', imageInputs: ['data:image/png;base64,' + 'A'.repeat(40000)] },
  });
  expect(prepared.imageInputs).toEqual(['https://v3.fal.media/upload.png']);
  expect(common.submitFalQueueTask).not.toHaveBeenCalled();
});

test.each(['text-to-image', 'edit'])(
  'all Flare %s output sizes satisfy provider constraints',
  (endpoint) => {
    for (const outputQuality of ['standard', 'hd', 'ultra']) {
      for (const aspectRatio of ['1:1', '3:4', '4:5', '16:9', '9:16']) {
        const { width, height, downgraded } = resolveSingleImageOutputQuality({
          provider: 'fal',
          model: `openai/gpt-image-2.5/flare/${endpoint}`,
          outputQuality,
          aspectRatio,
        });
        expect(downgraded).toBe(false);
        expect(width % 16).toBe(0);
        expect(height % 16).toBe(0);
        expect(width * height).toBeGreaterThanOrEqual(655360);
        expect(width * height).toBeLessThanOrEqual(8294400);
      }
    }
  },
);
