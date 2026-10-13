const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// The service imports model bootstrap/email for unrelated report operations.
// Keep real Mongoose models, queries and tenant middleware for this dashboard test.
jest.mock('~/models', () => ({}));
jest.mock('~/server/utils', () => ({
  sendEmail: () => {
    throw new Error('Email must not be used by the dashboard');
  },
}));
process.env.TENANT_ISOLATION_STRICT = 'true';
const { createModels, tenantStorage } = require('@librechat/data-schemas');
const { getUsageDashboard } = require('./UsageReportService');

const NOW = Date.UTC(2026, 8, 21, 4);
const DAY = 86400000;
let mongo;
let returnedEvents;
let commands;
const inTenant = (fn, tenantId = 'dashboard-a') => tenantStorage.run({ tenantId }, fn);
const event = (id, overrides = {}) => ({
  usageEventId: `dashboard-${id}`,
  tenantId: 'dashboard-a',
  userId: null,
  reportingSubjectId: `usr_${id}`,
  occurredAt: new Date(NOW - Number(id) * 1000),
  businessType: 'chat',
  provider: 'mock',
  model: 'mock-text',
  status: 'succeeded',
  inputTokens: 10,
  outputTokens: 2,
  cachedInputTokens: 1,
  cachedOutputTokens: 0,
  imageCount: 0,
  requestCount: 1,
  costCny: 0.01,
  pricingMissing: false,
  metadata: { prompt: 'must not leave the database' },
  ...overrides,
});
function countEvents(value) {
  if (!value || typeof value !== 'object') return 0;
  return (
    Number(Object.hasOwn(value, 'usageEventId')) +
    Object.values(value).reduce((sum, child) => sum + countEvents(child), 0)
  );
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: '8.2.1' } });
  const uri = mongo.getUri('usage-dashboard-tests');
  if (!uri.startsWith('mongodb://127.0.0.1:')) throw new Error('Local isolated Mongo required');
  await mongoose.connect(uri, { autoIndex: false, monitorCommands: true });
  createModels(mongoose);
  await mongoose.models.AIUsageEvent.collection.createIndex({ occurredAt: 1 });
  await mongoose.models.AIUsageEvent.collection.createIndex({ tenantId: 1, occurredAt: 1 });
  mongoose.connection.getClient().on('commandSucceeded', ({ reply }) => {
    returnedEvents += countEvents(reply?.cursor?.firstBatch || reply?.cursor?.nextBatch);
  });
  mongoose.connection.getClient().on('commandStarted', ({ commandName, command }) => {
    if (['aggregate', 'find'].includes(commandName)) commands.push(command);
  });
}, 60000);
afterAll(async () => {
  jest.restoreAllMocks();
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
  delete process.env.TENANT_ISOLATION_STRICT;
});
beforeEach(async () => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  await mongoose.models.AIUsageEvent.collection.deleteMany({});
  await mongoose.models.User.collection.deleteMany({});
  returnedEvents = 0;
  commands = [];
});
afterEach(() => jest.restoreAllMocks());

test('large windows return complete totals without transferring all events to the API', async () => {
  const docs = Array.from({ length: 2000 }, (_, i) => event(i + 1, { model: `mock-${i % 70}` }));
  await mongoose.models.AIUsageEvent.collection.insertMany(docs);
  const result = await inTenant(async () => getUsageDashboard({ hours: 720 }));
  expect(result.totals).toMatchObject({ eventCount: 2000, userCount: 2000, costCny: 20 });
  expect(result.recentEvents).toHaveLength(100);
  expect(result.recentEvents[0].usageEventId).toBe('dashboard-1');
  expect(result.byUser).toHaveLength(50);
  expect(result.byModel).toHaveLength(50);
  // Wire responses from the real Mongo driver: detects loading 2000 then slicing to100.
  expect(returnedEvents).toBeLessThanOrEqual(100);
  expect(commands.every((command) => command.maxTimeMS > 0)).toBe(true);
});

