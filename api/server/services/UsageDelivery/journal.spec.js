const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { openUsageJournal } = require('./journal');
const { makeEnvelope } = require('./test/fixtures');
let directory;
let opened;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'o03-journal-'));
  opened = [];
});
afterEach(async () => {
  for (const journal of opened) await journal.close();
  jest.useRealTimers();
  await fs.rm(directory, { recursive: true, force: true });
});
async function open(options = {}) {
  const journal = await openUsageJournal({
    directory,
    ownerId: 'first',
    maxPendingBytes: 262144,
    maxEventBytes: 32768,
    ...options,
  });
  opened.push(journal);
  return journal;
}
function second() {
  const e = makeEnvelope();
  e.sourceKey = 'test-call-2';
  e.event.usageEventId = 'image_generation:test-call-2:single';
  return e;
}
test('committed capture survives close/reopen and duplicate does not grow backlog', async () => {
  let journal = await open();
  expect((await journal.append(makeEnvelope())).durableAccepted).toBe(true);
  await journal.close();
  journal = await open({ ownerId: 'second' });
  expect((await journal.stats()).pendingCount).toBe(1);
  expect(await journal.append(makeEnvelope())).toMatchObject({
    durableAccepted: true,
    ledgerPersisted: false,
    revision: 1,
  });
  expect((await journal.stats()).pendingCount).toBe(1);
});
test('ack requires a valid claim and distinguishes ledger confirmation', async () => {
  const journal = await open();
  await journal.append(makeEnvelope());
  const [claim] = await journal.claim(20);
  await expect(journal.ack({ ...claim, token: 'wrong' })).rejects.toMatchObject({
    code: 'USAGE_CLAIM_LOST',
  });
  expect((await journal.stats()).pendingCount).toBe(1);
  await journal.ack(claim);
  expect((await journal.stats()).pendingCount).toBe(0);
  expect(await journal.append(makeEnvelope())).toMatchObject({
    durableAccepted: true,
    ledgerPersisted: true,
  });
});
test('same event revision with different accounting is isolated as conflict', async () => {
  const journal = await open();
  await journal.append(makeEnvelope());
  const input = makeEnvelope();
  input.event.imageCount = 2;
  expect(await journal.append(input)).toEqual({
    durableAccepted: false,
    ledgerPersisted: false,
    reason: 'conflict',
  });
  expect((await journal.claim(1))[0].envelope.event.imageCount).toBe(1);
});
test('capacity reservations serialize concurrent admission and preserve space for accepted work', async () => {
  const journal = await open({ maxPendingBytes: 4096 });
  const results = await Promise.allSettled(
    ['a', 'b'].map((key) =>
      journal.reserve({ key, bytes: 4096, expiresAt: '2026-10-01T00:00:00.000Z' }),
    ),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const reservation = results.find((r) => r.status === 'fulfilled').value;
  expect((await journal.append(second())).reason).toBe('full');
  expect((await journal.append(makeEnvelope(), reservation.id)).durableAccepted).toBe(true);
  expect((await journal.stats()).pendingCount).toBe(1);
  await journal.release(reservation.id);
  expect((await journal.append(second())).durableAccepted).toBe(true);
});
test('rejects an active second writer then fences the expired first writer', async () => {
  let time = Date.now();
  const now = () => time;
  const first = await open({ now });
  await first.append(makeEnvelope());
  await expect(open({ ownerId: 'second', now })).rejects.toMatchObject({
    code: 'USAGE_WRITER_BUSY',
  });
  time += 31000;
  const next = await open({ ownerId: 'second', now });
  expect((await first.append(second())).durableAccepted).toBe(false);
  expect((await next.stats()).pendingCount).toBe(1);
});
test('heartbeat restores sole expired writer without losing reservations or duplicating captures', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  let time = Date.now();
  const journal = await open({ now: () => time });
  await journal.append(makeEnvelope());
  const [expiredClaim] = await journal.claim(1);
  await journal.reserve({
    key: 'accepted-image',
    bytes: 4096,
    expiresAt: new Date(time + 86400000).toISOString(),
    scope: 'request',
  });
  time += 31001;
  await expect(journal.stats()).rejects.toMatchObject({ code: 'USAGE_WRITER_FENCED' });
  await jest.advanceTimersByTimeAsync(5000);
  expect(await journal.stats()).toMatchObject({
    writable: true,
    pendingCount: 1,
    reservedBytes: 4096,
  });
  await expect(journal.ack(expiredClaim)).rejects.toMatchObject({ code: 'USAGE_CLAIM_LOST' });
  expect(await journal.append(makeEnvelope())).toMatchObject({ durableAccepted: true });
  await journal.reserve({
    key: 'new-image',
    bytes: 65536,
    expiresAt: new Date(time + 86400000).toISOString(),
  });
  const [claim] = await journal.claim(1);
  await journal.ack(claim);
  expect(await journal.append(makeEnvelope())).toMatchObject({ ledgerPersisted: true });
  expect(await journal.stats()).toMatchObject({ pendingCount: 0, reservedBytes: 69632 });
});
test('heartbeat cannot revive a replaced writer even when owner IDs match', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  let time = Date.now();
  const first = await open({ now: () => time });
  await first.append(makeEnvelope());
  const [oldClaim] = await first.claim(1);
  time += 31001;
  const replacement = await open({ now: () => time });
  await jest.advanceTimersByTimeAsync(5000);
  await expect(first.stats()).rejects.toMatchObject({ code: 'USAGE_WRITER_FENCED' });
  await expect(first.ack(oldClaim)).rejects.toMatchObject({ code: 'USAGE_WRITER_FENCED' });
  await expect(
    first.reserve({ key: 'stale', bytes: 1024, expiresAt: new Date(time + 60000).toISOString() }),
  ).rejects.toMatchObject({ code: 'USAGE_WRITER_FENCED' });
  await first.close();
  expect(await replacement.stats()).toMatchObject({ writable: true, pendingCount: 1 });
  const [claim] = await replacement.claim(1);
  await replacement.ack(claim);
  expect(await replacement.stats()).toMatchObject({ pendingCount: 0 });
});
test('expired claim is recoverable and stale token cannot acknowledge it', async () => {
  let time = Date.now();
  const now = () => time;
  const first = await open({ now });
  await first.append(makeEnvelope());
  const [old] = await first.claim(1);
  time += 31000;
  const next = await open({ now, ownerId: 'next' });
  const [current] = await next.claim(1);
  expect(current.token).not.toBe(old.token);
  await expect(next.ack(old)).rejects.toMatchObject({ code: 'USAGE_CLAIM_LOST' });
  await next.ack(current);
  expect((await next.stats()).pendingCount).toBe(0);
});
test('retry schedule is bounded and quarantined records retain capacity', async () => {
  let time = Date.now();
  const journal = await open({ now: () => time });
  await journal.append(makeEnvelope());
  await journal.append(second());
  const [first, next] = await journal.claim(2);
  await journal.retry(first, time + 2000, 'unavailable');
  await journal.quarantine(next, 'invalid');
  expect(await journal.claim(2)).toEqual([]);
  time += 2001;
  expect((await journal.claim(2))[0].attempts).toBe(2);
  expect(await journal.stats()).toMatchObject({ pendingCount: 2, quarantinedCount: 1 });
});
test('deletion tombstone persists and pending subject envelopes can be sealed', async () => {
  let journal = await open();
  await journal.append(makeEnvelope());
  await journal.tombstone('usage-subject-test-1');
  await journal.close();
  journal = await open({ ownerId: 'next' });
  expect(await journal.isDeletedSubject('usage-subject-test-1')).toBe(true);
  const page = await journal.listSubjectEnvelopes('usage-subject-test-1', null, 100);
  expect(page.items.map((e) => e.event.usageEventId)).toEqual([
    'image_generation:test-call-1:single',
  ]);
});
test('never resets a corrupt journal to an empty healthy database', async () => {
  await fs.writeFile(path.join(directory, 'usage.sqlite'), 'corrupt-not-a-database');
  await expect(open()).rejects.toMatchObject({ code: 'USAGE_JOURNAL_UNAVAILABLE' });
  expect(await fs.readFile(path.join(directory, 'usage.sqlite'), 'utf8')).toBe(
    'corrupt-not-a-database',
  );
});
test('rejects public paths and symlink directories', async () => {
  const publicDir = path.join(directory, 'public', 'usage');
  await expect(open({ directory: publicDir })).rejects.toMatchObject({
    code: 'USAGE_PRIVATE_PATH_REQUIRED',
  });
  const link = path.join(directory, 'link');
  await fs.symlink(directory, link);
  await expect(open({ directory: link })).rejects.toMatchObject({
    code: 'USAGE_PRIVATE_PATH_REQUIRED',
  });
});
test('uses private file permissions and rejects unwriteable directory', async () => {
  const journal = await open();
  expect((await fs.stat(path.join(directory, 'usage.sqlite'))).mode & 0o777).toBe(0o600);
  await journal.close();
  await fs.chmod(directory, 0o500);
  await expect(open()).rejects.toMatchObject({ code: 'USAGE_JOURNAL_UNAVAILABLE' });
  await fs.chmod(directory, 0o700);
});
test('oversized capture is never acknowledged or enqueued', async () => {
  const journal = await open();
  expect(await journal.append(makeEnvelope({ sourceKey: 'x'.repeat(40000) }))).toEqual({
    durableAccepted: false,
    ledgerPersisted: false,
    reason: 'oversize',
  });
  expect((await journal.stats()).pendingCount).toBe(0);
});

