const mongoose = require('mongoose');

jest.mock('@librechat/data-schemas', () => ({
  runAsSystem: jest.fn((fn) => fn()),
}));
jest.mock('~/models', () => ({
  generateDailyUsageReport: jest.fn(),
  getUsageReportSettings: jest.fn(),
  upsertAIModelPrice: jest.fn(),
}));
jest.mock('~/server/utils', () => ({
  sendEmail: jest.fn(),
}));

const {
  getUsageDashboard,
  getUsageReport,
  getUsageReportDetails,
  listUsageReports,
  resendUsageReportEmail,
  retryUsageReportEmail,
  sendUsageReportEmail,
} = require('./UsageReportService');
const { sendEmail } = require('~/server/utils');

function queryChain(result) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn(async () => result),
  };
}

describe('UsageReportService 30-day query limits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mongoose.models.AIUsageEvent = {
      find: jest.fn(() => queryChain([])),
    };
    mongoose.models.User = {
      find: jest.fn(() => ({ select: jest.fn().mockReturnThis(), lean: jest.fn(async () => []) })),
    };
    mongoose.models.UsageReport = {
      find: jest.fn(() => queryChain([])),
      findOne: jest.fn(() => ({ lean: jest.fn(async () => null) })),
    };
  });

  it('rejects dashboard windows longer than 30 days', async () => {
    await expect(getUsageDashboard({ hours: 24 * 31 })).rejects.toMatchObject({ status: 400 });
    expect(mongoose.models.AIUsageEvent.find).not.toHaveBeenCalled();
  });

  it('filters report lists to the last 30 days before applying limit', async () => {
    await listUsageReports({ limit: 100 });

    const filter = mongoose.models.UsageReport.find.mock.calls[0][0];
    expect(filter.windowEnd.$gte).toBeInstanceOf(Date);
  });

  it('does not fetch a report detail older than the 30-day window', async () => {
    await getUsageReport('2026-06-01@Asia/Shanghai');

    const filter = mongoose.models.UsageReport.findOne.mock.calls[0][0];
    expect(filter).toEqual(
      expect.objectContaining({
        periodKey: '2026-06-01@Asia/Shanghai',
        windowEnd: expect.objectContaining({ $gte: expect.any(Date) }),
      }),
    );
  });

  it('returns report details without selecting raw event metadata', async () => {
    const report = {
      periodKey: '2026-07-31@Asia/Shanghai',
      windowStart: new Date('2026-07-30T02:00:00.000Z'),
      windowEnd: new Date('2026-07-31T02:00:00.000Z'),
    };
    const eventSelect = jest.fn().mockReturnThis();
    mongoose.models.UsageReport.findOne = jest.fn(() => ({ lean: jest.fn(async () => report) }));
    mongoose.models.UsageReportDelivery = {
      find: jest.fn(() => queryChain([])),
    };
    mongoose.models.AIUsageEvent = {
      find: jest.fn(() => ({
        sort: jest.fn().mockReturnThis(),
        select: eventSelect,
        lean: jest.fn(async () => []),
      })),
    };

    const result = await getUsageReportDetails('2026-07-31@Asia/Shanghai');

    expect(result).toEqual({ report, deliveries: [], events: [] });
    expect(eventSelect.mock.calls[0][0]).not.toContain('metadata');
    expect(eventSelect.mock.calls[0][0]).not.toContain('prompt');
    expect(eventSelect.mock.calls[0][0]).not.toContain('message');
  });
});

