jest.mock('@librechat/api', () => ({ uploadFalImages: jest.fn() }));
jest.mock('./common', () => ({
  getFalConfig: jest.fn(() => ({ apiKey: 'test-key' })),
  pollFalResult: jest.fn(),
  submitFalTask: jest.fn(),
  submitFalQueueTask: jest.fn(),
  readFalQueueStatus: jest.fn(),
  readFalQueueResult: jest.fn(),
}));

const common = require('./common');
const { createFalImageEgressAdapter } = require('./imageEgressFalAdapter');

describe('Fal image-egress adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uploads large edit inputs during preparation without submitting generation', async () => {
    const { uploadFalImages } = require('@librechat/api');
    uploadFalImages.mockResolvedValue(['https://v3b.fal.media/files/a.png']);
    const adapter = createFalImageEgressAdapter({ model: 'openai/gpt-image-2/edit' });
    const request = { prompt: 'edit', imageInputs: ['data:image/png;base64,' + 'A'.repeat(40000)] };
    const prepared = await adapter.prepare({ request, signal: new AbortController().signal });
    expect(prepared.imageInputs).toEqual(['https://v3b.fal.media/files/a.png']);
    expect(prepared.prompt).toBe(request.prompt);
    expect(request.imageInputs[0]).toContain('data:');
    expect(common.submitFalQueueTask).not.toHaveBeenCalled();
    await adapter.submit({ request: prepared });
    expect(common.submitFalQueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ image_urls: prepared.imageInputs }),
      }),
    );
  });

  it.each([
    [
      'openai/gpt-image-2',
      { prompt: 'text image', size: '1280x1280', outputQuality: 'hd', count: 1 },
      expect.objectContaining({
        prompt: 'text image',
        image_size: { width: 1280, height: 1280 },
        quality: 'medium',
        num_images: 1,
        output_format: 'png',
      }),
    ],
    [
      'openai/gpt-image-2/edit',
      { prompt: 'edit', imageInputs: ['data:image/png;base64,AAAA'], size: '1024x1024' },
      expect.objectContaining({ prompt: 'edit', image_urls: expect.any(Array) }),
    ],
    [
      'xai/grok-imagine-image/edit',
      { prompt: 'grok', imageInputs: ['data:image/png;base64,AAAA'], aspectRatio: '1:1' },
      expect.objectContaining({ prompt: 'grok', image_urls: expect.any(Array), num_images: 1 }),
    ],
    [
      'fal-ai/nano-banana-pro',
      { prompt: 'new', count: 1, aspectRatio: '1:1' },
      expect.objectContaining({ prompt: 'new', num_images: 1 }),
    ],
  ])('uses the existing payload builder for %s', async (model, request, expectedPayload) => {
    common.submitFalQueueTask.mockResolvedValue({ providerTaskId: 'fal-request-1' });
    const adapter = createFalImageEgressAdapter({ model });

    await adapter.submit({ request });

    expect(common.submitFalQueueTask).toHaveBeenCalledTimes(1);
    expect(common.submitFalQueueTask).toHaveBeenCalledWith({
      model,
      payload: expectedPayload,
      signal: undefined,
    });
  });

  it('delegates status and result as separate one-read operations', async () => {
    common.readFalQueueStatus.mockResolvedValue({ state: 'pending' });
    common.readFalQueueResult.mockResolvedValue({ outputUrls: ['https://cdn.example/image.png'] });
    const adapter = createFalImageEgressAdapter({ model: 'openai/gpt-image-2/edit' });

    await adapter.status({
      providerTaskId: 'fal-request-1',
      providerMetadata: { statusUrl: 'https://queue.fal.run/status/1' },
    });
    await adapter.result({
      providerTaskId: 'fal-request-1',
      providerMetadata: { responseUrl: 'https://queue.fal.run/result/1' },
    });

    expect(common.readFalQueueStatus).toHaveBeenCalledTimes(1);
    expect(common.readFalQueueResult).toHaveBeenCalledTimes(1);
  });

  it('passes the optional submit diagnostic callback through to common', async () => {
    common.submitFalQueueTask.mockResolvedValue({ providerTaskId: 'fal-request-1' });
    const onDiagnostic = jest.fn();
    const adapter = createFalImageEgressAdapter({ model: 'openai/gpt-image-2/edit' });

    await adapter.submit({
      request: { prompt: 'edit', imageInputs: ['data:image/png;base64,AAAA'] },
      onDiagnostic,
    });

    expect(common.submitFalQueueTask).toHaveBeenCalledWith(
      expect.objectContaining({ onDiagnostic }),
    );
  });
});
