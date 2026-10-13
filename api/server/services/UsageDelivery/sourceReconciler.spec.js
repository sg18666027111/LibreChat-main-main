const { reconcileUsageSources, createSourceReconciler } = require('./sourceReconciler');
const { makeEnvelope } = require('./test/fixtures');
const { validateEnvelope } = require('./contract');
const now = () => Date.parse('2026-09-21T00:00:00.000Z');
const cutover = '2026-09-19T00:00:00.000Z';
function source(id, overrides) {
  const envelope = makeEnvelope(overrides);
  envelope.event.usageEventId = `image:${id}`;
  return { source: 'image', id, envelope, createdAt: envelope.occurredAt };
}
test('historical dry-run classifies four cases without any writes and batches the ledger lookup', async () => {
  const items = [
    source('missing'),
    source('existing'),
    { source: 'transaction', id: 'no-proof', createdAt: new Date(now()) },
    source('expired', {
      occurredAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-31T00:00:00.000Z',
    }),
  ];
  const capture = jest.fn(),
    acknowledge = jest.fn();
  const readLedger = jest.fn(async () => [
    {
      usageEventId: 'image:existing',
      deliveryRevision: 1,
      deliveryDigest: validateEnvelope(items[1].envelope).digest,
    },
  ]);
  const result = await reconcileUsageSources({
    mode: 'dry-run',
    limit: 100,
    readPage: async () => ({ items, cursor: null }),
    readLedger,
    capture,
    acknowledge,
    now,
  });
  expect(result.counts).toEqual({
    missing: 1,
    existing: 1,
    insufficient_evidence: 1,
    out_of_retention: 1,
  });
  expect(capture).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
  expect(readLedger).toHaveBeenCalledTimes(1);
});
test('new source gaps capture once while exact ledger acknowledgements skip capture', async () => {
  const items = [source('gap'), source('acked')];
  const capture = jest.fn(async () => ({ durableAccepted: true, ledgerPersisted: false }));
  const acknowledge = jest.fn();
  const result = await reconcileUsageSources({
    mode: 'new',
    cutover,
    limit: 100,
    readPage: async () => ({ items, cursor: 'next' }),
    readLedger: async () => [
      {
        usageEventId: 'image:acked',
        deliveryRevision: 1,
        deliveryDigest: validateEnvelope(items[1].envelope).digest,
      },
    ],
    capture,
    acknowledge,
    now,
  });
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledWith(items[0].envelope, items[0]);
  expect(acknowledge).toHaveBeenCalledWith(items[1], 'persisted');
  expect(acknowledge).toHaveBeenCalledWith(items[0], 'durable');
  expect(result.cursor).toBe('next');
});
test('invalid and pre-cutover evidence does not block subsequent valid sources or invent prices', async () => {
  const items = [
    source('old', {
      occurredAt: '2026-09-18T00:00:00.000Z',
      expiresAt: '2026-10-18T00:00:00.000Z',
    }),
    source('bad', { schemaVersion: 2 }),
    source('unknown-price', { pricing: { kind: 'missing' } }),
    source('good'),
  ];
  const capture = jest.fn(async () => ({ durableAccepted: true, ledgerPersisted: false }));
  const acknowledge = jest.fn();
  await reconcileUsageSources({
    mode: 'new',
    cutover,
    limit: 100,
    readPage: async () => ({ items, cursor: null }),
    readLedger: async () => [],
    capture,
    acknowledge,
    now,
  });
  expect(capture.mock.calls.map(([value]) => value.event.usageEventId)).toEqual([
    'image:unknown-price',
    'image:good',
  ]);
  expect(acknowledge).toHaveBeenCalledWith(items[2], 'review');
  expect(capture.mock.calls[0][0].pricing).toEqual({ kind: 'missing' });
});
test('capture failures retain pending source and do not prevent the next item', async () => {
  const items = [source('failed'), source('good')];
  const capture = jest
    .fn()
    .mockRejectedValueOnce(new Error('DB offline'))
    .mockResolvedValueOnce({ durableAccepted: true, ledgerPersisted: false });
  const acknowledge = jest.fn();
  await reconcileUsageSources({
    mode: 'new',
    cutover,
    limit: 100,
    readPage: async () => ({ items, cursor: null }),
    readLedger: async () => [],
    capture,
    acknowledge,
    now,
  });
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(acknowledge).toHaveBeenCalledWith(items[1], 'durable');
});
test.each([0, 101, NaN, -1])('rejects unbounded page size %s before reading', async (limit) => {
  const readPage = jest.fn();
  await expect(reconcileUsageSources({ mode: 'dry-run', limit, readPage })).rejects.toThrow();
  expect(readPage).not.toHaveBeenCalled();
});
test('expired new evidence is retained for private review and never sent directly to ledger writes', async () => {
  const item = source('expired-new');
  const capture = jest.fn(async () => ({ durableAccepted: true, ledgerPersisted: false }));
  const acknowledge = jest.fn();
  const result = await reconcileUsageSources({
    mode: 'new',
    cutover,
    limit: 100,
    readPage: async () => ({ items: [item], cursor: null }),
    readLedger: async () => [],
    capture,
    acknowledge,
    now: () => Date.parse('2026-10-21T00:00:00.000Z'),
  });
  expect(result.counts.out_of_retention).toBe(1);
  expect(capture).toHaveBeenCalledWith(item.envelope, item);
  expect(acknowledge).toHaveBeenCalledWith(item, 'review');
});
test('source scans coalesce concurrent ticks and stop before advancing to another collection', async () => {
  let unblock;
  const readPage = jest.fn(
    () =>
      new Promise((resolve) => {
        unblock = resolve;
      }),
  );
  const worker = createSourceReconciler({
    store: { readPage, readLedger: jest.fn(), acknowledge: jest.fn() },
    capture: jest.fn(),
    cutover,
    now,
  });
  const first = worker.runOnce();
  const second = worker.runOnce();
  expect(first).toBe(second);
  worker.stop();
  unblock({ items: [], cursor: null });
  await worker.drain();
  expect(readPage).toHaveBeenCalledTimes(1);
});
