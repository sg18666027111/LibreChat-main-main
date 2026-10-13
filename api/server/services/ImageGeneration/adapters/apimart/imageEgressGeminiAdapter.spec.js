jest.mock('./common', () => ({
  readAPIMartTaskStatus: jest.fn(),
  submitImageTask: jest.fn(),
}));

const common = require('./common');
const { createAPIMartGeminiImageEgressAdapter } = require('./imageEgressGeminiAdapter');

describe('APIMart Gemini image-egress adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['gemini-3.1-flash-image-preview', expect.objectContaining({ resolution: '1K' })],
    ['gemini-2.5-flash-image-preview', expect.not.objectContaining({ resolution: '1K' })],
  ])('submits %s once through its existing payload builder', async (model, payloadShape) => {
    common.submitImageTask.mockResolvedValue({
      taskId: 'gemini-task-1',
      resultUrl: null,
      responseKeys: ['task_id'],
    });
    const adapter = createAPIMartGeminiImageEgressAdapter({ model });

    await expect(
      adapter.submit({
        request: {
          prompt: 'edit',
          imageInputs: ['data:image/png;base64,AAAA'],
          aspectRatio: '1:1',
          taskType: 'multi-reference',
          modelKey: 'gemini-key',
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ providerTaskId: 'gemini-task-1', outputUrls: [] }),
    );
    expect(common.submitImageTask).toHaveBeenCalledTimes(1);
    expect(common.submitImageTask.mock.calls[0][0]).toEqual(
      expect.objectContaining({ model, prompt: 'edit', image_urls: expect.any(Array) }),
    );
    expect(common.submitImageTask.mock.calls[0][0]).toEqual(payloadShape);
  });

  it('reads status once with the same durable task identity', async () => {
    common.readAPIMartTaskStatus.mockResolvedValue({
      state: 'succeeded',
      providerStatus: 'SUCCEEDED',
      outputUrls: ['https://cdn.example/output.png'],
    });
    const adapter = createAPIMartGeminiImageEgressAdapter({
      model: 'gemini-3.1-flash-image-preview',
    });
    await expect(adapter.status({ providerTaskId: 'gemini-task-1' })).resolves.toEqual(
      expect.objectContaining({ state: 'succeeded' }),
    );
    expect(common.readAPIMartTaskStatus).toHaveBeenCalledWith({
      taskId: 'gemini-task-1',
      signal: undefined,
    });
  });

  it('classifies transport loss as ambiguous without a second submit', async () => {
    common.submitImageTask.mockRejectedValue(new TypeError('fetch failed'));
    const adapter = createAPIMartGeminiImageEgressAdapter({
      model: 'gemini-2.5-flash-image-preview',
    });
    await expect(adapter.submit({ request: { prompt: 'edit' } })).rejects.toMatchObject({
      code: 'APIMART_SUBMIT_TRANSPORT_ERROR',
      submitOutcome: 'unknown',
    });
    expect(common.submitImageTask).toHaveBeenCalledTimes(1);
  });

  it('preserves explicit Provider rejection classification', async () => {
    common.submitImageTask.mockRejectedValue(
      Object.assign(new Error('bad request'), { statusCode: 400, providerResponseParsed: true }),
    );
    const adapter = createAPIMartGeminiImageEgressAdapter({
      model: 'gemini-3.1-flash-image-preview',
    });
    await expect(adapter.submit({ request: { prompt: 'edit' } })).rejects.toMatchObject({
      statusCode: 400,
      submitOutcome: 'rejected',
    });
    expect(common.submitImageTask).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503, 504])(
    'fails closed when submit receives a parsed transient HTTP %s response',
    async (statusCode) => {
      common.submitImageTask.mockRejectedValue(
        Object.assign(new Error('temporary upstream failure'), {
          statusCode,
          providerResponseParsed: true,
        }),
      );
      const adapter = createAPIMartGeminiImageEgressAdapter({
        model: 'gemini-3.1-flash-image-preview',
      });

      await expect(adapter.submit({ request: { prompt: 'edit' } })).rejects.toMatchObject({
        statusCode,
        submitOutcome: 'unknown',
      });
      expect(common.submitImageTask).toHaveBeenCalledTimes(1);
    },
  );
});
