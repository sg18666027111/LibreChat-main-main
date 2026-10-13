const mongoose = require('mongoose');
const { runAsSystem } = require('@librechat/data-schemas');
const { sendEmail } = require('~/server/utils');
const db = require('~/models');
const {
  buildDashboardPipeline,
  emptyTotals,
  QUERY_TIMEOUT_MS,
} = require('./UsageDashboardAggregation');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_USAGE_QUERY_HOURS = 24 * 30;
const USAGE_RETENTION_MS = 30 * DAY_MS;
const DELIVERY_LEASE_MS = 10 * 60 * 1000;

function retentionCutoff() {
  return new Date(Date.now() - USAGE_RETENTION_MS);
}

function getDeletedUsageSubjectLabel(reportingSubjectId) {
  const safeSubjectId = String(reportingSubjectId || '')
    .replace(/^usr_/, '')
    .replace(/[^a-zA-Z0-9]/g, '');
  const suffix = safeSubjectId.slice(-8).toUpperCase();
  return `已删除用户 #${suffix || 'ANON'}`;
}

function normalizeEmailList(value) {
  if (Array.isArray(value)) {
    return value.map((email) => String(email).trim().toLowerCase()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function isEmailConfigured() {
  return Boolean(
    (process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN && process.env.EMAIL_FROM) ||
      ((process.env.EMAIL_HOST || process.env.EMAIL_SERVICE) && process.env.EMAIL_FROM),
  );
}

async function getUsageDashboard({ hours = 24, userId } = {}) {
  const requestedHours = Math.max(Number.parseInt(hours, 10) || 24, 1);
  if (requestedHours > MAX_USAGE_QUERY_HOURS) {
    const error = new Error('用量查询最多支持最近30天');
    error.status = 400;
    throw error;
  }
  const safeHours = Math.min(requestedHours, MAX_USAGE_QUERY_HOURS);
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000);
  const filter = { occurredAt: { $gte: since < retentionCutoff() ? retentionCutoff() : since } };
  if (userId) {
    filter.userId = new mongoose.Types.ObjectId(String(userId));
  }

  try {
    // Use the model so its tenant-isolation middleware also scopes aggregation.
    // One bounded result contains the full statistics and the capped detail/ranking lists.
    const [result] = await mongoose.models.AIUsageEvent.aggregate(
      buildDashboardPipeline(filter),
    ).option({ maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: false });
    const byUser = result?.byUser || [];
    const userIds = [...new Set(byUser.map((row) => row.userId?.toString()).filter(Boolean))];
    const users = userIds.length
      ? await mongoose.models.User.find({ _id: { $in: userIds } })
          .select('name email approvalStatus reportingSubjectId')
          .maxTimeMS(QUERY_TIMEOUT_MS)
          .lean()
      : [];
    const userById = new Map(users.map((user) => [user._id.toString(), user]));

    return {
      since,
      hours: safeHours,
      totals: {
        ...(result?.totals?.[0] || emptyTotals()),
        userCount: result?.subjects?.[0]?.count || 0,
      },
      byUser: byUser.map((row) => {
        const user = row.userId ? userById.get(row.userId.toString()) : null;
        return {
          ...row,
          userId: row.userId?.toString(),
          name:
            user?.name ||
            (!user && row.reportingSubjectId
              ? getDeletedUsageSubjectLabel(row.reportingSubjectId)
              : ''),
          email: user?.email || '',
          approvalStatus: user?.approvalStatus || '',
        };
      }),
      byModel: result?.byModel || [],
      byBusiness: result?.byBusiness || [],
      recentEvents: result?.recentEvents || [],
    };
  } catch (error) {
    if (error?.code === 50) {
      const timeout = new Error('用量统计超时，请缩短时间范围后重试');
      timeout.status = 504;
      throw timeout;
    }
    throw error;
  }
}

async function listUsageReports({ limit = 30 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100);
  return mongoose.models.UsageReport.find({ windowEnd: { $gte: retentionCutoff() } })
    .sort({ windowEnd: -1 })
    .limit(safeLimit)
    .select(
      'periodKey timezone windowStart windowEnd generatedAt status totals comparison missingPricingCount email',
    )
    .lean();
}

async function getUsageReport(periodKey) {
  return mongoose.models.UsageReport.findOne({
    periodKey,
    windowEnd: { $gte: retentionCutoff() },
  }).lean();
}

async function getUsageReportDetails(periodKey) {
  const report = await getUsageReport(periodKey);
  if (!report) {
    return null;
  }

  const [deliveries, events] = await Promise.all([
    mongoose.models.UsageReportDelivery.find({
      periodKey,
      expiresAt: { $gte: retentionCutoff() },
    })
      .sort({ recipientEmailNormalized: 1 })
      .select(
        'periodKey recipientEmail recipientEmailNormalized status attemptCount manualResendCount lastError lastSentAt lastAttemptAt lastManualResendBy',
      )
      .lean(),
    mongoose.models.AIUsageEvent.find({
      occurredAt: { $gte: report.windowStart, $lt: report.windowEnd },
      expiresAt: { $gte: retentionCutoff() },
    })
      .sort({ occurredAt: 1 })
      .select(
        'usageEventId occurredAt reportingSubjectId userId businessType provider model status inputTokens outputTokens cachedInputTokens cachedOutputTokens imageCount requestCount costCny pricingMissing',
      )
      .lean(),
  ]);

  return { report, deliveries, events };
}

async function listModelPrices() {
  return mongoose.models.AIModelPrice.find({})
    .sort({ provider: 1, model: 1, businessType: 1 })
    .lean();
}

async function upsertModelPrice(input, actor) {
  return db.upsertAIModelPrice({
    ...input,
    createdBy: actor?._id || actor?.id,
  });
}

async function getReportSettings() {
  return db.getUsageReportSettings();
}

async function updateReportSettings(input, actor) {
  const recipients = normalizeEmailList(input.recipients);
  return mongoose.models.UsageReportSettings.findOneAndUpdate(
    { key: 'daily_usage_report' },
    {
      $set: {
        enabled: Boolean(input.enabled),
        recipients,
        thresholdCostCny:
          input.thresholdCostCny == null ? undefined : Math.max(0, Number(input.thresholdCostCny)),
        thresholdTokens:
          input.thresholdTokens == null ? undefined : Math.max(0, Number(input.thresholdTokens)),
        updatedBy: actor?._id || actor?.id,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
}

function formatCny(value) {
  return Number(value || 0).toFixed(2);
}

function formatComparisonPercent(comparison) {
  if (!comparison?.hasComparableCostBase) {
    return '无可比基数';
  }
  return `${Number(comparison.costCnyPercentChange || 0).toFixed(2)}%`;
}

function formatUsageSubject(row) {
  return row?.name || row?.email || getDeletedUsageSubjectLabel(row?.reportingSubjectId);
}

function topRows(rows = [], limit = 10, mapper = (row) => row) {
  return rows.slice(0, limit).map(mapper);
}

async function sendUsageReportEmail(report, options = {}) {
  const manualResend = Boolean(options.manualResend || options.force);
  const failedOnly = Boolean(options.failedOnly);
  const actor = options.actor;
  const bypassDisabled = Boolean(options.force || options.manualResend);
  const settings = await getReportSettings();
  if (!settings?.enabled && !bypassDisabled) {
    return { sent: false, reason: 'disabled' };
  }
  const recipients = settings?.recipients || [];
  if (!recipients.length) {
    return { sent: false, reason: 'no_recipients' };
  }

  async function writeDelivery(email, status, extra = {}, { incrementAttempt = true } = {}) {
    const normalized = String(email).trim().toLowerCase();
    const now = new Date();
    const inc = incrementAttempt
      ? {
          attemptCount: 1,
          ...(manualResend ? { manualResendCount: 1 } : {}),
        }
      : {};
    return mongoose.models.UsageReportDelivery.findOneAndUpdate(
      { periodKey: report.periodKey, recipientEmailNormalized: normalized },
      {
        $set: {
          reportId: report._id,
          periodKey: report.periodKey,
          recipientEmail: email,
          recipientEmailNormalized: normalized,
          status,
          lastAttemptAt: now,
          expiresAt: new Date(now.getTime() + USAGE_RETENTION_MS),
          ...extra,
        },
        ...(Object.keys(inc).length ? { $inc: inc } : {}),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  async function claimDelivery(email, existingDelivery) {
    const normalized = String(email).trim().toLowerCase();
    const now = new Date();
    const staleBefore = new Date(now.getTime() - DELIVERY_LEASE_MS);
    const filters = [
      {
        $or: [
          { status: { $ne: 'sending' } },
          { lastAttemptAt: { $lte: staleBefore } },
          { lastAttemptAt: { $exists: false } },
        ],
      },
    ];
    if (!manualResend && !failedOnly) {
      filters.push({ status: { $ne: 'sent' } });
    }
    if (failedOnly) {
      filters.push({ status: { $in: ['failed', 'not_configured'] } });
    }

    try {
      return await mongoose.models.UsageReportDelivery.findOneAndUpdate(
        {
          periodKey: report.periodKey,
          recipientEmailNormalized: normalized,
          $and: filters,
        },
        {
          $set: {
            reportId: report._id,
            periodKey: report.periodKey,
            recipientEmail: email,
            recipientEmailNormalized: normalized,
            status: 'sending',
            lastAttemptAt: now,
            expiresAt: new Date(now.getTime() + USAGE_RETENTION_MS),
            ...(manualResend && actor
              ? { lastManualResendBy: actor.id || actor._id?.toString?.() }
              : {}),
          },
          $inc: {
            attemptCount: 1,
            ...(manualResend ? { manualResendCount: 1 } : {}),
          },
        },
        { upsert: !existingDelivery, new: true, setDefaultsOnInsert: true },
      );
    } catch (error) {
      if (error?.code === 11000) {
        return null;
      }
      throw error;
    }
  }

  async function getExistingDelivery(email) {
    const normalized = String(email).trim().toLowerCase();
    const existingDelivery = await mongoose.models.UsageReportDelivery.findOne({
      periodKey: report.periodKey,
      recipientEmailNormalized: normalized,
    }).lean();
    return { normalized, existingDelivery };
  }

  function shouldSkipRecipient(existingDelivery) {
    if (manualResend) {
      return null;
    }
    if (existingDelivery?.status === 'sent') {
      return 'already_sent';
    }
    if (existingDelivery?.status === 'sending') {
      const lastAttemptAt = existingDelivery.lastAttemptAt
        ? new Date(existingDelivery.lastAttemptAt).getTime()
        : 0;
      if (lastAttemptAt > Date.now() - DELIVERY_LEASE_MS) {
        return 'in_progress';
      }
    }
    if (
      failedOnly &&
      !['failed', 'not_configured'].includes(String(existingDelivery?.status || ''))
    ) {
      return 'not_failed';
    }
    return null;
  }

  const payload = {
    name: 'Admin',
    appName: process.env.APP_TITLE || '经济舱 AI 工作台',
    periodKey: report.periodKey,
    windowStart: report.windowStart?.toISOString?.() || report.windowStart,
    windowEnd: report.windowEnd?.toISOString?.() || report.windowEnd,
    eventCount: String(report.totals?.eventCount || 0),
    userCount: String(report.totals?.userCount || 0),
    inputTokens: String(report.totals?.inputTokens || 0),
    outputTokens: String(report.totals?.outputTokens || 0),
    imageCount: String(report.totals?.imageCount || 0),
    costCny: formatCny(report.totals?.costCny),
    textCostCny: formatCny(report.totals?.textCostCny),
    imageCostCny: formatCny(report.totals?.imageCostCny),
    succeededCount: String(report.totals?.statusCounts?.succeeded || 0),
    failedCount: String(report.totals?.failedCount || 0),
    statusUnknownCount: String(report.totals?.statusCounts?.status_unknown || 0),
    cancelledCount: String(report.totals?.statusCounts?.cancelled || 0),
    missingPricingCount: String(report.missingPricingCount || 0),
    previousCostDelta: formatCny(report.comparison?.previousWindow?.costCnyDelta),
    previousCostPercent: formatComparisonPercent(report.comparison?.previousWindow),
    sevenWindowAverageCost: report.comparison?.sevenWindowAverage?.insufficientHistory
      ? '数据不足'
      : formatCny(report.comparison?.sevenWindowAverage?.costCny),
    usageCenterUrl: process.env.DOMAIN_CLIENT
      ? `${process.env.DOMAIN_CLIENT.replace(/\/$/, '')}/d/admin/accounts?tab=usage`
      : '/d/admin/accounts?tab=usage',
    topUsers: topRows(report.byUser, 10, (row) => ({
      name: formatUsageSubject(row),
      eventCount: String(row.eventCount || 0),
      costCny: formatCny(row.costCny),
    })),
    topModels: topRows(report.byModel, 10, (row) => ({
      model: `${row.provider || 'unknown'}/${row.model || 'unknown'}`,
      businessType: row.businessType || 'other',
      eventCount: String(row.eventCount || 0),
      costCny: formatCny(row.costCny),
    })),
    topBusinesses: topRows(report.byBusiness, 10, (row) => ({
      businessType: row.businessType || 'other',
      eventCount: String(row.eventCount || 0),
      costCny: formatCny(row.costCny),
    })),
    anomalies: topRows(report.anomalies, 10, (row) => ({
      name:
        row.name ||
        row.email ||
        (row.reportingSubjectId ? getDeletedUsageSubjectLabel(row.reportingSubjectId) : '-'),
      type: row.type || 'unknown',
      currentCostCny: formatCny(row.currentCostCny),
      reason: row.reason || '',
    })),
  };

  if (!isEmailConfigured()) {
    const results = [];
    for (const email of recipients) {
      const { normalized, existingDelivery } = await getExistingDelivery(email);
      const skipReason = shouldSkipRecipient(existingDelivery);
      if (skipReason) {
        results.push({ email: normalized, ok: true, skipped: true, reason: skipReason });
        continue;
      }
      await writeDelivery(email, 'not_configured', {
        lastError: '未配置邮件服务',
        ...(manualResend && actor
          ? { lastManualResendBy: actor.id || actor._id?.toString?.() }
          : {}),
      });
      results.push({ email: normalized, ok: false, reason: 'not_configured' });
    }
    await mongoose.models.UsageReport.updateOne(
      { _id: report._id },
      {
        $set: {
          status: 'failed',
          recipientEmails: recipients,
          email: { error: '未配置邮件服务' },
        },
      },
    );
    return { sent: false, reason: 'not_configured', recipients, results };
  }

  const results = [];
  for (const email of recipients) {
    const { normalized, existingDelivery } = await getExistingDelivery(email);
    const skipReason = shouldSkipRecipient(existingDelivery);
    if (skipReason) {
      results.push({ email: normalized, ok: true, skipped: true, reason: skipReason });
      continue;
    }
    const claim = await claimDelivery(email, existingDelivery);
    if (!claim) {
      results.push({ email: normalized, ok: true, skipped: true, reason: 'in_progress' });
      continue;
    }
    const result = await sendEmail({
      email: normalized,
      subject: `经济舱 AI 用量日报 ${report.periodKey}`,
      payload,
      template: 'usageDailyReport.handlebars',
      throwError: false,
    });
    const ok = !(result instanceof Error);
    await writeDelivery(
      normalized,
      ok ? 'sent' : 'failed',
      {
        lastError: ok ? undefined : result?.message || '邮件发送失败',
        lastSentAt: ok ? new Date() : undefined,
        ...(manualResend && actor
          ? { lastManualResendBy: actor.id || actor._id?.toString?.() }
          : {}),
      },
      { incrementAttempt: false },
    );
    results.push({ email: normalized, ok, error: result?.message });
  }

  const failed = results.filter((result) => !result.ok);
  const attempted = results.some((result) => !result.skipped);
  if (attempted) {
    await mongoose.models.UsageReport.updateOne(
      { _id: report._id },
      {
        $set: {
          status: failed.length ? 'failed' : 'emailed',
          recipientEmails: recipients,
          email: {
            sentAt: failed.length ? undefined : new Date(),
            error: failed.map((item) => `${item.email}: ${item.error}`).join('; '),
          },
        },
      },
    );
  }

  return { sent: attempted && failed.length === 0, recipients, results };
}

async function generateDailyUsageReport({
  now = new Date(),
  email = false,
  forceEmail = false,
} = {}) {
  const report = await runAsSystem(async () => db.generateDailyUsageReport({ now }));
  if (email || forceEmail) {
    await sendUsageReportEmail(report, { force: forceEmail, manualResend: forceEmail });
    return mongoose.models.UsageReport.findById(report._id).lean();
  }
  return report;
}

async function resendUsageReportEmail(periodKey, actor) {
  const report = await getUsageReport(periodKey);
  if (!report) {
    const error = new Error('报表不存在或已超过30天查询范围');
    error.status = 404;
    throw error;
  }
  const delivery = await sendUsageReportEmail(report, { manualResend: true, actor });
  const refreshed = await getUsageReport(periodKey);
  return { report: refreshed || report, delivery };
}

async function retryUsageReportEmail(periodKey) {
  const report = await getUsageReport(periodKey);
  if (!report) {
    const error = new Error('报表不存在或已超过30天查询范围');
    error.status = 404;
    throw error;
  }
  const delivery = await sendUsageReportEmail(report, { failedOnly: true });
  const refreshed = await getUsageReport(periodKey);
  return { report: refreshed || report, delivery };
}

async function cleanupOldReports() {
  return mongoose.models.UsageReport.deleteMany({
    windowEnd: { $lt: retentionCutoff() },
  });
}

module.exports = {
  cleanupOldReports,
  generateDailyUsageReport,
  getReportSettings,
  getUsageDashboard,
  getUsageReport,
  getUsageReportDetails,
  listModelPrices,
  listUsageReports,
  resendUsageReportEmail,
  retryUsageReportEmail,
  sendUsageReportEmail,
  updateReportSettings,
  upsertModelPrice,
};