test('keeps statuses, cents rounding, image classification and deleted-user labels', async () => {
  const userId = new mongoose.Types.ObjectId();
  await mongoose.models.User.collection.insertOne({
    _id: userId,
    tenantId: 'dashboard-a',
    name: 'Current User',
    email: 'current@example.test',
    reportingSubjectId: 'usr_current',
    approvalStatus: 'active',
    password: 'not-for-the-report',
  });
  await mongoose.models.AIUsageEvent.collection.insertMany([
    event(1, {
      userId,
      reportingSubjectId: 'usr_current',
      status: 'submitted',
      costCny: 0.005,
      pricingMissing: true,
    }),
    event(2, { userId, reportingSubjectId: 'usr_current', costCny: 1.005 }),
    event(3, {
      reportingSubjectId: 'usr_removed123',
      status: 'failed',
      imageCount: 1,
      costCny: 2.675,
    }),
    event(4, {
      reportingSubjectId: 'usr_removed123',
      status: 'cancelled',
      businessType: 'vision_analysis',
      costCny: 0.0049,
    }),
    event(5, { status: 'status_unknown', businessType: 'white_background', costCny: 0.335 }),
    event(6, { occurredAt: new Date(NOW - 31 * DAY), costCny: 900 }),
    event(7, { tenantId: 'dashboard-b', reportingSubjectId: 'usr_current', costCny: 900 }),
  ]);
  const result = await inTenant(async () => getUsageDashboard({ hours: 720 }));
  expect(result.totals).toEqual({
    eventCount: 5,
    userCount: 3,
    inputTokens: 50,
    outputTokens: 10,
    cachedInputTokens: 5,
    cachedOutputTokens: 0,
    imageCount: 1,
    requestCount: 5,
    costCny: 4.03,
    textCostCny: 1.01,
    imageCostCny: 3.02,
    failedCount: 2,
    statusCounts: { submitted: 1, succeeded: 1, failed: 1, cancelled: 1, status_unknown: 1 },
  });
  expect(result.byUser[0]).toMatchObject({
    reportingSubjectId: 'usr_removed123',
    name: '已删除用户 #MOVED123',
    email: '',
    costCny: 2.68,
  });
  expect(result.byUser.find((u) => u.reportingSubjectId === 'usr_current')).toMatchObject({
    name: 'Current User',
    email: 'current@example.test',
    userId: String(userId),
    costCny: 1.01,
  });
  expect(result.recentEvents[0].pricingMissing).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/must not leave|metadata|not-for-the-report|password/);
  const filtered = await inTenant(async () =>
    getUsageDashboard({ userId: String(userId), hours: 720 }),
  );
  expect(filtered.totals).toMatchObject({ eventCount: 2, userCount: 1, costCny: 1.01 });
});

test('an empty window remains empty and strict tenant context cannot be bypassed', async () => {
  const empty = await inTenant(async () => getUsageDashboard());
  expect(empty.totals).toMatchObject({ eventCount: 0, userCount: 0, costCny: 0 });
  expect(empty.recentEvents).toEqual([]);
  expect(empty.byUser).toEqual([]);
  await expect(getUsageDashboard()).rejects.toThrow(/tenant context/);
  await expect(inTenant(async () => getUsageDashboard({ hours: 721 }))).rejects.toMatchObject({
    status: 400,
  });
});

test('uses existing time indexes without a full-window blocking sort', async () => {
  await mongoose.models.AIUsageEvent.collection.insertMany(
    Array.from({ length: 1000 }, (_, i) => event(i + 1)),
  );
  await inTenant(async () => getUsageDashboard());
  const command = commands.find((entry) => entry.aggregate === 'aiusageevents');
  const plan = await inTenant(async () =>
    mongoose.models.AIUsageEvent.aggregate(command.pipeline).explain('queryPlanner'),
  );
  const winning = plan.stages[0].$cursor.queryPlanner.winningPlan;
  const stages = [];
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.stage) stages.push(value.stage);
    Object.values(value).forEach(inspect);
  }
  inspect(winning);
  expect(stages).toContain('IXSCAN');
  expect(stages).not.toContain('SORT');
});

test('reports a bounded query timeout instead of returning partial zero totals', async () => {
  jest.spyOn(mongoose.models.AIUsageEvent.collection, 'aggregate').mockImplementationOnce(() => {
    throw Object.assign(new Error('database execution time exceeded'), { code: 50 });
  });
  await expect(inTenant(async () => getUsageDashboard())).rejects.toMatchObject({ status: 504 });
});

test('does not label an existing user with a blank name as deleted', async () => {
  const userId = new mongoose.Types.ObjectId();
  await mongoose.models.User.collection.insertOne({
    _id: userId,
    tenantId: 'dashboard-a',
    name: '',
    email: 'existing@example.test',
  });
  await mongoose.models.AIUsageEvent.collection.insertOne(event(1, { userId }));
  const result = await inTenant(async () => getUsageDashboard());
  expect(result.byUser[0]).toMatchObject({ name: '', email: 'existing@example.test' });
});

