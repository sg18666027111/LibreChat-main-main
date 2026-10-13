const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { createUsageSourceStore } = require('./sourceStore');
const { makeEnvelope } = require('./test/fixtures');
const { runDryRun, parseOptions } = require('../../../../config/reconcile-usage-delivery');
let server, client, db, store;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri(), { monitorCommands: true });
  await client.connect();
  db = client.db('o03-fixture');
  store = createUsageSourceStore(db);
});
afterAll(async () => {
  await client?.close();
  await server?.stop();
});
beforeEach(async () => {
  await db.dropDatabase();
});
const stamp = new Date('2026-09-20T00:00:00.000Z');
const cutover = '2026-09-19T00:00:00.000Z';
function row(id = new ObjectId()) {
  return {
    _id: id,
    createdAt: stamp,
    updatedAt: stamp,
    payload: { prompt: 'private input' },
    usageDelivery: {
      state: 'pending',
      revision: 1,
      envelope: makeEnvelope(),
      cleanupAfter: '2026-09-21T00:00:00.000Z',
    },
  };
}
test('stable compound cursor returns each source once, with no business content projection', async () => {
  const ids = [new ObjectId(), new ObjectId(), new ObjectId()];
  await db.collection('imagegenerationjobs').insertMany(ids.map(row));
  let after = null;
  const seen = [];
  do {
    const result = await store.readPage({ source: 'image', mode: 'new', cutover, limit: 1, after });
    seen.push(...result.items.map((item) => item.id));
    expect(JSON.stringify(result)).not.toContain('private input');
    after = result.cursor;
  } while (after);
  expect(seen).toEqual(ids.map(String));
});
test('late acknowledgements cannot downgrade persisted state or mark a replaced attempt', async () => {
  const source = row();
  await db.collection('imagegenerationjobs').insertOne(source);
  const item = (await store.readPage({ source: 'image', mode: 'new', cutover, limit: 1 })).items[0];
  await store.acknowledge(item, 'persisted');
  await store.acknowledge(item, 'durable');
  expect(
    (await db.collection('imagegenerationjobs').findOne({ _id: source._id })).usageDelivery.state,
  ).toBe('persisted');
  await db.collection('imagegenerationjobs').updateOne(
    { _id: source._id },
    {
      $set: {
        'usageDelivery.state': 'pending',
        'usageDelivery.envelope.event.usageEventId': 'new-attempt',
      },
    },
  );
  await store.acknowledge(item, 'persisted');
  expect(
    (await db.collection('imagegenerationjobs').findOne({ _id: source._id })).usageDelivery.state,
  ).toBe('pending');
});
test('native historical dry-run performs only read commands and explicitly reports truncation', async () => {
  await db.collection('imagegenerationjobs').insertMany([row(), row()]);
  const commands = [];
  const observe = (event) => commands.push(event.commandName);
  client.on('commandStarted', observe);
  try {
    const report = await runDryRun({
      db,
      options: { since: cutover, until: '2026-09-22T00:00:00.000Z', limit: 1 },
      now: () => +stamp,
    });
    expect(report.complete).toBe(false);
    expect(report.sources.image.counts.missing).toBe(1);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => ['find', 'getMore', 'killCursors'].includes(command))).toBe(
      true,
    );
  } finally {
    client.off('commandStarted', observe);
  }
});
test.each(
  [
    [],
    ['--since=2026-09-01T00:00:00.000Z'],
    ['--dry-run', '--write'],
    ['--dry-run', '--limit=101'],
  ].map((args) => [args]),
)('CLI rejects unsafe or incomplete arguments before connecting: %j', (args) => {
  expect(() => parseOptions(args)).toThrow();
});
test('CLI writes a private report without loading application models or logging connection details', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { promisify } = require('node:util');
  const execFile = promisify(require('node:child_process').execFile);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'o03-report-'));
  const output = path.join(directory, 'report.json');
  try {
    await db
      .collection('transactions')
      .insertOne({ createdAt: stamp, updatedAt: stamp, tokenType: 'prompt', rawAmount: -7 });
    const result = await execFile(
      process.execPath,
      [
        path.resolve(__dirname, '../../../../config/reconcile-usage-delivery.js'),
        '--dry-run',
        `--since=${cutover}`,
        '--until=2026-09-22T00:00:00.000Z',
        '--limit=100',
        `--output=${output}`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          MONGO_URI: server.getUri('o03-fixture'),
        },
      },
    );
    const report = JSON.parse(await fs.readFile(output, 'utf8'));
    expect((await fs.stat(output)).mode & 0o777).toBe(0o600);
    expect(report.sources.transaction.counts.insufficient_evidence).toBe(1);
    expect(report.sources.transaction.details[0].knownCounts.inputTokens).toBe(7);
    expect(result.stdout).not.toContain('mongodb:');
    expect(result.stderr).toBe('');
    expect(await db.collection('aiusageevents').countDocuments()).toBe(0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test('past business retention only private recovery evidence remains when capture is still unavailable', async () => {
  const source = row();
  source.status = 'succeeded';
  source.result = { images: [{ b64_json: 'large-private-image' }] };
  source.usageDelivery.cleanupAfter = '2026-09-20T01:00:00.000Z';
  await db.collection('imagegenerationjobs').insertOne(source);
  const item = (await store.readPage({ source: 'image', mode: 'new', cutover, limit: 100 }))
    .items[0];
  await store.pruneExpiredPayload(item, Date.parse('2026-09-21T00:00:00.000Z'));
  const kept = await db.collection('imagegenerationjobs').findOne({ _id: source._id });
  expect(kept.payload).toBeUndefined();
  expect(kept.result).toBeUndefined();
  expect(kept.usageDelivery.envelope).toEqual(source.usageDelivery.envelope);
  expect(kept.usageDelivery.payloadPruned).toBe(true);
});
test.each([
  ['succeeded', '2026-09-22T00:00:00.000Z'],
  ['running', '2026-09-20T01:00:00.000Z'],
])('payload cleanup preserves %s source with retention %s', async (status, cleanupAfter) => {
  const source = row();
  source.status = status;
  source.usageDelivery.cleanupAfter = cleanupAfter;
  await db.collection('imagegenerationjobs').insertOne(source);
  const item = (await store.readPage({ source: 'image', mode: 'new', cutover, limit: 100 }))
    .items[0];
  await store.pruneExpiredPayload(item, Date.parse('2026-09-21T00:00:00.000Z'));
  const kept = await db.collection('imagegenerationjobs').findOne({ _id: source._id });
  expect(kept.payload).toEqual(source.payload);
  expect(kept.usageDelivery.payloadPruned).toBeUndefined();
});