describe('UsageReportService email delivery records', () => {
  const report = {
    _id: 'report-1',
    periodKey: '2026-07-31@Asia/Shanghai',
    windowStart: new Date('2026-07-30T02:00:00.000Z'),
    windowEnd: new Date('2026-07-31T02:00:00.000Z'),
    totals: {
      eventCount: 3,
      userCount: 2,
      inputTokens: 100,
      outputTokens: 50,
      imageCount: 1,
      costCny: 12.34,
    },
    missingPricingCount: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EMAIL_HOST = 'smtp.example.test';
    process.env.EMAIL_FROM = 'no-reply@example.test';
    mongoose.models.UsageReport = {
      findOne: jest.fn(() => ({ lean: jest.fn(async () => report) })),
      updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
    };
    mongoose.models.UsageReportDelivery = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(async () => ({})),
    };
  });

  afterEach(() => {
    delete process.env.EMAIL_HOST;
    delete process.env.EMAIL_FROM;
  });

  it('retries failed recipients only without sending to already successful or new recipients', async () => {
    require('~/models').getUsageReportSettings.mockResolvedValue({
      enabled: true,
      recipients: ['sent@example.com', ' failed@example.com ', 'new@example.com'],
    });
    const existing = new Map([
      ['sent@example.com', { status: 'sent' }],
      ['failed@example.com', { status: 'failed', lastError: 'previous failure' }],
    ]);
    mongoose.models.UsageReportDelivery.findOne.mockImplementation(
      ({ recipientEmailNormalized }) => ({
        lean: jest.fn(async () => existing.get(recipientEmailNormalized) || null),
      }),
    );
    sendEmail.mockResolvedValueOnce({ messageId: 'retry-ok' });

    const result = await retryUsageReportEmail(report.periodKey);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls.map(([args]) => args.email)).toEqual(['failed@example.com']);
    expect(result.delivery.sent).toBe(true);
    expect(result.delivery.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: 'sent@example.com',
          skipped: true,
          reason: 'already_sent',
        }),
        expect.objectContaining({ email: 'failed@example.com', ok: true }),
        expect.objectContaining({
          email: 'new@example.com',
          skipped: true,
          reason: 'not_failed',
        }),
      ]),
    );
    const failedClaim = mongoose.models.UsageReportDelivery.findOneAndUpdate.mock.calls.find(
      ([filter, update]) =>
        filter.recipientEmailNormalized === 'failed@example.com' &&
        update.$set?.status === 'sending',
    );
    expect(failedClaim).toBeTruthy();
    expect(failedClaim?.[1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'sending' }),
        $inc: expect.objectContaining({ attemptCount: 1 }),
      }),
    );
    expect(failedClaim?.[2]).toEqual(expect.objectContaining({ upsert: false }));
    expect(mongoose.models.UsageReportDelivery.findOneAndUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ recipientEmailNormalized: 'new@example.com' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('records explicit manual resend attempts without logging sensitive report content', async () => {
    require('~/models').getUsageReportSettings.mockResolvedValue({
      enabled: true,
      recipients: ['sent@example.com'],
    });
    mongoose.models.UsageReportDelivery.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ status: 'sent' })),
    });
    sendEmail.mockResolvedValue({ messageId: 'manual-ok' });

    await sendUsageReportEmail(report, {
      manualResend: true,
      actor: { id: 'root-user' },
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        email: 'sent@example.com',
        payload: expect.not.objectContaining({
          prompt: expect.anything(),
          messages: expect.anything(),
          password: expect.anything(),
          image: expect.anything(),
        }),
      }),
    );
    const manualClaim = mongoose.models.UsageReportDelivery.findOneAndUpdate.mock.calls.find(
      ([filter, update]) =>
        filter.recipientEmailNormalized === 'sent@example.com' && update.$set?.status === 'sending',
    );
    expect(manualClaim?.[1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'sending',
          lastManualResendBy: 'root-user',
        }),
        $inc: expect.objectContaining({
          attemptCount: 1,
          manualResendCount: 1,
        }),
      }),
    );
    expect(manualClaim?.[2]).toEqual(expect.objectContaining({ upsert: false }));
  });

  it('finds the retained report before performing a manual resend', async () => {
    require('~/models').getUsageReportSettings.mockResolvedValue({
      enabled: true,
      recipients: ['owner@example.com'],
    });
    mongoose.models.UsageReportDelivery.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ status: 'failed', lastError: 'smtp rejected' })),
    });
    sendEmail.mockResolvedValue({ messageId: 'manual-ok' });

    const result = await resendUsageReportEmail(report.periodKey, { id: 'root-user' });

    expect(mongoose.models.UsageReport.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        periodKey: report.periodKey,
        windowEnd: expect.objectContaining({ $gte: expect.any(Date) }),
      }),
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(result.delivery).toEqual(expect.objectContaining({ sent: true }));
    const resendClaim = mongoose.models.UsageReportDelivery.findOneAndUpdate.mock.calls.find(
      ([filter, update]) =>
        filter.recipientEmailNormalized === 'owner@example.com' &&
        update.$set?.status === 'sending',
    );
    expect(resendClaim?.[1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'sending',
          lastManualResendBy: 'root-user',
        }),
        $inc: expect.objectContaining({
          attemptCount: 1,
          manualResendCount: 1,
        }),
      }),
    );
    expect(resendClaim?.[2]).toEqual(expect.objectContaining({ upsert: false }));
  });

  it('returns not_configured and does not call the mailer when no SMTP or Mailgun provider is configured', async () => {
    delete process.env.EMAIL_HOST;
    delete process.env.EMAIL_FROM;
    require('~/models').getUsageReportSettings.mockResolvedValue({
      enabled: true,
      recipients: ['owner@example.com'],
    });
    mongoose.models.UsageReportDelivery.findOne.mockReturnValue({
      lean: jest.fn(async () => null),
    });

    const result = await sendUsageReportEmail(report);

    expect(result).toEqual(expect.objectContaining({ sent: false, reason: 'not_configured' }));
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mongoose.models.UsageReportDelivery.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        periodKey: report.periodKey,
        recipientEmailNormalized: 'owner@example.com',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'not_configured' }),
        $inc: expect.objectContaining({ attemptCount: 1 }),
      }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('keeps successful recipients untouched when retrying with no SMTP configured', async () => {
    delete process.env.EMAIL_HOST;
    delete process.env.EMAIL_FROM;
    require('~/models').getUsageReportSettings.mockResolvedValue({
      enabled: true,
      recipients: ['sent@example.com', 'failed@example.com'],
    });
    mongoose.models.UsageReportDelivery.findOne.mockImplementation(
      ({ recipientEmailNormalized }) => ({
        lean: jest.fn(async () =>
          recipientEmailNormalized === 'sent@example.com'
            ? { status: 'sent' }
            : { status: 'failed', lastError: 'previous failure' },
        ),
      }),
    );

    const result = await sendUsageReportEmail(report);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: 'sent@example.com',
          skipped: true,
          reason: 'already_sent',
        }),
        expect.objectContaining({
          email: 'failed@example.com',
          ok: false,
          reason: 'not_configured',
        }),
      ]),
    );
    expect(mongoose.models.UsageReportDelivery.findOneAndUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ recipientEmailNormalized: 'sent@example.com' }),
      expect.anything(),
      expect.anything(),
    );
    expect(mongoose.models.UsageReportDelivery.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        periodKey: report.periodKey,
        recipientEmailNormalized: 'failed@example.com',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'not_configured' }),
        $inc: expect.objectContaining({ attemptCount: 1 }),
      }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('claims a sending lease before calling the SMTP provider', async () => {
    require('~/models').getUsageReportSettings.mockResolvedValue({
      enabled: true,
      recipients: ['owner@example.com'],
    });
    mongoose.models.UsageReportDelivery.findOne.mockReturnValue({
      lean: jest.fn(async () => null),
    });
    mongoose.models.UsageReportDelivery.findOneAndUpdate
      .mockResolvedValueOnce({ status: 'sending' })
      .mockResolvedValueOnce({ status: 'sent' });
    sendEmail.mockResolvedValue({ messageId: 'sent-once' });

    await sendUsageReportEmail(report);

    expect(mongoose.models.UsageReportDelivery.findOneAndUpdate.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'sending' }),
      }),
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('does not send when another worker already owns the delivery lease', async () => {
    require('~/models').getUsageReportSettings.mockResolvedValue({
      enabled: true,
      recipients: ['owner@example.com'],
    });
    mongoose.models.UsageReportDelivery.findOne.mockReturnValue({
      lean: jest.fn(async () => null),
    });
    mongoose.models.UsageReportDelivery.findOneAndUpdate.mockResolvedValueOnce(null);

    const result = await sendUsageReportEmail(report);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.results).toEqual([
      expect.objectContaining({
        email: 'owner@example.com',
        skipped: true,
        reason: 'in_progress',
      }),
    ]);
  });
});