test('keeps repeated reads stable for tied timestamps and uses the latest user reference', async () => {
  const oldUserId = new mongoose.Types.ObjectId();
  const newUserId = new mongoose.Types.ObjectId();
  await mongoose.models.User.collection.insertMany([
    { _id: oldUserId, tenantId: 'dashboard-a', name: 'Old User' },
    { _id: newUserId, tenantId: 'dashboard-a', name: 'Latest User' },
  ]);
  await mongoose.models.AIUsageEvent.collection.insertMany([
    event(1, {
      _id: new mongoose.Types.ObjectId('000000000000000000000001'),
      occurredAt: new Date(NOW),
      reportingSubjectId: 'usr_shared',
      userId: oldUserId,
    }),
    event(2, {
      _id: new mongoose.Types.ObjectId('000000000000000000000002'),
      occurredAt: new Date(NOW),
      reportingSubjectId: 'usr_shared',
      userId: newUserId,
    }),
    event(3, {
      _id: new mongoose.Types.ObjectId('000000000000000000000003'),
      occurredAt: new Date(NOW),
      costCny: 0.02,
    }),
  ]);
  const first = await inTenant(async () => getUsageDashboard());
  const second = await inTenant(async () => getUsageDashboard());
  expect(second).toEqual(first);
  expect(first.recentEvents.map((e) => e.usageEventId)).toEqual([
    'dashboard-3',
    'dashboard-2',
    'dashboard-1',
  ]);
  expect(first.byUser.map((u) => u.reportingSubjectId)).toEqual(['usr_3', 'usr_shared']);
  expect(first.byUser[1].name).toBe('Latest User');
});

test('preserves half-cent floating point boundaries and treats missing costs as zero', async () => {
  await mongoose.models.AIUsageEvent.collection.insertMany([
    event(1, { costCny: 0.004999999999999999 }),
    event(2, { costCny: 0.005 }),
    event(3, { costCny: 0.014999999999999998 }),
    event(4, { costCny: 0.015 }),
    event(5, { costCny: null }),
  ]);
  const result = await inTenant(async () => getUsageDashboard());
  expect(result.totals.costCny).toBe(0.04);
  expect(
    Object.fromEntries(result.byUser.map((row) => [row.reportingSubjectId, row.costCny])),
  ).toEqual({ usr_1: 0, usr_2: 0.01, usr_3: 0.01, usr_4: 0.02, usr_5: 0 });
});

test('bounds wire payload with 100000 events while retaining all usage totals', async () => {
  for (let offset = 0; offset < 100000; offset += 5000) {
    await mongoose.models.AIUsageEvent.collection.insertMany(
      Array.from({ length: 5000 }, (_, i) =>
        event(offset + i + 1, {
          reportingSubjectId: `usr_${(offset + i) % 1500}`,
          model: `mock-${i % 80}`,
        }),
      ),
    );
  }
  const result = await inTenant(async () => getUsageDashboard({ hours: 720 }));
  expect(result.totals).toMatchObject({
    eventCount: 100000,
    userCount: 1500,
    costCny: 1000,
    inputTokens: 1000000,
  });
  expect(result.recentEvents).toHaveLength(100);
  expect(result.byUser).toHaveLength(50);
  expect(result.byModel).toHaveLength(50);
  expect(returnedEvents).toBe(100);
}, 60000);

test('only fetches user profiles for the displayed leaderboard', async () => {
  const users = Array.from({ length: 150 }, (_, i) => ({
    _id: new mongoose.Types.ObjectId(),
    tenantId: 'dashboard-a',
    name: `User ${i}`,
    email: `u${i}@example.test`,
  }));
  await mongoose.models.User.collection.insertMany(users);
  await mongoose.models.AIUsageEvent.collection.insertMany(
    users.map((u, i) => event(i + 1, { userId: u._id })),
  );
  const result = await inTenant(async () => getUsageDashboard());
  expect(result.byUser).toHaveLength(50);
  expect(result.byUser[0].name).toBe('User 0');
  const userQuery = commands.find((command) => command.find === 'users');
  expect(userQuery.filter._id.$in).toHaveLength(50);
  expect(userQuery.maxTimeMS).toBeGreaterThan(0);
});
