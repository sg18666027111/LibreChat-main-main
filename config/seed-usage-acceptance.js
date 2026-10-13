const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { createModels, createMethods } = require('../packages/data-schemas');

const ACCEPTANCE_DB = 'librechat_usage_acceptance';
const DEFAULT_URI = `mongodb://127.0.0.1:27038/${ACCEPTANCE_DB}`;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function assertLocalAcceptanceUri(uri) {
  const parsed = new URL(uri);
  const host = parsed.hostname;
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    throw new Error('Usage acceptance seed refuses non-local MongoDB hosts.');
  }
  if (dbName !== ACCEPTANCE_DB) {
    throw new Error(`Usage acceptance seed requires database name ${ACCEPTANCE_DB}.`);
  }
}

function getPassword() {
  const password = process.env.USAGE_ACCEPTANCE_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error(
      'Set USAGE_ACCEPTANCE_PASSWORD to a local test password with at least 12 chars.',
    );
  }
  return password;
}

function createReportingSubjectId(label = '') {
  const suffix = crypto.randomUUID().replace(/-/g, '');
  return `usr_${label ? `${label}_` : ''}${suffix}`;
}

async function upsertUser(User, input, passwordHash) {
  return User.findOneAndUpdate(
    { email: input.email },
    {
      $set: {
        name: input.name,
        username: input.username,
        email: input.email,
        provider: 'local',
        role: input.role,
        isSuperAdmin: input.isSuperAdmin,
        approvalStatus: input.approvalStatus,
        emailVerified: true,
        password: passwordHash,
        sessionVersion: 0,
      },
      $setOnInsert: {
        reportingSubjectId: input.reportingSubjectId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

function eventTime(windowStart, dayOffset, minutesAfterStart = 60) {
  return new Date(windowStart.getTime() - dayOffset * DAY_MS + minutesAfterStart * 60 * 1000);
}

function getShanghaiUsageReportWindow(now = new Date()) {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const endLocal = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 10, 0, 0, 0),
  );
  if (shifted.getUTCHours() < 10) {
    endLocal.setUTCDate(endLocal.getUTCDate() - 1);
  }
  const windowEnd = new Date(endLocal.getTime() - SHANGHAI_OFFSET_MS);
  return {
    windowStart: new Date(windowEnd.getTime() - DAY_MS),
    windowEnd,
  };
}

async function seedPrices(methods) {
  const prices = [
    {
      provider: 'openai',
      model: 'gpt-5-mini',
      businessType: 'chat',
      inputPriceCnyPer1K: 0.2,
      outputPriceCnyPer1K: 0.8,
    },
    {
      provider: 'siliconflow',
      model: 'Pro/moonshotai/Kimi-K2.6',
      businessType: 'vision_analysis',
      inputPriceCnyPer1K: 0.1,
      outputPriceCnyPer1K: 0.3,
    },
    {
      provider: 'apimart',
      model: 'gpt-image-2',
      businessType: 'image_generation',
      imagePriceCny: 1.5,
      requestPriceCny: 0.2,
    },
    {
      provider: 'apimart',
      model: 'gpt-image-2',
      businessType: 'multi_reference_generation',
      imagePriceCny: 1.8,
      requestPriceCny: 0.2,
    },
    {
      provider: 'apimart',
      model: 'gpt-image-2',
      businessType: 'product_replacement',
      imagePriceCny: 2,
      requestPriceCny: 0.3,
    },
    {
      provider: 'siliconflow',
      model: 'Kwai-Kolors/Kolors',
      businessType: 'white_background',
      imagePriceCny: 0.8,
      requestPriceCny: 0.1,
    },
    {
      provider: 'ark',
      model: 'doubao-seedream-5-0-pro-260628',
      businessType: 'batch_image_generation',
      imagePriceCny: 1.2,
      requestPriceCny: 0.1,
    },
    {
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
      businessType: 'main_image_generation',
      imagePriceCny: 2.5,
      requestPriceCny: 0.2,
    },
    {
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
      businessType: 'detail_page_generation',
      imagePriceCny: 2.5,
      requestPriceCny: 0.2,
    },
    {
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
      businessType: 'canvas_generation',
      imagePriceCny: 2,
      requestPriceCny: 0.2,
    },
  ];

  for (const price of prices) {
    await methods.upsertAIModelPrice({ ...price, active: true });
  }
}

async function seedUsageEvents({ methods, users, reportNow, deletedSubjectId }) {
  const window = getShanghaiUsageReportWindow(reportNow);
  const employeeOne = users['usage.employee1@example.test'];
  const employeeTwo = users['usage.employee2@example.test'];
  const employeeThree = users['usage.employee3@example.test'];

  for (let offset = 1; offset <= 7; offset += 1) {
    await methods.recordAIUsageEvent({
      usageEventId: `usage-acceptance-history-employee1-${offset}`,
      userId: employeeOne._id,
      businessType: 'chat',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'succeeded',
      costCny: 5,
      occurredAt: eventTime(window.windowStart, offset, 30),
    });
  }

  await methods.recordAIUsageEvent({
    usageEventId: 'usage-acceptance-previous-employee2',
    userId: employeeTwo._id,
    businessType: 'image_generation',
    provider: 'apimart',
    model: 'gpt-image-2',
    status: 'succeeded',
    imageCount: 2,
    requestCount: 1,
    occurredAt: eventTime(window.windowStart, 1, 90),
  });

  const currentEvents = [
    {
      usageEventId: 'usage-acceptance-current-chat-spike',
      userId: employeeOne._id,
      businessType: 'chat',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'succeeded',
      costCny: 25,
      inputTokens: 60_000,
      outputTokens: 15_000,
      occurredAt: eventTime(window.windowStart, 0, 30),
    },
    {
      usageEventId: 'usage-acceptance-current-vision',
      userId: employeeTwo._id,
      businessType: 'vision_analysis',
      provider: 'siliconflow',
      model: 'Pro/moonshotai/Kimi-K2.6',
      status: 'succeeded',
      inputTokens: 8_000,
      outputTokens: 2_000,
      occurredAt: eventTime(window.windowStart, 0, 45),
    },
    {
      usageEventId: 'usage-acceptance-current-image',
      userId: employeeTwo._id,
      businessType: 'image_generation',
      provider: 'apimart',
      model: 'gpt-image-2',
      status: 'failed',
      imageCount: 1,
      requestCount: 1,
      occurredAt: eventTime(window.windowStart, 0, 60),
    },
    {
      usageEventId: 'usage-acceptance-current-product-replace',
      userId: employeeTwo._id,
      businessType: 'product_replacement',
      provider: 'apimart',
      model: 'gpt-image-2',
      status: 'cancelled',
      imageCount: 1,
      requestCount: 1,
      occurredAt: eventTime(window.windowStart, 0, 75),
    },
    {
      usageEventId: 'usage-acceptance-current-white-background',
      userId: employeeThree._id,
      businessType: 'white_background',
      provider: 'siliconflow',
      model: 'Kwai-Kolors/Kolors',
      status: 'succeeded',
      imageCount: 1,
      requestCount: 1,
      occurredAt: eventTime(window.windowStart, 0, 90),
    },
    {
      usageEventId: 'usage-acceptance-current-batch',
      userId: employeeThree._id,
      businessType: 'batch_image_generation',
      provider: 'ark',
      model: 'doubao-seedream-5-0-pro-260628',
      status: 'succeeded',
      imageCount: 1,
      requestCount: 1,
      batchId: 'usage-acceptance-batch',
      itemId: 'item-1',
      occurredAt: eventTime(window.windowStart, 0, 105),
    },
    {
      usageEventId: 'usage-acceptance-current-main-image',
      userId: employeeThree._id,
      businessType: 'main_image_generation',
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
      status: 'status_unknown',
      imageCount: 1,
      requestCount: 1,
      actionRunId: 'usage-acceptance-action-run',
      itemId: 'slot-1',
      occurredAt: eventTime(window.windowStart, 0, 120),
    },
    {
      usageEventId: 'usage-acceptance-current-unpriced',
      userId: employeeThree._id,
      businessType: 'multi_reference_generation',
      provider: 'unpriced-provider',
      model: 'unpriced-model',
      status: 'succeeded',
      imageCount: 1,
      requestCount: 1,
      occurredAt: eventTime(window.windowStart, 0, 135),
    },
  ];

  for (const event of currentEvents) {
    await methods.recordAIUsageEvent(event);
  }

  await mongoose.models.AIUsageEvent.updateOne(
    { usageEventId: 'usage-acceptance-current-deleted-detail-page' },
    {
      $setOnInsert: {
        usageEventId: 'usage-acceptance-current-deleted-detail-page',
        userId: null,
        reportingSubjectId: deletedSubjectId,
        businessType: 'detail_page_generation',
        provider: 'fal',
        model: 'openai/gpt-image-2/edit',
        status: 'succeeded',
        imageCount: 1,
        requestCount: 1,
        costCny: 12.5,
        currency: 'CNY',
        pricingMissing: false,
        pricingSnapshot: {
          provider: 'fal',
          model: 'openai/gpt-image-2/edit',
          businessType: 'detail_page_generation',
          imagePriceCny: 2.5,
          requestPriceCny: 0.2,
          currency: 'CNY',
        },
        anonymizedAt: new Date(),
        occurredAt: eventTime(window.windowStart, 0, 150),
        expiresAt: new Date(eventTime(window.windowStart, 0, 150).getTime() + 30 * DAY_MS),
      },
    },
    { upsert: true },
  );

  return window;
}

async function main() {
  const mongoUri = process.env.MONGO_URI || DEFAULT_URI;
  assertLocalAcceptanceUri(mongoUri);

  await mongoose.connect(mongoUri);
  createModels(mongoose);
  const methods = createMethods(mongoose);

  if (process.argv.includes('--clean')) {
    await mongoose.connection.dropDatabase();
    console.log(`Cleaned local usage acceptance database ${ACCEPTANCE_DB}.`);
    await mongoose.disconnect();
    return;
  }

  const passwordHash = bcrypt.hashSync(getPassword(), 10);
  const User = mongoose.models.User;
  const seedUsers = [
    {
      email: 'usage.super@example.test',
      name: 'Usage Super Admin',
      username: 'usage-super',
      role: 'ADMIN',
      isSuperAdmin: true,
      approvalStatus: 'active',
      reportingSubjectId: createReportingSubjectId('super'),
    },
    {
      email: 'usage.admin@example.test',
      name: 'Usage Admin',
      username: 'usage-admin',
      role: 'ADMIN',
      isSuperAdmin: false,
      approvalStatus: 'active',
      reportingSubjectId: createReportingSubjectId('admin'),
    },
    {
      email: 'usage.employee1@example.test',
      name: 'Usage Employee One',
      username: 'usage-employee1',
      role: 'USER',
      isSuperAdmin: false,
      approvalStatus: 'active',
      reportingSubjectId: createReportingSubjectId('employee1'),
    },
    {
      email: 'usage.employee2@example.test',
      name: 'Usage Employee Two',
      username: 'usage-employee2',
      role: 'USER',
      isSuperAdmin: false,
      approvalStatus: 'active',
      reportingSubjectId: createReportingSubjectId('employee2'),
    },
    {
      email: 'usage.employee3@example.test',
      name: 'Usage Employee Three',
      username: 'usage-employee3',
      role: 'USER',
      isSuperAdmin: false,
      approvalStatus: 'active',
      reportingSubjectId: createReportingSubjectId('employee3'),
    },
  ];

  const users = {};
  for (const user of seedUsers) {
    users[user.email] = await upsertUser(User, user, passwordHash);
  }

  await seedPrices(methods);
  await mongoose.models.UsageReportSettings.findOneAndUpdate(
    { key: 'daily_usage_report' },
    {
      $set: {
        key: 'daily_usage_report',
        enabled: true,
        recipients: ['usage-owner@example.test', 'usage-finance@example.test'],
        thresholdCostCny: 20,
        updatedBy: users['usage.super@example.test']._id,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const reportNow = process.env.USAGE_ACCEPTANCE_NOW
    ? new Date(process.env.USAGE_ACCEPTANCE_NOW)
    : new Date('2026-07-31T02:05:00.000Z');
  const deletedSubjectId = 'usr_deleted_usage_acceptance_1';
  const window = await seedUsageEvents({ methods, users, reportNow, deletedSubjectId });
  const report = await methods.generateDailyUsageReport({ now: reportNow });
  await mongoose.models.UsageReportDelivery.findOneAndUpdate(
    { periodKey: report.periodKey, recipientEmailNormalized: 'usage-owner@example.test' },
    {
      $set: {
        reportId: report._id,
        periodKey: report.periodKey,
        recipientEmail: 'usage-owner@example.test',
        recipientEmailNormalized: 'usage-owner@example.test',
        status: 'sent',
        lastSentAt: new Date(),
        lastAttemptAt: new Date(),
      },
      $inc: { attemptCount: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await mongoose.models.UsageReportDelivery.findOneAndUpdate(
    { periodKey: report.periodKey, recipientEmailNormalized: 'usage-finance@example.test' },
    {
      $set: {
        reportId: report._id,
        periodKey: report.periodKey,
        recipientEmail: 'usage-finance@example.test',
        recipientEmailNormalized: 'usage-finance@example.test',
        status: 'failed',
        lastError: 'fixture smtp failure',
        lastAttemptAt: new Date(),
      },
      $inc: { attemptCount: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const counts = {
    users: await mongoose.models.User.countDocuments(),
    usageEvents: await mongoose.models.AIUsageEvent.countDocuments(),
    reports: await mongoose.models.UsageReport.countDocuments(),
    deliveries: await mongoose.models.UsageReportDelivery.countDocuments(),
    prices: await mongoose.models.AIModelPrice.countDocuments(),
  };

  console.log(
    JSON.stringify(
      {
        database: ACCEPTANCE_DB,
        mongoUri: mongoUri.replace(/\/\/([^@/]+@)?/, '//'),
        reportNow: reportNow.toISOString(),
        windowStart: window.windowStart.toISOString(),
        windowEnd: window.windowEnd.toISOString(),
        reportPeriodKey: report.periodKey,
        deletedSubjectId,
        counts,
        users: seedUsers.map(({ email, role, isSuperAdmin, approvalStatus }) => ({
          email,
          role,
          isSuperAdmin,
          approvalStatus,
        })),
        password: 'USAGE_ACCEPTANCE_PASSWORD environment variable',
        cleanup: 'npm run seed:usage-acceptance -- --clean',
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
