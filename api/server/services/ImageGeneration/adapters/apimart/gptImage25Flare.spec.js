const { generateAPIMartImage, resumeAPIMartImage } = require('./index');
const { getModelTimeoutMs } = require('./common');

describe('Flare text generation lifecycle', () => {
  const model = 'gpt-image-2.5-flare';
  const modelKey = 'apimart_gpt_image_2_5_flare';
  const oldFetch = global.fetch;
  const oldKey = process.env.APIMART_API_KEY;
  beforeEach(() => {
    process.env.APIMART_API_KEY = 'test-key';
  });
  afterEach(() => {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.APIMART_API_KEY;
    else process.env.APIMART_API_KEY = oldKey;
  });

  test.each([1, 2, 4])(
    'returns all %i images after persisting a single provider submission',
    async (count) => {
      const events = [];
      const urls = Array.from({ length: count }, (_, i) => `https://example.test/flare-${i}.png`);
      global.fetch = async (url, options) => {
        if (url.endsWith('/images/generations')) {
          expect(JSON.parse(options.body)).toEqual({
            model: 'gpt-image-2.5-flare',
            prompt: 'Synthetic blue box',
            n: count,
            size: '1536x864',
            quality: 'medium',
          });
          events.push('submit');
          return Response.json({
            code: 200,
            data: [{ status: 'submitted', task_id: 'flare-task' }],
          });
        }
        expect(url).toBe('https://api.apimart.ai/v1/tasks/flare-task');
        expect(options.method).toBe('GET');
        expect(events).toEqual(['submit', 'persist']);
        events.push('poll');
        return Response.json({
          code: 200,
          data: {
            status: 'completed',
            cost: 0.02,
            credits_cost: 0.2,
            result: { images: [{ url: urls }] },
          },
        });
      };
      const result = await generateAPIMartImage({
        model,
        modelKey,
        taskType: 'text-to-image',
        prompt: 'Synthetic blue box',
        size: '1536x864',
        count,
        onProviderTaskSubmitted: async ({ providerTaskId }) => {
          expect(providerTaskId).toBe('flare-task');
          events.push('persist');
        },
      });
      expect(result).toMatchObject({
        model,
        provider: 'apimart',
        taskId: 'flare-task',
        cost: 0.02,
      });
      expect(result.images.map((x) => x.url)).toEqual(urls);
      expect(events).toEqual(['submit', 'persist', 'poll']);
    },
  );

  test('retains all immediate results without a second provider request', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return Response.json({
        data: { images: [{ url: ['https://example.test/a.png', 'https://example.test/b.png'] }] },
      });
    };
    const result = await generateAPIMartImage({ model, prompt: 'Two boxes', count: 2 });
    expect(result.images.map((x) => x.url)).toEqual([
      'https://example.test/a.png',
      'https://example.test/b.png',
    ]);
    expect(calls).toBe(1);
  });

  test('resumes an existing Flare task with GET only and retains all images', async () => {
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push([url, options.method]);
      return Response.json({
        data: {
          status: 'completed',
          result: {
            images: [{ url: ['https://example.test/a.png', 'https://example.test/b.png'] }],
          },
        },
      });
    };
    const result = await resumeAPIMartImage({
      model,
      modelKey,
      taskType: 'text-to-image',
      providerTaskId: 'existing-flare',
    });
    expect(result.images).toHaveLength(2);
    expect(result.model).toBe(model);
    expect(calls).toEqual([['https://api.apimart.ai/v1/tasks/existing-flare', 'GET']]);
    expect(getModelTimeoutMs(model, 'text-to-image')).toBe(300000);
  });

  test.each(['1600x900', '256x256'])(
    'rejects unsupported pixels %s before a paid submission',
    async (size) => {
      const calls = [];
      global.fetch = async (url) => {
        calls.push(url);
        throw Error('must not submit');
      };
      await expect(generateAPIMartImage({ model, prompt: 'Box', size })).rejects.toMatchObject({
        code: 'APIMART_IMAGE_INVALID_SIZE',
        submittedToProvider: false,
      });
      expect(calls).toEqual([]);
    },
  );
});
