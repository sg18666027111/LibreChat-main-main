const { generateChatCompletion } = require('./siliconflow');

const originalFetch = global.fetch;
const originalKey = process.env.SILICONFLOW_API_KEY;

describe('SiliconFlow assistant transport', () => {
  beforeEach(() => {
    process.env.SILICONFLOW_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: { content: 'final answer', reasoning_content: 'private reasoning' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 15, completion_tokens: 20 },
        }),
    });
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SILICONFLOW_API_KEY;
    else process.env.SILICONFLOW_API_KEY = originalKey;
  });

  it('sends GLM low reasoning with the existing key and returns only the final answer', async () => {
    const result = await generateChatCompletion({
      model: 'zai-org/GLM-5.3',
      messages: [{ role: 'user', content: 'synthetic task' }],
      requestId: 'test',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.siliconflow.cn/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      }),
    );
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
      model: 'zai-org/GLM-5.3',
      messages: [{ role: 'user', content: 'synthetic task' }],
      max_tokens: 2400,
      stream: false,
      reasoning_effort: 'low',
    });
    expect(result).toEqual({
      text: 'final answer',
      usage: { prompt_tokens: 15, completion_tokens: 20 },
    });
  });

  it('keeps other models request parameters unchanged', async () => {
    await generateChatCompletion({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 1024,
    });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
      stream: false,
    });
  });

  it('does not present reasoning-only responses as a successful final answer', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: { content: '', reasoning_content: 'unfinished reasoning' },
              finish_reason: 'length',
            },
          ],
          usage: { completion_tokens: 2400 },
        }),
    });
    await expect(
      generateChatCompletion({
        model: 'zai-org/GLM-5.3',
        messages: [{ role: 'user', content: 'task' }],
      }),
    ).rejects.toMatchObject({
      code: 'LLM_ASSISTANT_EMPTY_RESPONSE',
      providerSubmitted: true,
      providerUsage: { completion_tokens: 2400 },
    });
  });

  describe('request lifecycle', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('aborts a stalled response body within the original request timeout', async () => {
      let signal;
      global.fetch.mockImplementation(async (_url, options) => {
        signal = options.signal;
        // Headers use part of the same deadline as body consumption.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return {
          ok: true,
          text: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        };
      });
      let outcome;
      const completion = generateChatCompletion({ model: 'test', messages: [] }).catch((error) => {
        outcome = error;
      });

      await jest.advanceTimersByTimeAsync(119999);
      expect(signal.aborted).toBe(false);
      expect(outcome).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);

      expect(signal.aborted).toBe(true);
      expect(outcome).toMatchObject({
        statusCode: 504,
        code: 'LLM_ASSISTANT_TIMEOUT',
        providerSubmitted: true,
      });
      await completion;
      expect(jest.getTimerCount()).toBe(0);
    });

    it('marks a body read failure as submitted while preserving the original error', async () => {
      const bodyError = new Error('response connection closed');
      bodyError.code = 'ECONNRESET';
      global.fetch.mockResolvedValue({
        ok: true,
        text: async () => {
          throw bodyError;
        },
      });

      const error = await generateChatCompletion({ model: 'test', messages: [] }).catch(
        (failure) => failure,
      );

      expect(error).toBe(bodyError);
      expect(error).toMatchObject({ code: 'ECONNRESET', providerSubmitted: true });
      expect(jest.getTimerCount()).toBe(0);
    });

    it('cleans up the deadline after a successful response', async () => {
      await expect(generateChatCompletion({ model: 'test', messages: [] })).resolves.toEqual({
        text: 'final answer',
        usage: { prompt_tokens: 15, completion_tokens: 20 },
      });

      await jest.advanceTimersByTimeAsync(120000);
      expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
