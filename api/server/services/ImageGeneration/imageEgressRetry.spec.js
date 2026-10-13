const {
  IMAGE_EGRESS_RETRY_POLICIES,
  getImageEgressNextAttemptAt,
  isRetryableImageEgressError,
  runImageEgressTurnRetry,
} = require('./imageEgressRetry');

function transportError(code) {
  return Object.assign(new Error(code), { code });
}

describe('image egress retry policy', () => {
  it.each([
    transportError('ETIMEDOUT'),
    transportError('ECONNRESET'),
    transportError('UND_ERR_CONNECT_TIMEOUT'),
    transportError('ERR_TLS_HANDSHAKE_TIMEOUT'),
    Object.assign(new Error('bad gateway'), { statusCode: 502 }),
    Object.assign(new Error('unavailable'), { status: 503 }),
    Object.assign(new Error('gateway timeout'), { response: { status: 504 } }),
  ])('retries a transient read failure %#', (error) => {
    expect(isRetryableImageEgressError(error)).toBe(true);
  });

  it.each([
    Object.assign(new Error('bad request'), { statusCode: 400 }),
    Object.assign(new Error('not found'), { status: 404 }),
    transportError('IMAGE_OUTPUT_INVALID'),
    transportError('IMAGE_OUTPUT_TOO_LARGE'),
    transportError('IMAGE_OUTPUT_URL_REJECTED'),
    new Error('validation failed'),
  ])('does not retry a terminal read failure %#', (error) => {
    expect(isRetryableImageEgressError(error)).toBe(false);
  });

  it.each([
    'INVALID_RESULT_IMAGE',
    'RESULT_URL_REJECTED',
    'RESULT_DOWNLOAD_TOO_LARGE',
    'FAL_NO_IMAGE',
  ])('does not let semantic terminal code %s become retryable through status 502', (code) => {
    expect(
      isRetryableImageEgressError(Object.assign(new Error(code), { code, statusCode: 502 })),
    ).toBe(false);
  });

  it('retries the same read after one timeout and returns the second result', async () => {
    let attempts = 0;
    const sleep = jest.fn(async () => {});
    const operation = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw transportError('ETIMEDOUT');
      }
      return { providerStatus: 'completed' };
    };

    await expect(
      runImageEgressTurnRetry(operation, {
        ...IMAGE_EGRESS_RETRY_POLICIES.status_read,
        sleep,
        monotonicNow: () => 0,
        random: () => 0.5,
      }),
    ).resolves.toEqual({
      value: { providerStatus: 'completed' },
      attempts: 2,
      elapsedMs: 0,
    });
    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('uses exponential backoff and stops at the per-turn attempt cap', async () => {
    const sleep = jest.fn(async () => {});
    const error = transportError('ECONNRESET');
    const operation = jest.fn(async () => {
      throw error;
    });

    await expect(
      runImageEgressTurnRetry(operation, {
        ...IMAGE_EGRESS_RETRY_POLICIES.status_read,
        sleep,
        monotonicNow: () => 0,
        random: () => 0.5,
      }),
    ).rejects.toMatchObject({
      code: 'IMAGE_EGRESS_TURN_RETRY_EXHAUSTED',
      operation: 'status_read',
      attempts: 4,
      elapsedMs: 0,
      lastError: error,
    });
    expect(operation).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([500, 1000, 2000]);
  });

  it('stops the turn before another attempt would exceed its elapsed budget', async () => {
    const error = transportError('ETIMEDOUT');
    const operation = jest.fn(async () => {
      throw error;
    });
    const timestamps = [0, 29_900, 30_100];

    await expect(
      runImageEgressTurnRetry(operation, {
        ...IMAGE_EGRESS_RETRY_POLICIES.status_read,
        sleep: jest.fn(async () => {}),
        monotonicNow: () => timestamps.shift() ?? 30_100,
        random: () => 0.5,
      }),
    ).rejects.toMatchObject({
      code: 'IMAGE_EGRESS_TURN_RETRY_EXHAUSTED',
      attempts: 1,
      elapsedMs: 30_100,
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('aborts and releases a turn when an individual read never settles', async () => {
    const operation = jest.fn(
      ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );

    await expect(
      runImageEgressTurnRetry(operation, {
        ...IMAGE_EGRESS_RETRY_POLICIES.status_read,
        maxAttempts: 1,
        turnBudgetMs: 10,
      }),
    ).rejects.toMatchObject({
      code: 'IMAGE_EGRESS_TURN_RETRY_EXHAUSTED',
      operation: 'status_read',
      attempts: 1,
      lastError: expect.objectContaining({ code: 'IMAGE_EGRESS_OPERATION_TIMEOUT' }),
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-retryable error without sleeping or wrapping it', async () => {
    const error = Object.assign(new Error('unauthorized'), { statusCode: 401 });
    const sleep = jest.fn(async () => {});

    await expect(
      runImageEgressTurnRetry(
        async () => {
          throw error;
        },
        {
          ...IMAGE_EGRESS_RETRY_POLICIES.status_read,
          sleep,
          monotonicNow: () => 0,
          random: () => 0.5,
        },
      ),
    ).rejects.toBe(error);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('schedules persistent retry turns with exponential delay and a 60 second cap', () => {
    const now = new Date('2026-08-08T10:00:00.000Z');

    expect(getImageEgressNextAttemptAt({ now, failedTurnCount: 1, random: () => 0.5 })).toEqual(
      new Date('2026-08-08T10:00:05.000Z'),
    );
    expect(getImageEgressNextAttemptAt({ now, failedTurnCount: 2, random: () => 0.5 })).toEqual(
      new Date('2026-08-08T10:00:10.000Z'),
    );
    expect(getImageEgressNextAttemptAt({ now, failedTurnCount: 20, random: () => 0.5 })).toEqual(
      new Date('2026-08-08T10:01:00.000Z'),
    );
  });

  it('bounds positive and negative jitter around the persistent delay', () => {
    const now = new Date('2026-08-08T10:00:00.000Z');

    expect(getImageEgressNextAttemptAt({ now, failedTurnCount: 1, random: () => 0 })).toEqual(
      new Date('2026-08-08T10:00:04.000Z'),
    );
    expect(getImageEgressNextAttemptAt({ now, failedTurnCount: 1, random: () => 1 })).toEqual(
      new Date('2026-08-08T10:00:06.000Z'),
    );
  });
});
