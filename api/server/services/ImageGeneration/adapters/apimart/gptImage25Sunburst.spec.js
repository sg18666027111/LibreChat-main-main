const { getAdapter, generateAPIMartImage, resumeAPIMartImage } = require('./index');
const { getSafeAPIMartError, getModelTimeoutMs } = require('./common');

describe('Sunburst APIMart editing lifecycle', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.APIMART_API_KEY;
  const model = 'gpt-image-2.5-sunburst';
  const modelKey = 'apimart_gpt_image_2_5_sunburst';
  const complete = {
    code: 200,
    data: {
      id: 'sunburst-task',
      status: 'completed',
      cost: 0.017666,
      credits_cost: 0.17666,
      result: { images: [{ url: ['https://example.test/sunburst.png'] }] },
    },
  };

  beforeEach(() => {
    process.env.APIMART_API_KEY = 'test-key';
  });
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.APIMART_API_KEY;
    else process.env.APIMART_API_KEY = originalKey;
  });

  test('uploads references, persists the accepted ID before polling, and returns cost', async () => {
    const events = [];
    global.fetch = async (url, options) => {
      if (url.endsWith('/uploads/images')) {
        expect(await options.body.get('file').text()).toBe('reference');
        events.push('upload');
        return Response.json({ url: 'https://example.test/reference.png' });
      }
      if (url.endsWith('/images/generations')) {
        expect(events).toEqual(['upload']);
        expect(JSON.parse(options.body)).toEqual({
          model: 'gpt-image-2.5-sunburst',
          prompt: 'Edit cup',
          n: 1,
          size: '1024x1024',
          quality: 'medium',
          image_urls: ['https://example.test/reference.png'],
        });
        events.push('submit');
        return Response.json({
          code: 200,
          data: [{ status: 'submitted', task_id: 'sunburst-task' }],
        });
      }
      expect(url).toBe('https://api.apimart.ai/v1/tasks/sunburst-task');
      expect(events).toEqual(['upload', 'submit', 'persist']);
      events.push('poll');
      return Response.json(complete);
    };
    const result = await generateAPIMartImage({
      model,
      modelKey,
      taskType: 'single-image-edit',
      prompt: 'Edit cup',
      imageInputs: [`data:image/png;base64,${Buffer.from('reference').toString('base64')}`],
      onProviderTaskSubmitted: async ({ providerTaskId }) => {
        expect(providerTaskId).toBe('sunburst-task');
        events.push('persist');
      },
    });
    expect(result).toMatchObject({
      model,
      provider: 'apimart',
      taskId: 'sunburst-task',
      resultUrl: 'https://example.test/sunburst.png',
      cost: 0.017666,
    });
    expect(events).toEqual(['upload', 'submit', 'persist', 'poll']);
  });

  test('resumes the stored task with GET only, without upload or another paid submission', async () => {
    const requests = [];
    global.fetch = async (url, options) => {
      requests.push([url, options.method]);
      return Response.json(complete);
    };
    const result = await resumeAPIMartImage({
      model,
      modelKey,
      providerTaskId: 'sunburst-task',
      taskType: 'multi-reference',
    });
    expect(result).toMatchObject({
      model,
      taskId: 'sunburst-task',
      resultUrl: 'https://example.test/sunburst.png',
    });
    expect(requests).toEqual([['https://api.apimart.ai/v1/tasks/sunburst-task', 'GET']]);
  });

  test.each(['1600x900', '3840x3840', '256x256', '4096x1024'])(
    'rejects invalid size %s before uploads or charges',
    async (size) => {
      const requests = [];
      global.fetch = async (url) => {
        requests.push(url);
        return Response.json(complete);
      };
      await expect(
        generateAPIMartImage({
          model,
          prompt: 'Edit',
          size,
          imageInputs: ['https://example.test/ref.png'],
        }),
      ).rejects.toMatchObject({ code: 'APIMART_IMAGE_INVALID_SIZE', submittedToProvider: false });
      expect(requests).toEqual([]);
    },
  );

  test('preserves the original task identity after a provider failure', async () => {
    jest.useFakeTimers();
    global.fetch = async (url) =>
      Response.json(
        url.endsWith('/images/generations')
          ? { code: 200, data: [{ task_id: 'sunburst-task', status: 'submitted' }] }
          : { code: 200, data: { status: 'failed', error: 'Cannot edit image' } },
      );
    const pending = generateAPIMartImage({ model, prompt: 'Edit' }).catch((error) => error);
    await jest.advanceTimersByTimeAsync(300001);
    expect(await pending).toMatchObject({ providerTaskId: 'sunburst-task' });
  });

  test('retains both old and new adapters and gives Sunburst the full polling budget', () => {
    expect(getAdapter('gpt-image-2').buildPayload({ prompt: 'Edit' })).toMatchObject({
      model: 'gpt-image-2',
      official_fallback: false,
    });
    expect(getModelTimeoutMs(model)).toBe(300000);
    expect(getModelTimeoutMs(model, 'multi-reference')).toBe(600000);
    const error = Object.assign(new Error('submit timeout'), {
      code: 'APIMART_IMAGE_SUBMIT_TIMEOUT',
    });
    expect(getSafeAPIMartError(error, { model }).safeMessage).toContain('无法确认');
  });
});
