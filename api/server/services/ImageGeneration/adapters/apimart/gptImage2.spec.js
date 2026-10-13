const { logger } = require('@librechat/data-schemas');
const { buildPayload, generateImage } = require('./gptImage2');

describe('APIMart reference upload before paid submission', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.APIMART_API_KEY;
  const input = `data:image/png;base64,${Buffer.from('test-reference').toString('base64')}`;

  beforeEach(() => {
    process.env.APIMART_API_KEY = 'test-key';
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.APIMART_API_KEY;
    } else {
      process.env.APIMART_API_KEY = originalKey;
    }
  });

  test('uploads reference bytes before submitting a small generation request with URLs', async () => {
    const events = [];
    global.fetch = async (url, options) => {
      if (url.endsWith('/uploads/images')) {
        const file = options.body.get('file');
        expect(await file.text()).toBe('test-reference');
        events.push('uploaded');
        return new Response(JSON.stringify({ url: 'https://upload.apimart.ai/f/image/test.png' }));
      }
      expect(events).toEqual(['uploaded']);
      expect(JSON.parse(options.body).image_urls).toEqual([
        'https://upload.apimart.ai/f/image/test.png',
      ]);
      events.push('generated');
      return new Response(JSON.stringify({ url: 'https://upload.apimart.ai/f/image/output.png' }));
    };

    const result = await generateImage({ prompt: 'Edit cup', imageInputs: [input] });
    expect(result.resultUrl).toBe('https://upload.apimart.ai/f/image/output.png');
    expect(events).toEqual(['uploaded', 'generated']);
  });

  test('upload failure never creates a generation task and remains safe to retry', async () => {
    const requests = [];
    global.fetch = async (url) => {
      requests.push(url);
      return new Response('{}', { status: 503 });
    };
    await expect(generateImage({ prompt: 'Edit cup', imageInputs: [input] })).rejects.toMatchObject(
      {
        code: 'APIMART_INPUT_UPLOAD_HTTP_ERROR',
        submittedToProvider: false,
      },
    );
    expect(requests).toEqual(['https://api.apimart.ai/v1/uploads/images']);
  });

  test('a 125-second upload does not consume the 90-second generation submission budget', async () => {
    jest.useFakeTimers();
    const events = [];
    global.fetch = async (url, options) => {
      if (url.endsWith('/uploads/images')) {
        await new Promise((resolve) => setTimeout(resolve, 125000));
        events.push('uploaded');
        return new Response(JSON.stringify({ url: 'https://upload.apimart.ai/f/image/large.png' }));
      }
      expect(options.signal.aborted).toBe(false);
      events.push('generated');
      return new Response(JSON.stringify({ url: 'https://upload.apimart.ai/f/image/output.png' }));
    };
    const logs = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const pending = generateImage({
      internalTaskId: 'private-id',
      prompt: 'Edit cup',
      imageInputs: [input],
    });
    await jest.advanceTimersByTimeAsync(125000);
    await expect(pending).resolves.toHaveProperty('resultUrl');
    expect(events).toEqual(['uploaded', 'generated']);
    const timings = logs.mock.calls
      .map(([message]) => message)
      .filter((message) => message.includes(' timing '))
      .map((message) => JSON.parse(message.split(' timing ')[1]));
    expect(timings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'upload',
          durationMs: 125000,
          outcome: 'success',
          imageIndex: 0,
        }),
        expect.objectContaining({ stage: 'submit', durationMs: 0, outcome: 'success' }),
      ]),
    );
    expect(new Set(timings.map((event) => event.taskHash)).size).toBe(1);
    expect(JSON.stringify(timings)).not.toMatch(/private-id|test-key|Edit cup|https:|base64/);
    logs.mockRestore();
  });
});

describe('APIMart GPT Image 2 payload', () => {
  it('omits image_urls for text-to-image requests without reference images', () => {
    const payload = buildPayload({
      prompt: 'Create a square ecommerce packaging image.',
      imageInputs: [],
      size: '1024x1024',
    });

    expect(payload).toMatchObject({
      model: 'gpt-image-2',
      size: '1024x1024',
      resolution: '1K',
    });
    expect(payload).not.toHaveProperty('image_urls');
  });

  it('includes image_urls only when reference images are provided', () => {
    const imageInputs = ['https://example.com/reference.png'];
    const payload = buildPayload({
      prompt: 'Edit the reference image.',
      imageInputs,
    });

    expect(payload.image_urls).toEqual(imageInputs);
  });

  it('passes through the selected native resolution', () => {
    const payload = buildPayload({
      prompt: 'Create a sharper ecommerce image.',
      imageInputs: [],
      size: '2048x2048',
      resolution: '4K',
    });

    expect(payload).toMatchObject({
      size: '2048x2048',
      resolution: '4K',
    });
  });
});
