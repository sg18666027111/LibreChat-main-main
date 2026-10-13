const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

const { MODEL, generateImage } = require('./seedream');

function getLastPayload() {
  const body = global.fetch.mock.calls.at(-1)?.[1]?.body;
  return JSON.parse(body);
}

describe('Seedream 5.0 Pro Ark adapter request parameters', () => {
  const originalApiKey = process.env.ARK_API_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.ARK_API_KEY = 'test-ark-key';
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name) => (name === 'x-request-id' ? 'ark-request-123' : null),
      },
      text: async () =>
        JSON.stringify({
          data: [{ url: 'https://example.com/generated.png', width: 1024, height: 1024 }],
        }),
    }));
  });

  afterAll(() => {
    process.env.ARK_API_KEY = originalApiKey;
    global.fetch = originalFetch;
  });

  test('uses the Seedream 5.0 Pro model id and url response format', async () => {
    await generateImage({
      prompt: '生成一张商品主图',
      taskType: 'text-to-image',
      aspectRatio: '1:1',
      count: 1,
    });

    const payload = getLastPayload();
    expect(payload.model).toBe(MODEL);
    expect(payload.model).toBe('doubao-seedream-5-0-pro-260628');
    expect(payload.response_format).toBe('url');
    expect(payload).not.toHaveProperty('output_format');
  });

  test('keeps batch main image requests at 1024x1024 instead of 2048x2048', async () => {
    await generateImage({
      prompt: '批量包装主图',
      taskType: 'text-to-image',
      aspectRatio: '1:1',
      size: '2048x2048',
      imageSize: '2048x2048',
      outputQuality: 'ultra',
      isBatchMainImage: true,
      count: 1,
    });

    expect(getLastPayload().size).toBe('1024x1024');
  });

  test('uses explicit higher dimensions for single-image output quality', async () => {
    await generateImage({
      prompt: '生成一张高清商品主图',
      taskType: 'text-to-image',
      aspectRatio: '1:1',
      size: '2048x2048',
      imageSize: '2048x2048',
      width: 2048,
      height: 2048,
      outputQuality: 'ultra',
      count: 1,
    });

    expect(getLastPayload().size).toBe('2048x2048');
  });

  test.each([
    ['1:1', '1024x1024'],
    ['3:4', '960x1280'],
    ['4:5', '1024x1280'],
    ['16:9', '1280x720'],
    ['9:16', '720x1280'],
  ])('maps %s to a speed-oriented Pro-safe size', async (aspectRatio, expectedSize) => {
    await generateImage({
      prompt: '生成一张营销图',
      taskType: 'text-to-image',
      aspectRatio,
      count: 1,
    });

    expect(getLastPayload().size).toBe(expectedSize);
  });

  test('maps legacy low-pixel 4:5 requests to a Pro-safe size', async () => {
    await generateImage({
      prompt: '生成一张信息流图',
      taskType: 'text-to-image',
      size: '832x1040',
      count: 1,
    });

    expect(getLastPayload().size).toBe('1024x1280');
  });

  test('logs request diagnostics without full prompt or image payloads', async () => {
    const fullPrompt = '完整提示词不应该进入日志';
    await generateImage({
      prompt: fullPrompt,
      taskType: 'single-image-edit',
      imageInputs: ['data:image/png;base64,AAAA'],
      aspectRatio: '1:1',
      count: 1,
    });

    const serializedLogs = JSON.stringify(mockLogger.info.mock.calls);
    expect(serializedLogs).toContain('"promptLength"');
    expect(serializedLogs).toContain('"inputImageCount":1');
    expect(serializedLogs).toContain('"outputCount":1');
    expect(serializedLogs).toContain('"elapsedMs"');
    expect(serializedLogs).toContain('ark-request-123');
    expect(serializedLogs).not.toContain(fullPrompt);
    expect(serializedLogs).not.toContain('data:image/png;base64,AAAA');
    expect(serializedLogs).not.toContain('test-ark-key');
  });
});
