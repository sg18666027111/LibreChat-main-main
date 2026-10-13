import { createAPIMartImageTiming } from './timing';

describe('safe APIMart stage timing', () => {
  afterEach(() => jest.useRealTimers());

  test('writes a self-contained message with measured duration and only allowed fields', async () => {
    jest.useFakeTimers();
    const messages: string[] = [];
    const timing = createAPIMartImageTiming({
      taskId: 'private-task-id',
      log: (message) => messages.push(message),
    });
    const stats = {
      imageCount: 2,
      imageIndex: 1,
      bytes: 123,
      prompt: 'private-prompt',
      url: 'https://secret.test',
      apiKey: 'secret-token',
    };
    const pending = timing.measure(
      'reference_read',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 125));
        return 'unchanged-result';
      },
      stats,
    );
    await jest.advanceTimersByTimeAsync(125);
    expect(await pending).toBe('unchanged-result');
    const event = JSON.parse(messages[0].split(' timing ')[1]);
    expect(event).toEqual({
      provider: 'apimart',
      model: 'gpt-image-2',
      taskHash: expect.stringMatching(/^[a-f0-9]{24}$/),
      stage: 'reference_read',
      outcome: 'success',
      durationMs: 125,
      imageCount: 2,
      imageIndex: 1,
      bytes: 123,
    });
    expect(messages.join('')).not.toMatch(/private-|secret/);
    timing.record('recovery_wait', 'resumed', 30500, { scheduledDelayMs: 30000 });
    expect(JSON.parse(messages[1].split(' timing ')[1])).toMatchObject({
      taskHash: event.taskHash,
      durationMs: 30500,
      scheduledDelayMs: 30000,
    });
  });

  test('omits nonnumeric diagnostics and unknown model names at the JS boundary', () => {
    const messages: string[] = [];
    const timing = createAPIMartImageTiming({
      model: 'private-model-value',
      log: (message) => messages.push(message),
    });
    timing.record('upload', 'success', 25, { bytes: NaN, imageIndex: -1, imageCount: Infinity });
    expect(JSON.parse(messages[0].split(' timing ')[1])).toEqual({
      provider: 'apimart',
      stage: 'upload',
      outcome: 'success',
      durationMs: 25,
    });
    timing.record('upload', 'failure', NaN);
    expect(messages).toHaveLength(1);
  });

  test('preserves the original failure without writing its sensitive contents', async () => {
    const messages: string[] = [];
    const timing = createAPIMartImageTiming({ log: (message) => messages.push(message) });
    const failure = new Error('secret-token private-url');
    await expect(
      timing.measure('upload', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(messages[0]).toContain('"outcome":"failure"');
    expect(messages[0]).not.toMatch(/secret|private/);
  });

  test('a failing log sink cannot change successful or failed operations', async () => {
    const timing = createAPIMartImageTiming({
      log: () => {
        throw new Error('log unavailable');
      },
    });
    await expect(timing.measure('submit', async () => 42)).resolves.toBe(42);
    const failure = new Error('original');
    await expect(
      timing.measure('submit', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(() => timing.record('recovery_wait', 'scheduled', 30000)).not.toThrow();
  });
});