test('physical SQLite capacity failure never claims durable acceptance and closes admission', async () => {
  const journal = await open({ maxFileBytes: 65536 });
  let accepted = 0;
  let rejected;
  for (let index = 0; index < 150; index++) {
    const input = makeEnvelope();
    input.sourceKey = `physical-${index}`;
    input.event.usageEventId = `image_generation:physical-${index}:single`;
    const result = await journal.append(input);
    if (!result.durableAccepted) {
      rejected = result;
      break;
    }
    accepted++;
  }
  expect(accepted).toBeGreaterThan(0);
  expect(rejected).toEqual({ durableAccepted: false, ledgerPersisted: false, reason: 'full' });
  expect(await journal.stats()).toMatchObject({ pendingCount: accepted, writable: false });
});
test('restart cleans only expired acknowledged rows and retains pending rows', async () => {
  let time = Date.now();
  let journal = await open({ now: () => time });
  await journal.append(makeEnvelope());
  await journal.append(second());
  const claims = await journal.claim(2);
  const acknowledged = claims.find((c) => c.envelope.sourceKey === 'test-call-1');
  await journal.ack(acknowledged);
  await journal.close();
  time += 86400001;
  journal = await open({ ownerId: 'next', now: () => time });
  expect((await journal.stats()).pendingCount).toBe(1);
  expect(await journal.append(makeEnvelope())).toMatchObject({
    durableAccepted: true,
    ledgerPersisted: false,
  });
  expect((await journal.stats()).pendingCount).toBe(2);
});

