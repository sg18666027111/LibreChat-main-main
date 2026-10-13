const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createUsageDeliveryRuntime } = require('./runtime');
const { makeEnvelope } = require('./test/fixtures');
const { logger } = require('@librechat/data-schemas');
let directory, runtime;
beforeEach(async () => {
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'info').mockImplementation(() => {});
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'o03-runtime-'));
});
afterEach(async () => {
  await runtime?.drain();
  jest.useRealTimers();
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
function create(overrides = {}) {
  runtime = createUsageDeliveryRuntime({
    env: {
      USAGE_DELIVERY_MODE: 'journal',
      USAGE_DELIVERY_DIR: directory,
      USAGE_DELIVERY_CUTOVER_AT: '2026-09-20T00:00:00.000Z',
      ...overrides,
    },
    persist: async () => ({ persisted: true, revision: 1 }),
  });
  return runtime;
}
test('off mode opens no private storage and preserves legacy anonymization', async () => {
  create({ USAGE_DELIVERY_MODE: 'off' });
  expect(await runtime.initialize()).toBeNull();
  expect(await runtime.withDeletedSubject('subject', async () => 'legacy')).toBe('legacy');
  expect(await fs.readdir(directory)).toEqual([]);
});
test('journal mode captures durably and exposes its shutdown drain', async () => {
  create();
  await runtime.initialize();
  expect(await runtime.capture(makeEnvelope())).toMatchObject({ durableAccepted: true });
  runtime.stop();
  await runtime.drain();
  expect(await runtime.capture(makeEnvelope())).toMatchObject({ durableAccepted: false });
});
test('startup journal failure fails capture and deletion closed without throwing out server startup', async () => {
  create({ USAGE_DELIVERY_DIR: path.join(directory, 'public', 'usage') });
  expect(await runtime.initialize()).toBeNull();
  expect(await runtime.capture(makeEnvelope())).toMatchObject({
    durableAccepted: false,
    reason: 'unavailable',
  });
  await expect(runtime.withDeletedSubject('subject', async () => 'deleted')).rejects.toMatchObject({
    code: 'USAGE_JOURNAL_UNAVAILABLE',
  });
  expect(logger.warn).toHaveBeenCalledWith(
    '[UsageDelivery] Journal unavailable phase=initialize code=USAGE_PRIVATE_PATH_REQUIRED',
  );
});
test.each([
  ['USAGE_WRITER_FENCED', 'USAGE_WRITER_FENCED'],
  ['USAGE_SECRET_customer@example.com', 'USAGE_JOURNAL_UNAVAILABLE'],
])(
  'sampling logs only a bounded diagnostic code for %s and records recovery',
  async (code, expected) => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    create();
    const service = await runtime.initialize();
    const stats = service.stats;
    service.stats = async () => {
      throw Object.assign(new Error('private prompt and API key must not appear'), { code });
    };
    await jest.advanceTimersByTimeAsync(30000);
    expect(logger.warn).toHaveBeenCalledWith(
      `[UsageDelivery] Journal unavailable phase=sample code=${expected}`,
    );
    service.stats = stats;
    await jest.advanceTimersByTimeAsync(30000);
    // Wait for the real journal worker before checking the sampling callback.
    await stats();
    expect(logger.info).toHaveBeenCalledWith('[UsageDelivery] Journal writable again');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(
      /customer@example|private prompt|API key/,
    );
  },
);
test.each([
  { USAGE_DELIVERY_MODE: 'journla' },
  { USAGE_DELIVERY_MAX_PENDING_BYTES: '-1' },
  { USAGE_DELIVERY_MAX_EVENT_BYTES: 'NaN' },
  { USAGE_DELIVERY_CUTOVER_AT: 'invalid' },
])('invalid configuration cannot silently enable legacy fallback: %j', async (override) => {
  create(override);
  expect(runtime.enabled()).toBe(true);
  expect(await runtime.initialize()).toBeNull();
  expect(await runtime.capture(makeEnvelope())).toMatchObject({ durableAccepted: false });
});
test('runtime recovers a source gap and samples journal health without invoking business operations', async () => {
  const envelope = makeEnvelope();
  const acknowledge = jest.fn();
  const onStats = jest.fn();
  const persist = jest.fn(async () => ({ persisted: true, revision: 1 }));
  runtime = createUsageDeliveryRuntime({
    env: {
      USAGE_DELIVERY_MODE: 'journal',
      USAGE_DELIVERY_DIR: directory,
      USAGE_DELIVERY_CUTOVER_AT: '2026-09-19T00:00:00.000Z',
    },
    persist,
    onStats,
    createSourceStore: () => ({
      readPage: async ({ source }) => ({
        items: source === 'image' ? [{ source, id: 'fixture', envelope }] : [],
        cursor: null,
      }),
      readLedger: async () => [],
      acknowledge,
    }),
  });
  const service = await runtime.initialize();
  await service.reconcileSourcesOnce();
  expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ id: 'fixture' }), 'durable');
  await service.runOnce();
  expect(persist).toHaveBeenCalledTimes(1);
  expect(onStats).toHaveBeenCalledWith(expect.objectContaining({ writable: true }));
});
test('a stalled source query cannot hold application shutdown beyond the drain budget', async () => {
  let release;
  runtime = createUsageDeliveryRuntime({
    env: {
      USAGE_DELIVERY_MODE: 'journal',
      USAGE_DELIVERY_DIR: directory,
      USAGE_DELIVERY_CUTOVER_AT: '2026-09-19T00:00:00.000Z',
    },
    persist: async () => ({ persisted: true, revision: 1 }),
    drainTimeoutMs: 20,
    createSourceStore: () => ({
      readPage: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      readLedger: async () => [],
      acknowledge: async () => {},
    }),
  });
  await runtime.initialize();
  const drain = runtime.drain().then(() => true);
  let timer;
  try {
    expect(
      await Promise.race([
        drain,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 200);
        }),
      ]),
    ).toBe(true);
  } finally {
    clearTimeout(timer);
    release({ items: [], cursor: null });
    await drain;
  }
});
