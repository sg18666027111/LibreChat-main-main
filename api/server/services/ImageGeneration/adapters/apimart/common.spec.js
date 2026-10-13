const {
  MAX_TASK_TIMEOUT_MS,
  getModelTimeoutMs,
  getSubmitTimeoutMs,
  getSafeAPIMartError,
  getSafeAPIMartLogContext,
  pollTask,
  readAPIMartTaskStatus,
  submitImageTask,
} = require('./common');

describe('APIMart one-shot task status', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.APIMART_API_KEY;

  beforeEach(() => {
    process.env.APIMART_API_KEY = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.APIMART_API_KEY = originalKey;
  });

  test.each(['poll', 'recovery'])(
    '%s preserves nested failure details behind a successful HTTP envelope',
    async (mode) => {
      global.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 200,
              message: 'success',
              data: {
                status: 'failed',
                error: {
                  code: 'CONTENT_REJECTED',
                  message: 'Input rejected: https://example.com/private?token=secret',
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      );

      if (mode === 'recovery') {
        await expect(readAPIMartTaskStatus({ taskId: 'test-task' })).resolves.toMatchObject({
          state: 'failed',
          errorCode: 'CONTENT_REJECTED',
          message: 'Input rejected: [url]',
        });
      } else {
        await expect(
          pollTask({ taskId: 'test-task', model: 'gpt-image-2', timeoutMs: 10, intervalMs: 1 }),
        ).rejects.toMatchObject({
          code: 'CONTENT_REJECTED',
          providerErrorCode: 'CONTENT_REJECTED',
          message: 'Input rejected: [url]',
          safeMessage: 'Input rejected: [url]',
          isTerminalProviderFailure: true,
        });
      }
      expect(global.fetch).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    [
      { code: 200, data: { error: { message: 'upstream timed out' } } },
      'APIMART_TASK_FAILED',
      'upstream timed out',
    ],
    [
      {
        code: 200,
        data: { error: { code: 'QUOTA', message: { invalid: true }, prompt: 'private-prompt' } },
      },
      'QUOTA',
      'APIMart task failed',
    ],
    [
      { code: 200, data: { error: 'upstream rejected input' } },
      'APIMART_TASK_FAILED',
      'upstream rejected input',
    ],
    [
      { code: 200, data: { code: 'MODEL_ERROR', message: 'unsupported model' } },
      'MODEL_ERROR',
      'unsupported model',
    ],
    [
      { code: 200, message: 'success', data: { error: {} } },
      'APIMART_TASK_FAILED',
      'APIMart task failed',
    ],
    [
      {
        error: {
          code: 'AUTH',
          message:
            'Rejected Bearer secret-token api_key=private-key data:image/png;base64,AAAA user@example.com',
        },
      },
      'AUTH',
      'Rejected Bearer [redacted] api_key=[redacted] [base64] [email]',
    ],
  ])('keeps failure diagnostics scalar and redacted for %j', async (body, code, message) => {
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ ...body, status: 'failed' }), { status: 200 }),
    );
    await expect(readAPIMartTaskStatus({ taskId: 'test-task' })).resolves.toMatchObject({
      state: 'failed',
      errorCode: code,
      message,
    });
  });

  test.each([
    [{ status: 'IN_PROGRESS' }, 'pending'],
    [
      { status: 'SUCCEEDED', data: { url: 'https://cdn.example/output.png?token=secret' } },
      'succeeded',
    ],
    [{ status: 'FAILED', code: 'UPSTREAM_FAILED', message: 'rejected' }, 'failed'],
  ])('normalizes one Provider GET to %s', async (body, state) => {
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const result = await readAPIMartTaskStatus({ taskId: 'gemini-task-1' });
    expect(result.state).toBe(state);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.apimart.ai/v1/tasks/gemini-task-1',
      expect.objectContaining({ method: 'GET' }),
    );
    if (state === 'succeeded') {
      expect(result.outputUrls).toEqual(['https://cdn.example/output.png?token=secret']);
    }
  });

  test('classifies one-shot status transport loss for bounded worker retry', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(readAPIMartTaskStatus({ taskId: 'gemini-task-1' })).rejects.toMatchObject({
      code: 'APIMART_STATUS_TRANSPORT_ERROR',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('APIMart common error safety', () => {
  test('does not invent provider progress when submission timed out without a task ID', () => {
    const error = new Error('APIMart image task submit timed out');
    error.code = 'APIMART_IMAGE_SUBMIT_TIMEOUT';
    const result = getSafeAPIMartError(error, { model: 'gpt-image-2' });
    expect(result.providerStatus).toBeNull();
    expect(result.safeMessage).toContain('无法确认');
    expect(result.safeMessage).not.toContain('继续检查');
  });

  test('caps configured provider timeouts below the batch task lease', () => {
    const originalSubmit = process.env.APIMART_IMAGE_SUBMIT_TIMEOUT_MS;
    const originalTask = process.env.APIMART_IMAGE_TIMEOUT_MS;
    try {
      process.env.APIMART_IMAGE_SUBMIT_TIMEOUT_MS = String(30 * 60 * 1000);
      process.env.APIMART_IMAGE_TIMEOUT_MS = String(30 * 60 * 1000);

      expect(getSubmitTimeoutMs()).toBe(MAX_TASK_TIMEOUT_MS);
      expect(getModelTimeoutMs('gpt-image-2')).toBe(MAX_TASK_TIMEOUT_MS);
    } finally {
      if (originalSubmit === undefined) {
        delete process.env.APIMART_IMAGE_SUBMIT_TIMEOUT_MS;
      } else {
        process.env.APIMART_IMAGE_SUBMIT_TIMEOUT_MS = originalSubmit;
      }
      if (originalTask === undefined) {
        delete process.env.APIMART_IMAGE_TIMEOUT_MS;
      } else {
        process.env.APIMART_IMAGE_TIMEOUT_MS = originalTask;
      }
    }
  });

  test('classifies GPT Image 2 timeout errors with an operator-safe message', () => {
    const error = new Error('Task timeout: status IN_PROGRESS for 982 seconds (limit: 900s)');
    error.code = 'IMAGE_GENERATION_TIMEOUT';
    error.timeoutMs = 900000;
    error.providerTaskId = 'task_1234567890abcdef';

    const safeError = getSafeAPIMartError(error, {
      model: 'gpt-image-2',
      provider: 'apimart',
    });

    expect(safeError.safeMessage).toBe(
      '供应商仍在处理本次任务，系统将继续检查原任务。请勿重复提交，以免产生重复费用。',
    );
    expect(safeError.safeMessage).not.toContain('建议重试');
    expect(safeError.safeMessage).not.toContain('简化提示词');
    expect(safeError.safeMessage).not.toContain('切换 Seedream');
    expect(safeError.code).toBe('IMAGE_GENERATION_TIMEOUT');
    expect(safeError.providerCode).toBe('APIMART_GPT_IMAGE_2_TIMEOUT');
    expect(safeError.message).not.toContain('task_1234567890abcdef');
  });

  test('classifies no-image APIMart responses with an operator-safe message', () => {
    const error = new Error(
      'Upstream did not return the expected image. Please adjust your prompt. https://example.com/full-result.png',
    );
    error.statusCode = 502;
    error.responseBody = {
      error: {
        message: error.message,
      },
      data: [{ url: 'https://example.com/full-result.png' }],
    };

    const safeError = getSafeAPIMartError(error, {
      model: 'gpt-image-2',
      provider: 'apimart',
    });

    expect(safeError.safeMessage).toBe(
      'APIMart GPT Image 2 未返回有效图片结果，可能是提示词过长、内容过复杂或上游返回异常。建议简化提示词或切换 Seedream 5.0 Pro。',
    );
    expect(safeError.providerCode).toBe('APIMART_GPT_IMAGE_2_NO_IMAGE');
    expect(safeError.safeMessage).not.toContain('https://example.com');
  });

  test('builds safe log context without prompt, urls, base64, or secrets', () => {
    const context = getSafeAPIMartLogContext(
      {
        provider: 'apimart',
        model: 'gpt-image-2',
        modelKey: 'apimart_gpt_image_2_text',
        batchId: 'batch_123',
        itemId: 'white_box_1',
        prompt: '完整提示词不应该进入日志',
        promptLength: 1234,
        providerTaskId: 'task_1234567890abcdef',
        responseBody: {
          data: [{ url: 'https://example.com/full-result.png' }],
          status: 'IN_PROGRESS',
        },
      },
      {
        finalImageCount: 0,
        timeoutMs: 900000,
        elapsedMs: 12345,
        statusCode: 502,
        errorCode: 'APIMART_GPT_IMAGE_2_NO_IMAGE',
      },
    );

    const serialized = JSON.stringify(context);
    expect(context.providerTaskIdMasked).toBe('task***cdef');
    expect(context.responseKeys).toEqual(['data', 'status']);
    expect(context.finalImageCount).toBe(0);
    expect(serialized).not.toContain('完整提示词');
    expect(serialized).not.toContain('https://example.com/full-result.png');
    expect(serialized).not.toContain('APIMART_API_KEY');
  });
});

describe('APIMart submit persistence hook', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.APIMART_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.APIMART_API_KEY = originalKey;
  });

  test('awaits providerTaskId persistence before returning the submit result', async () => {
    process.env.APIMART_API_KEY = 'test-key';
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ data: { task_id: 'task-paid-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const events = [];

    const result = await submitImageTask(
      { model: 'gpt-image-2', prompt: 'not logged', n: 1, size: '1024x1024' },
      {
        onProviderTaskSubmitted: async ({ providerTaskId }) => {
          await Promise.resolve();
          events.push(`persisted:${providerTaskId}`);
        },
      },
    );
    events.push('returned');

    expect(result.taskId).toBe('task-paid-1');
    expect(events).toEqual(['persisted:task-paid-1', 'returned']);
  });

  test('persists provider status changes while polling', async () => {
    process.env.APIMART_API_KEY = 'test-key';
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({ status: 'SUCCEEDED', data: { url: 'https://cdn.example/result.png' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const events = [];

    const result = await pollTask({
      taskId: 'task-paid-1',
      intervalMs: 1,
      timeoutMs: 100,
      context: {
        onProviderPoll: async (event) => events.push({ type: 'poll', ...event }),
        onProviderStatusChanged: async (event) => events.push({ type: 'status', ...event }),
      },
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(events).toEqual([
      { type: 'poll', providerTaskId: 'task-paid-1', providerStatus: 'SUCCEEDED' },
      { type: 'status', providerTaskId: 'task-paid-1', providerStatus: 'SUCCEEDED' },
    ]);
  });
});

describe('APIMart terminal polling outcomes', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.APIMART_API_KEY;
  const response = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.APIMART_API_KEY = 'test-key';
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.APIMART_API_KEY;
    else process.env.APIMART_API_KEY = originalKey;
  });

  test.each([
    ['gpt-image-2', 'failed'],
    ['gpt-image-2.5-sunburst', 'FAILED'],
    ['gpt-image-2.5-flare', 'failure'],
    ['gpt-image-2', 'error'],
    ['gpt-image-2', 'cancelled'],
    ['gpt-image-2', 'canceled'],
  ])('%s stops at the first confirmed %s response', async (model, status) => {
    global.fetch = jest.fn(async () =>
      response({ status, error: { code: 'UPSTREAM_REJECTED', message: 'request rejected' } }),
    );
    const startedAt = Date.now();
    const outcome = pollTask({
      taskId: 'accepted-task',
      model,
      timeoutMs: 100,
      intervalMs: 10,
    }).then(
      () => null,
      (error) => ({ error, elapsedMs: Date.now() - startedAt }),
    );
    await jest.advanceTimersByTimeAsync(100);
    const { error, elapsedMs } = await outcome;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBe(0);
    expect(error).toMatchObject({
      code: 'UPSTREAM_REJECTED',
      providerErrorCode: 'UPSTREAM_REJECTED',
      providerStatus: status,
    });
    expect(error.safeMessage).toBe('request rejected');
  });

  test('preserves a terminal upstream timeout without claiming it is still processing', async () => {
    global.fetch = jest.fn(async () =>
      response({ status: 'failed', code: 'UPSTREAM_TIMEOUT', message: 'upstream timed out' }),
    );
    const outcome = pollTask({
      taskId: 'accepted-task',
      model: 'gpt-image-2',
      timeoutMs: 100,
      intervalMs: 10,
    }).catch((error) => error);
    await jest.advanceTimersByTimeAsync(100);
    const error = await outcome;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_TIMEOUT');
    expect(error.safeMessage).toBe('upstream timed out');
  });

  test('returns a stable failure code when the terminal response has no code', async () => {
    global.fetch = jest.fn(async () => response({ status: 'failed' }));
    const outcome = pollTask({ taskId: 'accepted-task', timeoutMs: 100, intervalMs: 10 }).catch(
      (error) => error,
    );
    await jest.advanceTimersByTimeAsync(100);
    expect((await outcome).code).toBe('APIMART_TASK_FAILED');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test.each(['network', 'http'])(
    'recovers from a temporary %s error before success',
    async (kind) => {
      global.fetch = jest
        .fn()
        .mockImplementationOnce(async () => {
          if (kind === 'network') throw new TypeError('fetch failed');
          return response({ status: 'failed', message: 'gateway unavailable' }, 503);
        })
        .mockImplementationOnce(async () => response({ status: 'processing' }))
        .mockImplementationOnce(async () =>
          response({
            status: 'completed',
            data: { url: 'https://example.test/result.png' },
          }),
        );
      const outcome = pollTask({
        taskId: 'accepted-task',
        model: 'gpt-image-2',
        timeoutMs: 100,
        intervalMs: 10,
      });
      await jest.advanceTimersByTimeAsync(30);
      expect(await outcome).toMatchObject({ resultUrl: 'https://example.test/result.png' });
      expect(global.fetch).toHaveBeenCalledTimes(3);
    },
  );

  test('keeps an actually processing task distinct from terminal failure at the observation limit', async () => {
    global.fetch = jest.fn(async () => response({ status: 'IN_PROGRESS' }));
    const outcome = pollTask({
      taskId: 'accepted-task',
      model: 'gpt-image-2',
      timeoutMs: 100,
      intervalMs: 10,
    }).catch((error) => error);
    await jest.advanceTimersByTimeAsync(100);
    const error = await outcome;
    expect(error.code).toBe('IMAGE_GENERATION_TIMEOUT');
    expect(error.providerStatus).toBe('IN_PROGRESS');
    expect(error.safeMessage).toContain('继续检查');
    expect(global.fetch.mock.calls.length).toBeGreaterThan(1);
  });
});
