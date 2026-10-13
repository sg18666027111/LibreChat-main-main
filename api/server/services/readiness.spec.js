const { EventEmitter } = require('node:events');
// Advance the monotonic cache clock alongside Jest's fake timeout clock.
jest.mock('node:perf_hooks', () => ({ performance: { now: () => Date.now() } }));
const { createReadinessCheck } = require('./readiness');

describe('bounded Mongo readiness', () => {
  let connection;
  let check;
  let started;
  beforeEach(() => {
    jest.useFakeTimers();
    started = true;
    connection = Object.assign(new EventEmitter(), {
      readyState: 1,
      db: { command: jest.fn().mockResolvedValue({ ok: 1 }) },
    });
    check = createReadinessCheck({ connection, isStarted: () => started });
  });
  afterEach(() => {
    check.stop();
    jest.useRealTimers();
  });

  it('keeps startup and shutdown closed even if Mongo responds successfully', async () => {
    started = false;
    expect(await check.isReady()).toBe(false);
    started = true;
    expect(await check.isReady()).toBe(true);
    check.stop();
    expect(await check.isReady()).toBe(false);
  });

  it('shares one bounded read-only command across concurrent callers and caches it briefly', async () => {
    expect(await Promise.all(Array.from({ length: 50 }, () => check.isReady()))).toEqual(
      Array(50).fill(true),
    );
    expect(connection.db.command).toHaveBeenCalledTimes(1);
    expect(connection.db.command).toHaveBeenCalledWith(
      { ping: 1 },
      expect.objectContaining({ timeoutMS: 1000, readPreference: 'primary' }),
    );
    expect(await check.isReady()).toBe(true);
    expect(connection.db.command).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2001);
    expect(await check.isReady()).toBe(true);
    expect(connection.db.command).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached success on disconnect and probes afresh on reconnect', async () => {
    expect(await check.isReady()).toBe(true);
    connection.readyState = 0;
    connection.emit('disconnected');
    expect(await check.isReady()).toBe(false);
    connection.readyState = 1;
    connection.emit('connected');
    connection.db.command.mockRejectedValueOnce(new Error('private connection details'));
    expect(await check.isReady()).toBe(false);
    await jest.advanceTimersByTimeAsync(2001);
    expect(await check.isReady()).toBe(true);
  });

  it('returns within the deadline without accumulating probes when the driver never settles', async () => {
    let finish;
    connection.db.command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const response = check.isReady();
    await jest.advanceTimersByTimeAsync(1001);
    expect(await response).toBe(false);
    expect(connection.db.command.mock.calls[0][1].signal.aborted).toBe(true);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await Promise.all(Array.from({ length: 50 }, () => check.isReady()))).toEqual(
      Array(50).fill(false),
    );
    expect(connection.db.command).toHaveBeenCalledTimes(1);
    finish({ ok: 1 });
    await jest.advanceTimersByTimeAsync(2001);
    expect(await check.isReady()).toBe(true);
    expect(connection.db.command).toHaveBeenCalledTimes(2);
  });

  it('cannot publish a late success across a disconnect/reconnect boundary', async () => {
    let finish;
    connection.db.command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const response = check.isReady();
    await jest.advanceTimersByTimeAsync(1);
    connection.readyState = 0;
    connection.emit('disconnected');
    connection.readyState = 1;
    connection.emit('connected');
    finish({ ok: 1 });
    expect(await response).toBe(false);
  });

  it('stops promptly during a probe and never reopens after a late startup completion', async () => {
    connection.db.command.mockImplementationOnce(() => new Promise(() => {}));
    const response = check.isReady();
    await jest.advanceTimersByTimeAsync(1);
    check.stop();
    await expect(response).resolves.toBe(false);
    await expect(check.waitForIdle()).resolves.toBeUndefined();
    started = true;
    expect(await check.isReady()).toBe(false);
    expect(connection.listenerCount('disconnected')).toBe(0);
  });

  it('treats a command failure as unavailable even while the connection still says connected', async () => {
    connection.db.command.mockRejectedValueOnce(new Error('unavailable'));
    expect(await check.isReady()).toBe(false);
    await jest.advanceTimersByTimeAsync(2001);
    connection.db.command.mockResolvedValueOnce({ ok: 0 });
    expect(await check.isReady()).toBe(false);
  });
});
