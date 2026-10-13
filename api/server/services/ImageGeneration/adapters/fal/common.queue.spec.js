const originalFalKey = process.env.FAL_KEY;

describe('Fal Queue one-call operations', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.FAL_KEY = 'fal-test-key';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = undefined;
    if (originalFalKey === undefined) {
      delete process.env.FAL_KEY;
    } else {
      process.env.FAL_KEY = originalFalKey;
    }
  });

  function jsonResponse(json, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(json),
    };
  }

  it('reports explicit exhausted balance as a rejected generation submission', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse(
        {
          detail:
            'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing',
        },
        403,
      ),
    );
    const { submitFalQueueTask } = require('./common');
    await expect(
      submitFalQueueTask({
        model: 'openai/gpt-image-2.5/flare/text-to-image',
        payload: { prompt: 'new' },
      }),
    ).rejects.toMatchObject({
      code: 'FAL_BALANCE_EXHAUSTED',
      statusCode: 403,
      submitOutcome: 'rejected',
      safeMessage: '当前生图服务余额不足，请联系管理员充值后重试。',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not misclassify an unrelated forbidden response as exhausted balance', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ detail: 'User is locked. Reason: Account suspended.' }, 403),
    );
    const { submitFalQueueTask } = require('./common');
    await expect(
      submitFalQueueTask({
        model: 'openai/gpt-image-2.5/flare/text-to-image',
        payload: { prompt: 'new' },
      }),
    ).rejects.toMatchObject({ code: 'FAL_HTTP_401', statusCode: 403, submitOutcome: 'rejected' });
  });

  it('submits exactly once and maps request_id to the common provider task identity', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({
        request_id: 'fal-request-1',
        status_url: 'https://queue.fal.run/status/fal-request-1',
        response_url: 'https://queue.fal.run/result/fal-request-1',
      }),
    );
    const { submitFalQueueTask } = require('./common');

    await expect(
      submitFalQueueTask({
        model: 'openai/gpt-image-2/edit',
        payload: { prompt: 'edit' },
      }),
    ).resolves.toEqual({
      providerTaskId: 'fal-request-1',
      providerMetadata: {
        statusUrl: 'https://queue.fal.run/status/fal-request-1',
        responseUrl: 'https://queue.fal.run/result/fal-request-1',
      },
      outputUrls: [],
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://queue.fal.run/openai/gpt-image-2/edit',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ prompt: 'edit' }) }),
    );
  });

  it('does not retry when submit loses its response', async () => {
    global.fetch.mockRejectedValue(
      Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    );
    const { submitFalQueueTask } = require('./common');

    await expect(
      submitFalQueueTask({ model: 'fal-ai/nano-banana-pro', payload: { prompt: 'new' } }),
    ).rejects.toMatchObject({ code: 'FAL_NETWORK_ERROR', submitOutcome: 'unknown' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('classifies response body read failures with safe submit diagnostics', async () => {
    const onDiagnostic = jest.fn();
    const payload = {
      prompt: 'private prompt must not appear in diagnostics',
      image_urls: ['data:image/png;base64,aW1hZ2U='],
    };
    const privateFailure = new Error(
      'body read failed for https://queue.fal.run/private?fal_key=secret',
    );
    privateFailure.cause = {
      code: 'UND_ERR_BODY_TIMEOUT',
      message: 'nested cause at https://queue.fal.run/private-cause?token=secret',
    };
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      headers: {
        get: (name) =>
          ({
            'x-fal-request-id': 'fal-request-safe-1',
            'x-fal-error-type': 'runner_disconnected',
            'x-fal-request-timeout-type': 'user',
            'x-private-header': 'must-not-be-collected',
          })[name.toLowerCase()] ?? null,
      },
      text: jest.fn().mockRejectedValueOnce(privateFailure),
    });
    const { submitFalQueueTask } = require('./common');

    let caught;
    try {
      await submitFalQueueTask({ model: 'openai/gpt-image-2/edit', payload, onDiagnostic });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'FAL_RESPONSE_BODY_ERROR',
      submitOutcome: 'unknown',
      phase: 'response_body',
      statusCode: 202,
      requestBodyBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      responseMetadata: {
        falRequestId: 'fal-request-safe-1',
        falErrorType: 'runner_disconnected',
        falRequestTimeoutType: 'user',
      },
    });
    expect(caught.elapsedMs).toEqual(expect.any(Number));
    expect(caught.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(caught.transportErrorCode).toBe('UND_ERR_BODY_TIMEOUT');
    expect(caught.safeMessage).toBe('Fal response body could not be read');
    expect(JSON.stringify(caught)).not.toContain('private prompt');
    expect(JSON.stringify(caught)).not.toContain('queue.fal.run/private');
    expect(JSON.stringify(caught)).not.toContain('private-cause');
    expect(caught.responseMetadata).not.toHaveProperty('x-private-header');
    expect(onDiagnostic).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        phase: 'request_fetch',
        requestBodyBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      }),
    );
    expect(onDiagnostic).toHaveBeenNthCalledWith(2, {
      phase: 'response_body',
      elapsedMs: expect.any(Number),
      requestBodyBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      httpStatus: 202,
      falRequestId: 'fal-request-safe-1',
      falErrorType: 'runner_disconnected',
      falRequestTimeoutType: 'user',
    });
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
  });

  it('treats a parsed 2xx response without request identity as ambiguous', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ status: 'accepted' }));
    const { submitFalQueueTask } = require('./common');

    await expect(
      submitFalQueueTask({ model: 'fal-ai/nano-banana-pro', payload: { prompt: 'new' } }),
    ).rejects.toMatchObject({ code: 'FAL_MISSING_REQUEST_ID', submitOutcome: 'unknown' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('marks a parsed Provider rejection as rejected, not ambiguous', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ message: 'invalid prompt' }, 400));
    const { submitFalQueueTask } = require('./common');

    await expect(
      submitFalQueueTask({ model: 'fal-ai/nano-banana-pro', payload: { prompt: 'new' } }),
    ).rejects.toMatchObject({ code: 'FAL_BAD_REQUEST', submitOutcome: 'rejected' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503, 504])(
    'fails closed when submit receives a parsed transient HTTP %s response',
    async (status) => {
      global.fetch.mockResolvedValue(
        jsonResponse({ message: 'temporary upstream failure' }, status),
      );
      const { submitFalQueueTask } = require('./common');

      await expect(
        submitFalQueueTask({ model: 'fal-ai/nano-banana-pro', payload: { prompt: 'new' } }),
      ).rejects.toMatchObject({ submitOutcome: 'unknown' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['IN_QUEUE', 'pending'],
    ['IN_PROGRESS', 'pending'],
    ['COMPLETED', 'succeeded'],
    ['FAILED', 'failed'],
  ])('normalizes %s status to %s with one GET', async (providerStatus, state) => {
    global.fetch.mockResolvedValue(jsonResponse({ status: providerStatus, queue_position: 2 }));
    const { readFalQueueStatus } = require('./common');

    await expect(
      readFalQueueStatus({
        model: 'openai/gpt-image-2/edit',
        providerTaskId: 'fal-request-1',
        statusUrl: 'https://queue.fal.run/status/fal-request-1',
      }),
    ).resolves.toEqual({
      state,
      providerStatus,
      providerMetadata: { queuePosition: 2 },
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('reads final output URLs without downloading them', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ images: [{ url: 'https://signed.example/image.png?token=secret' }] }),
    );
    const { readFalQueueResult } = require('./common');

    await expect(
      readFalQueueResult({
        model: 'openai/gpt-image-2/edit',
        providerTaskId: 'fal-request-1',
        responseUrl: 'https://queue.fal.run/result/fal-request-1',
      }),
    ).resolves.toEqual({
      outputUrls: ['https://signed.example/image.png?token=secret'],
      providerMetadata: {},
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('extracts Fal GPT Image 2 images[0].url for the durable worker download step', async () => {
    const temporaryUrl = 'https://v3.fal.media/files/image.png?token=temporary';
    global.fetch.mockResolvedValue(
      jsonResponse({ images: [{ url: temporaryUrl, content_type: 'image/png' }] }),
    );
    const { readFalQueueResult } = require('./common');

    await expect(
      readFalQueueResult({
        model: 'openai/gpt-image-2',
        providerTaskId: 'fal-text-request-1',
        responseUrl: 'https://queue.fal.run/openai/gpt-image-2/requests/fal-text-request-1',
      }),
    ).resolves.toEqual({ outputUrls: [temporaryUrl], providerMetadata: {} });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
