const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { openUsageJournal } = require('./journal');
const { createUsageDeliveryService } = require('./service');
const { makeEnvelope } = require('./test/fixtures');
let directory, service, journal;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'o03-service-'));
  journal = await openUsageJournal({ directory });
});
afterEach(async () => {
  await service?.drain();
  await journal.close();
  await fs.rm(directory, { recursive: true, force: true });
});
test('capture completes on durable commit without waiting for unreachable Mongo', async () => {
  service = createUsageDeliveryService({
    journal,
    persist: async () => {
      throw new Error('offline');
    },
  });
  const result = await service.capture(makeEnvelope());
  expect(result).toMatchObject({ durableAccepted: true, ledgerPersisted: false });
  expect((await journal.stats()).pendingCount).toBe(1);
});
test('deletion seals pending identities before anonymization can complete', async () => {
  const ledger = new Map();
  service = createUsageDeliveryService({
    journal,
    persist: async (e) => {
      if (!ledger.has(e.event.usageEventId)) ledger.set(e.event.usageEventId, e.event.userId);
      return { persisted: true, revision: e.revision };
    },
  });
  await service.capture(makeEnvelope());
  let anonymized = false;
  await service.withDeletedSubject('usage-subject-test-1', async () => {
    expect([...ledger.values()]).toEqual([null]);
    anonymized = true;
  });
  expect(anonymized).toBe(true);
  expect(await journal.isDeletedSubject('usage-subject-test-1')).toBe(true);
});
test('failed anonymization retains a tombstone for restart recovery', async () => {
  service = createUsageDeliveryService({
    journal,
    persist: async () => ({ persisted: true, revision: 1 }),
  });
  await expect(
    service.withDeletedSubject('usage-subject-test-1', async () => {
      throw new Error('Mongo down');
    }),
  ).rejects.toThrow('Mongo down');
  expect(await journal.isDeletedSubject('usage-subject-test-1')).toBe(true);
});
test('deletion waits for in-flight writes for the same subject', async () => {
  let release, started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const ledger = new Map();
  service = createUsageDeliveryService({
    journal,
    persist: async (e) => {
      if (e.event.userId) {
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      ledger.set(e.event.usageEventId, e.event.userId);
      return { persisted: true, revision: 1 };
    },
  });
  await service.capture(makeEnvelope());
  const pending = service.runOnce();
  await entered;
  let deleted = false;
  const deletion = service.withDeletedSubject('usage-subject-test-1', async () => {
    for (const key of ledger.keys()) ledger.set(key, null);
    deleted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(deleted).toBe(false);
  release();
  await pending;
  await deletion;
  expect([...ledger.values()]).toEqual([null]);
});

test('expired quarantine is identity-sealed while deletion still reaches anonymization', async () => {
  const expired = makeEnvelope({
    occurredAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-31T00:00:00.000Z',
  });
  const persist = jest.fn(async () => {
    throw Object.assign(new Error('expired'), { code: 'USAGE_EXPIRED' });
  });
  const sealExpired = jest.fn(async () => {});
  service = createUsageDeliveryService({ journal, persist, sealExpired });
  await service.capture(expired);
  await service.runOnce();
  const anonymize = jest.fn();
  await service.withDeletedSubject(expired.reportingSubjectId, anonymize);
  expect(persist).not.toHaveBeenCalled();
  expect(sealExpired).toHaveBeenCalledWith(
    expect.objectContaining({ event: expect.objectContaining({ userId: null }) }),
  );
  expect(anonymize).toHaveBeenCalledTimes(1);
  expect((await journal.stats()).quarantinedCount).toBe(1);
});
