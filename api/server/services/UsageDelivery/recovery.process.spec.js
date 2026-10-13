const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { makeEnvelope } = require('./test/fixtures');
let server, client, db, directory, children, uri;
let sequence = 0;
const time = Date.now();
const report = [];
const input = (name, revision = 1) => {
  const envelope = makeEnvelope({
    sourceKey: name,
    revision,
    occurredAt: new Date(time - 60000).toISOString(),
    expiresAt: new Date(time - 60000 + 30 * 86400000).toISOString(),
  });
  envelope.event.usageEventId = `image_generation:${name}:single`;
  return envelope;
};
async function start(extra = {}) {
  const child = fork(path.join(__dirname, 'test/recoveryChild.js'), [], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: extra.pauseCommit
      ? ['--require', path.join(__dirname, 'test/commitPausePreload.js')]
      : [],
  });
  let serial = 0,
    stderr = '';
  const pending = new Map(),
    history = new Map(),
    waiters = new Map();
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString().slice(0, 2000);
  });
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(new Error(`Fixture exited ${code}/${signal}: ${stderr.slice(-800)}`));
      }
      pending.clear();
      resolve({ code, signal });
    }),
  );
  child.on('message', (message) => {
    if (message.event) {
      history.set(message.event, (history.get(message.event) || 0) + 1);
      waiters.get(message.event)?.();
    } else {
      const call = pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer);
      pending.delete(message.id);
      if (message.error)
        call.reject(Object.assign(new Error(message.error), { code: message.error }));
      else call.resolve(message.result);
    }
  });
  const handle = {
    exited,
    send(op, data) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Fixture timed out: ${op}; ${stderr.slice(-800)}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, op, data });
      });
    },
    waitFor(event) {
      if (history.has(event)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing barrier ${event}`)), 10000);
        waiters.set(event, () => {
          clearTimeout(timer);
          waiters.delete(event);
          resolve();
        });
      });
    },
    async kill() {
      child.kill('SIGKILL');
      return exited;
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        await this.send('exit');
        await exited;
      }
    },
  };
  children.push(handle);
  handle.versions = await handle.send('start', { directory, mongoUri: uri, time, ...extra });
  return handle;
}
async function restart(previous, extra = {}) {
  await previous.kill();
  return start({ time: time + 31001, ...extra });
}
async function rows() {
  return db.collection('aiusageevents').find({}).toArray();
}
async function assertCounters() {
  expect(
    JSON.parse(await fs.readFile(path.join(directory, 'fixture-counters.json'), 'utf8')),
  ).toEqual({ provider: 1, balance: 1 });
}
beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  client = new MongoClient(server.getUri());
  await client.connect();
});
afterAll(async () => {
  await client?.close();
  await server?.stop();
  if (process.env.O03_TEST_REPORT)
    await fs.writeFile(process.env.O03_TEST_REPORT, JSON.stringify(report, null, 2));
});
beforeEach(async () => {
  const database = `o03_process_${++sequence}`;
  uri = server.getUri(database);
  db = client.db(database);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'o03-process-'));
  children = [];
});
afterEach(async () => {
  for (const child of children) await child.kill();
  await db.dropDatabase();
  await fs.chmod(directory, 0o700);
  await fs.rm(directory, { recursive: true, force: true });
});
test('Mongo unavailable, confirmed journal commit and SIGKILL recover exactly once', async () => {
  let child = await start();
  await child.send('offline');
  await child.send('capture', { envelope: input('offline') });
  await child.waitFor('journal_committed');
  await child.send('runOnce');
  expect((await child.send('stats')).pendingCount).toBe(1);
  child = await restart(child);
  await child.send('runOnce');
  expect(await rows()).toHaveLength(1);
  expect((await child.send('stats')).pendingCount).toBe(0);
  report.push({
    case: 'offline_restart',
    ...child.versions,
    recovered: 1,
    ...(await child.send('stats')),
  });
});
test('SIGKILL after Mongo commit before journal ack is an idempotent replay', async () => {
  let child = await start();
  await child.send('capture', { envelope: input('ack-gap') });
  await child.send('pauseAt', { event: 'ledger_committed' });
  const running = child.send('runOnce').catch(() => {});
  await child.waitFor('ledger_committed');
  child = await restart(child);
  await running;
  await child.send('runOnce');
  expect(await rows()).toHaveLength(1);
  expect((await child.send('stats')).pendingCount).toBe(0);
});
test('source commit before journal append survives SIGKILL without another provider or balance write', async () => {
  let child = await start();
  await child.send('pauseAt', { event: 'source_committed' });
  const pending = child.send('source', { envelope: input('source-gap') }).catch(() => {});
  await child.waitFor('source_committed');
  child = await restart(child);
  await pending;
  await child.send('reconcile');
  await child.send('runOnce');
  await child.send('reconcile');
  expect(await rows()).toHaveLength(1);
  expect((await db.collection('imagegenerationjobs').findOne()).usageDelivery.state).toBe(
    'persisted',
  );
  await assertCounters();
});
test('out-of-order competing revisions retain the newest successful quantities', async () => {
  const child = await start();
  const older = input('revision'),
    latest = input('revision', 2);
  latest.event.imageCount = 2;
  const lateSubmitted = input('revision', 3);
  lateSubmitted.event.status = 'submitted';
  lateSubmitted.event.imageCount = 0;
  await Promise.all(
    [latest, older, lateSubmitted].map((envelope) => child.send('capture', { envelope })),
  );
  await child.send('runOnce');
  const [row] = await rows();
  expect(row.deliveryRevision).toBe(2);
  expect(row.imageCount).toBe(2);
  expect(row.status).toBe('succeeded');
});
test('expired writer resumes but cannot ack after replacement owns the journal', async () => {
  const old = await start();
  await old.send('capture', { envelope: input('fence') });
  const [claim] = await old.send('claim');
  const current = await start({ time: time + 31001 });
  await expect(old.send('ack', { claim })).rejects.toMatchObject({ code: 'USAGE_WRITER_FENCED' });
  await current.send('runOnce');
  expect(await rows()).toHaveLength(1);
});
test('real SQLite page exhaustion rejects admission and preserves all confirmed records across restart', async () => {
  let child = await start({ maxFileBytes: 65536 });
  let accepted = 0;
  for (let index = 0; index < 150; index++) {
    const result = await child.send('capture', { envelope: input(`capacity-${index}`) });
    if (!result.durableAccepted) {
      expect(result.reason).toBe('full');
      break;
    }
    accepted++;
  }
  expect(accepted).toBeGreaterThan(0);
  expect((await child.send('stats')).writable).toBe(false);
  await expect(
    child.send('reserve', { key: 'paid', bytes: 1024, expiresAt: '2026-10-01T00:00:00.000Z' }),
  ).rejects.toMatchObject({ code: 'USAGE_FULL' });
  child = await restart(child, { maxFileBytes: 65536 });
  for (let index = 0; index < Math.ceil(accepted / 20); index++) await child.send('runOnce');
  expect(await rows()).toHaveLength(accepted);
  expect((await child.send('stats')).pendingCount).toBe(0);
});
test('read-only directory rejects startup without discarding confirmed data', async () => {
  let child = await start();
  await child.send('capture', { envelope: input('readonly') });
  await child.close();
  await fs.chmod(directory, 0o500);
  await expect(start()).rejects.toMatchObject({ code: 'USAGE_JOURNAL_UNAVAILABLE' });
  await fs.chmod(directory, 0o700);
  child = await start();
  await child.send('runOnce');
  expect(await rows()).toHaveLength(1);
});
test('persisted deletion tombstone survives SIGKILL and late replay stays anonymous', async () => {
  let child = await start();
  const envelope = input('deleted');
  await child.send('capture', { envelope });
  await child.send('tombstone', { subject: envelope.reportingSubjectId });
  await child.waitFor('deletion_tombstoned');
  child = await restart(child);
  await child.send('runOnce');
  const [row] = await rows();
  expect(row.userId).toBeNull();
  expect(row.reportingSubjectId).toBe(envelope.reportingSubjectId);
});
test('job, batch and transaction observations recover one canonical event without spending again', async () => {
  const child = await start();
  const envelope = input('canonical');
  for (const collection of ['imagegenerationjobs', 'imagebatchtasks', 'transactions'])
    await child.send('source', { envelope, collection });
  await child.send('reconcile');
  await child.send('runOnce');
  await child.send('reconcile');
  expect(await rows()).toHaveLength(1);
  await assertCounters();
});
test('changed model price cannot change a captured snapshot after restart', async () => {
  let child = await start();
  const envelope = input('price');
  envelope.pricing = { kind: 'snapshot', snapshot: { currency: 'CNY', imagePriceCny: 0.25 } };
  await child.send('capture', { envelope });
  await db.collection('aimodelprices').insertOne({
    provider: 'fixture',
    model: 'fixture-image',
    imagePriceCny: 999,
    currency: 'CNY',
    effectiveFrom: new Date('2026-09-01'),
  });
  child = await restart(child);
  await child.send('runOnce');
  const [row] = await rows();
  expect(row.costCny).toBe(0.25);
  expect(row.pricingSnapshot.imagePriceCny).toBe(0.25);
});
test('corrupt JSON values, oversize records and expired events are isolated while normal events recover', async () => {
  let child = await start();
  const expired = input('expired');
  expired.occurredAt = new Date(time - 31 * 86400000).toISOString();
  expired.expiresAt = new Date(time - 86400000).toISOString();
  for (const envelope of [input('corrupt'), input('oversize'), expired, input('normal')])
    await child.send('capture', { envelope });
  await child.close();
  const sqlite = new DatabaseSync(path.join(directory, 'usage.sqlite'));
  sqlite
    .prepare('UPDATE delivery SET envelope=? WHERE event_id=?')
    .run('null', input('corrupt').event.usageEventId);
  sqlite
    .prepare('UPDATE delivery SET envelope=? WHERE event_id=?')
    .run(
      JSON.stringify({ ...input('oversize'), sourceKey: 'x'.repeat(40000) }),
      input('oversize').event.usageEventId,
    );
  sqlite.close();
  child = await start();
  await child.send('runOnce');
  expect((await rows()).map((row) => row.usageEventId)).toEqual([
    input('normal').event.usageEventId,
  ]);
  expect(await child.send('stats')).toMatchObject({ pendingCount: 3, quarantinedCount: 3 });
});
test('shutdown with stalled ledger exits within budget and unacknowledged work recovers', async () => {
  let child = await start();
  await child.send('capture', { envelope: input('drain') });
  await child.send('pauseAt', { event: 'ledger_started' });
  const running = child.send('runOnce').catch(() => {});
  await child.waitFor('ledger_started');
  const began = Date.now();
  await child.close();
  await running;
  expect(Date.now() - began).toBeLessThan(8000);
  child = await start({ time: time + 31001 });
  await child.send('runOnce');
  expect(await rows()).toHaveLength(1);
});

test('SIGKILL during uncommitted SQLite transaction never acknowledges it and preserves prior commit', async () => {
  let child = await start();
  await child.send('capture', { envelope: input('already-confirmed') });
  await child.close();
  child = await start({ pauseCommit: true });
  let accepted = false;
  const pending = child.send('capture', { envelope: input('uncommitted') }).then(
    (r) => {
      accepted = r.durableAccepted;
    },
    () => {},
  );
  await child.waitFor('sqlite_before_commit');
  child = await restart(child);
  await pending;
  expect(accepted).toBe(false);
  await child.send('runOnce');
  expect((await rows()).map((row) => row.usageEventId)).toEqual([
    input('already-confirmed').event.usageEventId,
  ]);
});
test('bounded fixture throughput records footprint and recovers every accepted event', async () => {
  const child = await start();
  const began = performance.now();
  for (let index = 0; index < 40; index++)
    expect(
      (await child.send('capture', { envelope: input(`load-${index}`) })).durableAccepted,
    ).toBe(true);
  const captureMs = performance.now() - began;
  const before = await child.send('stats');
  const physicalBytes = (await fs.stat(path.join(directory, 'usage.sqlite'))).size;
  await child.send('runOnce');
  await child.send('runOnce');
  expect(await rows()).toHaveLength(40);
  expect((await child.send('stats')).pendingCount).toBe(0);
  report.push({
    case: 'bounded_load',
    ...child.versions,
    accepted: 40,
    recovered: 40,
    physicalBytes,
    captureMs,
    ...before,
  });
});

test('SIGKILL reclaims abandoned request and unowned source capacity but protects an active image', async () => {
  let child = await start();
  for (const [key, scope] of [
    ['request', 'request'],
    ['orphan', 'source'],
    ['active-image', 'source'],
  ])
    await child.send('reserve', {
      key,
      scope,
      bytes: 65536,
      expiresAt: new Date(time + 30 * 86400000).toISOString(),
    });
  const active = input('active-image', 0);
  active.event.status = 'submitted';
  active.event.imageCount = 0;
  await child.send('source', {
    envelope: active,
    status: 'running',
    reservationId: 'active-image',
  });
  child = await restart(child);
  expect((await child.send('stats')).reservedBytes).toBe(131072);
  await child.send('reconcile');
  const remaining = (await child.send('stats')).reservedBytes;
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThanOrEqual(65536);
});
test('expired quarantined evidence permits deletion after SIGKILL without restoring billable data', async () => {
  let child = await start();
  const expired = input('expired-deletion');
  expired.occurredAt = new Date(time - 31 * 86400000).toISOString();
  expired.expiresAt = new Date(time - 86400000).toISOString();
  await child.send('capture', { envelope: expired });
  await child.send('runOnce');
  child = await restart(child);
  await child.send('delete', { subject: expired.reportingSubjectId });
  const [seal] = await rows();
  expect(seal.deliveryTombstone).toBe(true);
  expect(seal.userId).toBeNull();
  expect(seal.occurredAt).toBeUndefined();
  expect((await child.send('stats')).quarantinedCount).toBe(1);
});