test('filesystem ENOSPC is unaccepted and does not leave a pending event', () => {
  const { execFileSync } = require('node:child_process');
  const code = `
    const { openUsageJournal } = require(${JSON.stringify(path.join(__dirname, 'journal.js'))});
    const { makeEnvelope } = require(${JSON.stringify(path.join(__dirname, 'test/fixtures.js'))});
    (async () => {
      const journal = await openUsageJournal({ directory: ${JSON.stringify(directory)} });
      const result = await journal.append(makeEnvelope());
      const stats = await journal.stats();
      await journal.close();
      process.stdout.write(JSON.stringify({ result, stats }));
    })().catch(() => { process.exitCode = 1; });
  `;
  const actual = JSON.parse(
    execFileSync(
      process.execPath,
      ['--require', path.join(__dirname, 'test/diskFullPreload.js'), '-e', code],
      { encoding: 'utf8', timeout: 10000 },
    ),
  );
  expect(actual.result).toEqual({ durableAccepted: false, ledgerPersisted: false, reason: 'full' });
  expect(actual.stats.pendingCount).toBe(0);
  expect(actual.stats.writable).toBe(false);
});

test('physical full health must reject even a small new paid reservation', async () => {
  const journal = await open({ maxFileBytes: 65536 });
  for (let index = 0; index < 150; index++) {
    const envelope = makeEnvelope();
    envelope.event.usageEventId = `full-reservation-${index}`;
    if (!(await journal.append(envelope)).durableAccepted) break;
  }
  expect((await journal.stats()).writable).toBe(false);
  await expect(
    journal.reserve({ key: 'new-paid-call', bytes: 1024, expiresAt: '2026-10-01T00:00:00.000Z' }),
  ).rejects.toMatchObject({ code: 'USAGE_FULL' });
});
test('valid JSON corruption cannot remain retrying or address another ledger key', async () => {
  const { DatabaseSync } = require('node:sqlite');
  let journal = await open();
  await journal.append(makeEnvelope());
  await journal.append(second());
  await journal.close();
  const file = new DatabaseSync(path.join(directory, 'usage.sqlite'));
  file
    .prepare('UPDATE delivery SET envelope=? WHERE event_id=?')
    .run('null', makeEnvelope().event.usageEventId);
  file.close();
  journal = await open({ ownerId: 'next' });
  const claims = await journal.claim(20);
  expect(claims.map((claim) => claim.envelope?.event?.usageEventId)).toEqual([
    second().event.usageEventId,
  ]);
  expect((await journal.stats()).quarantinedCount).toBe(1);
});

test('writer handoff reclaims request-owned reservations but keeps recoverable source reservations', async () => {
  let time = Date.now();
  let journal = await open({ now: () => time });
  await journal.reserve({
    key: 'dead-chat',
    bytes: 4096,
    expiresAt: new Date(time + 86400000).toISOString(),
    scope: 'request',
  });
  await journal.reserve({
    key: 'pending-image',
    bytes: 4096,
    expiresAt: new Date(time + 86400000).toISOString(),
    scope: 'source',
  });
  await journal.append(makeEnvelope());
  await journal.close();
  time += 31001;
  journal = await open({ now: () => time, ownerId: 'replacement' });
  expect((await journal.stats()).reservedBytes).toBe(4096);
  expect((await journal.stats()).pendingCount).toBe(1);
  expect((await journal.listReservations(null, 100)).items.map((item) => item.id)).toEqual([
    'pending-image',
  ]);
});
