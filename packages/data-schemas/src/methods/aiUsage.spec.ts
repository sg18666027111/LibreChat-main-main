import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import {
  aiUsageBusinessTypes,
  createAIUsageMethods,
  getDeletedUsageSubjectLabel,
  getShanghaiUsageReportWindow,
} from './aiUsage';
import type { IAIUsageEvent, IUsageReport, IUser } from '~/types';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let User: mongoose.Model<IUser>;
let AIUsageEvent: mongoose.Model<IAIUsageEvent>;
let UsageReport: mongoose.Model<IUsageReport>;
let methods: ReturnType<typeof createAIUsageMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', port: 27217 } });
  await mongoose.connect(mongoServer.getUri());

  const models = createModels(mongoose);
  Object.assign(mongoose.models, models);

  User = mongoose.models.User;
  AIUsageEvent = mongoose.models.AIUsageEvent;
  UsageReport = mongoose.models.UsageReport;
  methods = createAIUsageMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    AIUsageEvent.deleteMany({}),
    UsageReport.deleteMany({}),
    mongoose.models.AIModelPrice.deleteMany({}),
    mongoose.models.UsageReportSettings.deleteMany({}),
    mongoose.models.UsageReportDelivery.deleteMany({}),
  ]);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('AI usage ledger', () => {
  test('exposes every P1 paid business type explicitly', () => {
    expect(aiUsageBusinessTypes).toEqual([
      'chat',
      'vision_analysis',
      'image_generation',
      'multi_reference_generation',
      'product_replacement',
      'white_background',
      'batch_image_generation',
      'canvas_generation',
      'main_image_generation',
      'detail_page_generation',
      'other',
    ]);
  });

  test('keeps deleted-user display labels distinct when reporting subjects share a prefix', () => {
    expect(getDeletedUsageSubjectLabel('usr_deleted_usage_acceptance_2')).toBe(
      '已删除用户 #EPTANCE2',
    );
    expect(getDeletedUsageSubjectLabel('usr_deleted_usage_acceptance_3')).toBe(
      '已删除用户 #EPTANCE3',
    );
  });

  test('records usage events idempotently with a stable reporting subject and CNY pricing', async () => {
    const user = await User.create({
      name: 'Usage User',
      email: 'usage@example.com',
      provider: 'local',
    });

    await methods.upsertAIModelPrice({
      provider: 'openai',
      model: 'gpt-5-mini',
      businessType: 'chat',
      inputPriceCnyPer1K: 0.2,
      outputPriceCnyPer1K: 0.8,
      active: true,
    });

    const event = await methods.recordAIUsageEvent({
      usageEventId: 'chat-msg-1-prompt',
      userId: user._id,
      businessType: 'chat',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'succeeded',
      inputTokens: 1000,
      outputTokens: 500,
      occurredAt: new Date('2026-07-30T04:00:00.000Z'),
      metadata: {
        prompt: 'this should never be persisted',
        safe: 'kept',
      },
    });

    const duplicate = await methods.recordAIUsageEvent({
      usageEventId: 'chat-msg-1-prompt',
      userId: user._id,
      businessType: 'chat',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'failed',
      inputTokens: 999999,
      outputTokens: 999999,
      occurredAt: new Date('2026-07-30T05:00:00.000Z'),
    });

    expect(event).toBeTruthy();
    expect(duplicate).toBeTruthy();
    if (!event || !duplicate) {
      throw new Error('usage event should have been recorded');
    }
    expect(duplicate._id.toString()).toBe(event._id.toString());
    expect(await AIUsageEvent.countDocuments()).toBe(1);
    expect(event.reportingSubjectId).toMatch(/^usr_/);
    expect(event.costCny).toBeCloseTo(0.6);
    expect(event.pricingMissing).toBe(false);
    expect(event.metadata).toEqual({ safe: 'kept' });

    const updatedUser = await User.findById(user._id).lean();
    expect(updatedUser?.reportingSubjectId).toBe(event.reportingSubjectId);
  });

  test('marks Fal GPT Image 2 pricing missing instead of reusing APIMart pricing', async () => {
    const user = await User.create({
      name: 'Fal Image Usage',
      email: 'fal-image-usage@example.com',
      provider: 'local',
    });

    await methods.upsertAIModelPrice({
      provider: 'apimart',
      model: 'gpt-image-2',
      businessType: 'image_generation',
      imagePriceCny: 1.25,
      active: true,
    });

    const event = await methods.recordAIUsageEvent({
      usageEventId: 'fal-gpt-image-2-text-1',
      userId: user._id,
      businessType: 'image_generation',
      provider: 'fal',
      model: 'openai/gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      status: 'succeeded',
      requestCount: 1,
      imageCount: 1,
      occurredAt: new Date('2026-08-13T10:00:00.000Z'),
    });

    expect(event).toMatchObject({
      provider: 'fal',
      model: 'openai/gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      businessType: 'image_generation',
      imageCount: 1,
      costCny: 0,
      pricingMissing: true,
    });
    expect(event?.pricingSnapshot).toBeUndefined();
  });

  test('updates the original usage event when late actual provider usage arrives', async () => {
    const user = await User.create({
      name: 'Late Usage',
      email: 'late-usage@example.com',
      provider: 'local',
    });

    await methods.upsertAIModelPrice({
      provider: 'apimart',
      model: 'gpt-image-2',
      businessType: 'image_generation',
      imagePriceCny: 1.25,
      requestPriceCny: 0.5,
      active: true,
    });

    const submitted = await methods.recordAIUsageEvent({
      usageEventId: 'provider-request-late-actual',
      userId: user._id,
      businessType: 'image_generation',
      provider: 'apimart',
      model: 'gpt-image-2',
      status: 'submitted',
      requestCount: 1,
      imageCount: 1,
      occurredAt: new Date('2026-07-30T04:00:00.000Z'),
      metadata: { providerTaskId: 'task_pending' },
    });

    const updated = await methods.recordAIUsageEvent({
      usageEventId: 'provider-request-late-actual',
      userId: user._id,
      businessType: 'image_generation',
      provider: 'apimart',
      model: 'gpt-image-2',
      status: 'succeeded',
      requestCount: 1,
      imageCount: 2,
      occurredAt: new Date('2026-07-30T04:00:00.000Z'),
      metadata: { providerTaskId: 'task_done', safeResultCount: 2 },
    });

    expect(submitted).toBeTruthy();
    expect(updated).toBeTruthy();
    if (!submitted || !updated) {
      throw new Error('late provider usage should update the submitted event');
    }
    expect(updated._id.toString()).toBe(submitted._id.toString());
    expect(
      await AIUsageEvent.countDocuments({ usageEventId: 'provider-request-late-actual' }),
    ).toBe(1);
    const stored = await AIUsageEvent.findOne({
      usageEventId: 'provider-request-late-actual',
    }).lean();
    expect(stored?.status).toBe('succeeded');
    expect(stored?.imageCount).toBe(2);
    expect(stored?.costCny).toBeCloseTo(3);
    expect(stored?.pricingSnapshot?.imagePriceCny).toBe(1.25);
    expect(stored?.metadata).toEqual({ providerTaskId: 'task_done', safeResultCount: 2 });
  });

  test('uses the price effective at the event time and does not silently reprice missing snapshots', async () => {
    const user = await User.create({
      name: 'Historical Price',
      email: 'historical-price@example.com',
      provider: 'local',
    });

    await methods.upsertAIModelPrice({
      provider: 'openai',
      model: 'gpt-5-mini',
      businessType: 'chat',
      requestPriceCny: 1,
      effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
      active: true,
    });
    await methods.upsertAIModelPrice({
      provider: 'openai',
      model: 'gpt-5-mini',
      businessType: 'chat',
      requestPriceCny: 9,
      effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
      active: true,
    });

    const historicalEvent = await methods.recordAIUsageEvent({
      usageEventId: 'historical-price-event',
      userId: user._id,
      businessType: 'chat',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'succeeded',
      requestCount: 1,
      occurredAt: new Date('2026-07-30T04:00:00.000Z'),
    });

    expect(historicalEvent?.costCny).toBe(1);
    expect(historicalEvent?.pricingSnapshot?.requestPriceCny).toBe(1);

    const missingPriceEvent = await methods.recordAIUsageEvent({
      usageEventId: 'missing-price-stays-missing',
      userId: user._id,
      businessType: 'vision_analysis',
      provider: 'future-provider',
      model: 'future-model',
      status: 'submitted',
      requestCount: 1,
      occurredAt: new Date('2026-07-30T04:00:00.000Z'),
    });
    expect(missingPriceEvent?.pricingMissing).toBe(true);

    await methods.upsertAIModelPrice({
      provider: 'future-provider',
      model: 'future-model',
      businessType: 'vision_analysis',
      requestPriceCny: 99,
      effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
      active: true,
    });
    const updatedMissingPriceEvent = await methods.recordAIUsageEvent({
      usageEventId: 'missing-price-stays-missing',
      userId: user._id,
      businessType: 'vision_analysis',
      provider: 'future-provider',
      model: 'future-model',
      status: 'succeeded',
      requestCount: 1,
      occurredAt: new Date('2026-07-30T04:00:00.000Z'),
    });

    expect(updatedMissingPriceEvent?.pricingMissing).toBe(true);
    expect(updatedMissingPriceEvent?.costCny).toBe(0);
    expect(updatedMissingPriceEvent?.pricingSnapshot).toBeUndefined();
  });

  test('generates Shanghai 10:00 daily reports for the previous 24 hours', async () => {
    const user = await User.create({
      name: 'Reporter',
      email: 'reporter@example.com',
      provider: 'local',
    });

    const reportNow = new Date('2026-07-31T02:00:00.000Z');
    const window = getShanghaiUsageReportWindow(reportNow);

    expect(window.periodKey).toBe('2026-07-31@Asia/Shanghai');
    expect(window.windowStart.toISOString()).toBe('2026-07-30T02:00:00.000Z');
    expect(window.windowEnd.toISOString()).toBe('2026-07-31T02:00:00.000Z');

    await methods.recordAIUsageEvent({
      usageEventId: 'left-boundary',
      userId: user._id,
      businessType: 'chat',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'succeeded',
      inputTokens: 10,
      outputTokens: 20,
      occurredAt: new Date('2026-07-30T02:00:00.000Z'),
    });

    await methods.recordAIUsageEvent({
      usageEventId: 'inside-window',
      userId: user._id,
      businessType: 'image_generation',
      provider: 'apimart',
      model: 'gpt-image-2',
      status: 'succeeded',
      imageCount: 2,
      costCny: 1.25,
      occurredAt: new Date('2026-07-30T10:30:00.000Z'),
    });

    await methods.recordAIUsageEvent({
      usageEventId: 'right-boundary',
      userId: user._id,
      businessType: 'chat',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'succeeded',
      inputTokens: 999,
      outputTokens: 999,
      occurredAt: new Date('2026-07-31T02:00:00.000Z'),
    });

    const report = await methods.generateDailyUsageReport({ now: reportNow });

    expect(await UsageReport.countDocuments()).toBe(1);
    expect(report.periodKey).toBe('2026-07-31@Asia/Shanghai');
    expect(report.windowStart.toISOString()).toBe('2026-07-30T02:00:00.000Z');
    expect(report.windowEnd.toISOString()).toBe('2026-07-31T02:00:00.000Z');
    expect(report.totals.eventCount).toBe(2);
    expect(report.totals.inputTokens).toBe(10);
    expect(report.totals.outputTokens).toBe(20);
    expect(report.totals.imageCount).toBe(2);
    expect(report.totals.costCny).toBeCloseTo(1.25);
    expect(report.byUser).toHaveLength(1);
    expect(report.byUser[0].email).toBe('reporter@example.com');

    const duplicate = await methods.generateDailyUsageReport({ now: reportNow });
    expect(duplicate._id.toString()).toBe(report._id.toString());
    expect(await UsageReport.countDocuments()).toBe(1);
  });

  test('supports status_unknown while preserving existing failed reporting semantics', async () => {
    const user = await User.create({
      name: 'Unknown Status',
      email: 'unknown@example.com',
      provider: 'local',
    });

    await methods.recordAIUsageEvent({
      usageEventId: 'unknown-status-event',
      userId: user._id,
      businessType: 'chat',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'status_unknown',
      costCny: 0.75,
      occurredAt: new Date('2026-07-30T04:00:00.000Z'),
    });

    const report = await methods.generateDailyUsageReport({
      now: new Date('2026-07-31T02:00:00.000Z'),
    });

    expect(report.totals.eventCount).toBe(1);
    expect(report.totals.failedCount).toBe(1);
    const stored = await AIUsageEvent.findOne({ usageEventId: 'unknown-status-event' }).lean();
    expect(stored?.status).toBe('status_unknown');
    expect(stored?.expiresAt).toBeInstanceOf(Date);
  });

  test('generates business rankings, status counts, comparisons, seven-window averages, and anomaly snapshots', async () => {
    const user = await User.create({
      name: 'Spike User',
      email: 'spike@example.com',
      provider: 'local',
      reportingSubjectId: 'usr_spike_random',
    });
    const steadyUser = await User.create({
      name: 'Steady User',
      email: 'steady@example.com',
      provider: 'local',
      reportingSubjectId: 'usr_steady_random',
    });

    await mongoose.models.UsageReportSettings.create({
      key: 'daily_usage_report',
      enabled: true,
      recipients: ['owner@example.com'],
      thresholdCostCny: 20,
    });

    const reportNow = new Date('2026-07-31T02:00:00.000Z');
    const window = getShanghaiUsageReportWindow(reportNow);

    for (let dayOffset = 1; dayOffset <= 7; dayOffset += 1) {
      await methods.recordAIUsageEvent({
        usageEventId: `history-${dayOffset}`,
        userId: user._id,
        businessType: 'chat',
        provider: 'openai',
        model: 'gpt-5-mini',
        status: 'succeeded',
        costCny: 5,
        occurredAt: new Date(
          window.windowStart.getTime() - dayOffset * 24 * 60 * 60 * 1000 + 60_000,
        ),
      });
    }

    await methods.recordAIUsageEvent({
      usageEventId: 'previous-window-event',
      userId: steadyUser._id,
      businessType: 'chat',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'succeeded',
      costCny: 10,
      occurredAt: new Date(window.windowStart.getTime() - 60_000),
    });
    await methods.recordAIUsageEvent({
      usageEventId: 'current-spike-main-image',
      userId: user._id,
      businessType: 'main_image_generation',
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
      status: 'succeeded',
      imageCount: 1,
      requestCount: 1,
      costCny: 21,
      occurredAt: new Date(window.windowStart.getTime() + 60_000),
    });
    await methods.recordAIUsageEvent({
      usageEventId: 'current-cancelled-canvas',
      userId: steadyUser._id,
      businessType: 'canvas_generation',
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
      status: 'cancelled',
      imageCount: 1,
      requestCount: 1,
      costCny: 2,
      occurredAt: new Date(window.windowStart.getTime() + 120_000),
    });
    await methods.recordAIUsageEvent({
      usageEventId: 'current-unknown-unpriced',
      userId: steadyUser._id,
      businessType: 'detail_page_generation',
      provider: 'missing-provider',
      model: 'missing-model',
      status: 'status_unknown',
      imageCount: 1,
      requestCount: 1,
      occurredAt: new Date(window.windowStart.getTime() + 180_000),
    });

    const report = await methods.generateDailyUsageReport({ now: reportNow });
    expect(report.comparison).toBeTruthy();
    if (!report.comparison) {
      throw new Error('daily report should include comparison data');
    }

    expect(report.byBusiness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          businessType: 'main_image_generation',
          costCny: 21,
          imageCount: 1,
        }),
        expect.objectContaining({
          businessType: 'canvas_generation',
          costCny: 2,
          imageCount: 1,
        }),
        expect.objectContaining({
          businessType: 'detail_page_generation',
          eventCount: 1,
          imageCount: 1,
        }),
      ]),
    );
    expect(report.totals.statusCounts).toEqual(
      expect.objectContaining({
        succeeded: 1,
        cancelled: 1,
        status_unknown: 1,
      }),
    );
    expect(report.totals.failedCount).toBe(1);
    expect(report.missingPricingCount).toBe(1);
    expect(report.comparison.previousWindow).toEqual(
      expect.objectContaining({
        costCny: 15,
        costCnyDelta: 8,
        costCnyPercentChange: 53.33,
        hasComparableCostBase: true,
      }),
    );
    expect(report.comparison.sevenWindowAverage.windowCount).toBe(7);
    expect(report.comparison.sevenWindowAverage.costCny).toBeCloseTo(6.43);
    expect(report.comparison.sevenWindowAverage.perUserCostCny).toBeCloseTo(5.63);
    expect(report.comparison.sevenWindowAverage.insufficientHistory).toBe(false);
    expect(report.anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'seven_window_spike',
          reportingSubjectId: 'usr_spike_random',
          currentCostCny: 21,
          baselineCostCny: 5,
        }),
        expect.objectContaining({
          type: 'fixed_amount_threshold',
          reportingSubjectId: 'usr_spike_random',
          currentCostCny: 21,
          thresholdSnapshotCny: 20,
        }),
      ]),
    );
  });

  test('marks comparison percent as unavailable when the previous 24h base is zero', async () => {
    const user = await User.create({
      name: 'No Base',
      email: 'nobase@example.com',
      provider: 'local',
    });
    const window = getShanghaiUsageReportWindow(new Date('2026-07-31T02:00:00.000Z'));
    await methods.recordAIUsageEvent({
      usageEventId: 'current-only-cost',
      userId: user._id,
      businessType: 'chat',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'succeeded',
      costCny: 1.5,
      occurredAt: new Date(window.windowStart.getTime() + 60_000),
    });

    const report = await methods.generateDailyUsageReport({
      now: new Date('2026-07-31T02:00:00.000Z'),
    });
    expect(report.comparison).toBeTruthy();
    if (!report.comparison) {
      throw new Error('daily report should include comparison data');
    }

    expect(report.comparison.previousWindow).toEqual(
      expect.objectContaining({
        costCny: 0,
        costCnyDelta: 1.5,
        costCnyPercentChange: null,
        hasComparableCostBase: false,
      }),
    );
    expect(report.comparison.sevenWindowAverage).toEqual(
      expect.objectContaining({
        windowCount: 0,
        insufficientHistory: true,
      }),
    );
  });

  test('anonymizes deleted-user usage and historical reports without merging subjects', async () => {
    // Keep the fixed historical report within retention without faking MongoDB timers.
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
        'hrtime',
      ],
    });
    jest.setSystemTime(new Date('2026-07-31T03:00:00.000Z'));

    const user = await User.create({
      name: 'Delete Me',
      email: 'delete-me@example.com',
      avatar: '/images/avatar.png',
      provider: 'local',
      reportingSubjectId: 'usr_delete_me_random',
    });

    await methods.upsertAIModelPrice({
      provider: 'openai',
      model: 'gpt-5-mini',
      businessType: 'chat',
      requestPriceCny: 1,
      active: true,
    });
    await methods.recordAIUsageEvent({
      usageEventId: 'deleted-user-event',
      userId: user._id,
      businessType: 'chat',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'succeeded',
      requestCount: 2,
      occurredAt: new Date('2026-07-30T04:00:00.000Z'),
      metadata: {
        userEmail: 'delete-me@example.com',
        userName: 'Delete Me',
        profile: {
          userSnapshot: {
            email: 'delete-me@example.com',
            name: 'Delete Me',
            avatar: 'https://example.test/avatar.png',
          },
          costCenter: 'operations',
        },
        safeBillingRef: 'bill-1',
      },
    });
    await methods.recordAIUsageEvent({
      usageEventId: 'other-deleted-user-event',
      reportingSubjectId: 'usr_other_random',
      userId: null,
      businessType: 'chat',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'succeeded',
      costCny: 3,
      occurredAt: new Date('2026-07-30T04:30:00.000Z'),
    });
    await mongoose.models.UsageReportSettings.create({
      key: 'daily_usage_report',
      enabled: true,
      thresholdCostCny: 1,
    });
    await methods.generateDailyUsageReport({ now: new Date('2026-07-31T02:00:00.000Z') });

    await methods.anonymizeUsageForDeletedUser({
      userId: user._id,
      reportingSubjectId: 'usr_delete_me_random',
      now: new Date('2026-07-31T03:00:00.000Z'),
    });
    await methods.anonymizeUsageReportsForDeletedUser({
      userId: user._id,
      reportingSubjectId: 'usr_delete_me_random',
    });

    const event = await AIUsageEvent.findOne({ usageEventId: 'deleted-user-event' }).lean();
    expect(event?.userId).toBeNull();
    expect(event?.costCny).toBeCloseTo(2);
    expect(event?.pricingSnapshot?.requestPriceCny).toBe(1);
    expect(event?.metadata).toEqual({
      profile: { costCenter: 'operations' },
      safeBillingRef: 'bill-1',
    });

    const report = await UsageReport.findOne({ periodKey: '2026-07-31@Asia/Shanghai' }).lean();
    const deletedRow = report?.byUser.find(
      (row) => row.reportingSubjectId === 'usr_delete_me_random',
    );
    const otherRow = report?.byUser.find((row) => row.reportingSubjectId === 'usr_other_random');
    expect(deletedRow).toEqual(
      expect.objectContaining({
        reportingSubjectId: 'usr_delete_me_random',
        name: getDeletedUsageSubjectLabel('usr_delete_me_random'),
      }),
    );
    expect(deletedRow?.userId).toBeUndefined();
    expect(deletedRow?.email).toBeUndefined();
    expect(otherRow?.name).toBe(getDeletedUsageSubjectLabel('usr_other_random'));
    expect(report?.byUser).toHaveLength(2);
    const deletedAnomalies = report?.anomalies.filter(
      (row) => row.reportingSubjectId === 'usr_delete_me_random',
    );
    expect(deletedAnomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reportingSubjectId: 'usr_delete_me_random',
          name: getDeletedUsageSubjectLabel('usr_delete_me_random'),
        }),
      ]),
    );
    expect(deletedAnomalies?.every((row) => !row.userId && !row.email)).toBe(true);
  });
});
