const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openUsageJournal } = require('./journal');
const { createUsageDeliveryWorker } = require('./worker');
const { makeEnvelope } = require('./test/fixtures');
let directory, journal, time, worker;
beforeEach(async () => {
  time = Date.now();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'o03-worker-'));
  journal = await openUsageJournal({ directory, now: () => time });
});
afterEach(async () => {
  await worker?.drain();
  await journal.close();
  await fs.rm(directory, { recursive: true, force: true });
});
function create(persist, custom = {}) {
  worker = createUsageDeliveryWorker({
    journal,
    persist,
    now: () => time,
    random: () => 0.5,
    ...custom,
  });
  return worker;
}
test('null ledger result leaves a retryable event rather than acknowledging it', async () => {
  await journal.append(makeEnvelope());
  create(async () => null);
  await worker.runOnce();
  expect((await journal.stats()).pendingCount).toBe(1);
  expect(await journal.claim(1)).toEqual([]);
  time += 1001;
  expect((await journal.claim(1))[0].envelope.event.imageCount).toBe(1);
});
test('successful persistence followed by lost ack safely replays one ledger row', async () => {
  const ledger = new Map();
  const realAck = journal.ack;
  let loseAck = true;
  journal.ack = async (claim) => {
    if (loseAck) {
      loseAck = false;
      throw new Error('lost ack');
    }
    return realAck(claim);
  };
  await journal.append(makeEnvelope());
  create(async (envelope) => {
    ledger.set(envelope.event.usageEventId, envelope.event.imageCount);
    return { persisted: true, revision: envelope.revision };
  });
  await worker.runOnce();
  expect((await journal.stats()).pendingCount).toBe(1);
  time += 1001;
  await worker.runOnce();
  expect((await journal.stats()).pendingCount).toBe(0);
  expect([...ledger.values()]).toEqual([1]);
});
test('unrecoverable record is quarantined without blocking a good event', async () => {
  await journal.append(makeEnvelope());
  const good = makeEnvelope();
  good.event.usageEventId = 'good';
  good.sourceKey = 'good';
  await journal.append(good);
  const ledger = new Map();
  create(async (e) => {
    if (e.sourceKey !== 'good')
      throw Object.assign(new Error('private detail'), { code: 'USAGE_REVISION_CONFLICT' });
    ledger.set(e.event.usageEventId, e.event.imageCount);
    return { persisted: true, revision: 1 };
  });
  await worker.runOnce();
  expect([...ledger.keys()]).toEqual(['good']);
  expect(await journal.stats()).toMatchObject({ pendingCount: 1, quarantinedCount: 1 });
});
test('deletion tombstone forces anonymous replay with original subject', async () => {
  await journal.append(makeEnvelope());
  await journal.tombstone('usage-subject-test-1');
  let stored;
  create(async (e) => {
    stored = e;
    return { persisted: true, revision: 1 };
  });
  await worker.runOnce();
  expect(stored.event.userId).toBeNull();
  expect(stored.reportingSubjectId).toBe('usage-subject-test-1');
});
test('delivery concurrency is bounded at two writes', async () => {
  for (let n = 0; n < 6; n++) {
    const e = makeEnvelope();
    e.sourceKey = `event-${n}`;
    e.event.usageEventId = e.sourceKey;
    await journal.append(e);
  }
  let active = 0,
    maximum = 0;
  create(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return { persisted: true, revision: 1 };
  });
  await worker.runOnce();
  expect(maximum).toBe(2);
  expect((await journal.stats()).pendingCount).toBe(0);
});
test('missing pricing is persisted for counts but held for review', async () => {
  await journal.append(makeEnvelope({ pricing: { kind: 'missing' } }));
  let count = 0;
  create(async () => {
    count++;
    return { persisted: true, revision: 1 };
  });
  await worker.runOnce();
  expect(count).toBe(1);
  expect(await journal.stats()).toMatchObject({ quarantinedCount: 1, pendingCount: 1 });
});
