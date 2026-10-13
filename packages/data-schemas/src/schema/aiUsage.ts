import { Schema } from 'mongoose';
import type {
  IAdminAuditLog,
  IAIModelPrice,
  IAIUsageEvent,
  IUsageReport,
  IUsageReportDelivery,
  IUsageReportSettings,
} from '~/types/aiUsage';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY_MS;

export const aiUsageBusinessTypes = [
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
] as const;

export const aiUsageEventStatuses = [
  'submitted',
  'succeeded',
  'failed',
  'cancelled',
  'status_unknown',
] as const;

const pricingSnapshotSchema = new Schema(
  {
    provider: String,
    model: String,
    businessType: { type: String, enum: aiUsageBusinessTypes },
    inputPriceCnyPer1K: Number,
    outputPriceCnyPer1K: Number,
    imagePriceCny: Number,
    requestPriceCny: Number,
    tokenCreditToCny: Number,
    currency: { type: String, enum: ['CNY'], default: 'CNY' },
  },
  { _id: false },
);

const usageTotalsSchema = new Schema(
  {
    eventCount: { type: Number, default: 0 },
    userCount: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cachedInputTokens: { type: Number, default: 0 },
    cachedOutputTokens: { type: Number, default: 0 },
    imageCount: { type: Number, default: 0 },
    requestCount: { type: Number, default: 0 },
    costCny: { type: Number, default: 0 },
    textCostCny: { type: Number, default: 0 },
    imageCostCny: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    statusCounts: {
      submitted: { type: Number, default: 0 },
      succeeded: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      cancelled: { type: Number, default: 0 },
      status_unknown: { type: Number, default: 0 },
    },
  },
  { _id: false },
);

const usageReportUserSchema = usageTotalsSchema.clone().add({
  userId: String,
  reportingSubjectId: { type: String, required: true },
  name: String,
  email: String,
  approvalStatus: String,
});

const usageReportModelSchema = usageTotalsSchema.clone().add({
  provider: { type: String, required: true },
  model: { type: String, required: true },
  businessType: { type: String, enum: aiUsageBusinessTypes, required: true },
});

const usageReportHourlySchema = usageTotalsSchema.clone().add({
  hour: { type: String, required: true },
});

const usageReportBusinessSchema = usageTotalsSchema.clone().add({
  businessType: { type: String, enum: aiUsageBusinessTypes, required: true },
});

const usageReportComparisonSchema = new Schema(
  {
    previousWindow: {
      costCny: { type: Number, default: 0 },
      costCnyDelta: { type: Number, default: 0 },
      costCnyPercentChange: { type: Number, default: null },
      hasComparableCostBase: { type: Boolean, default: false },
      eventCount: { type: Number, default: 0 },
      eventCountDelta: { type: Number, default: 0 },
      userCount: { type: Number, default: 0 },
      userCountDelta: { type: Number, default: 0 },
      perUserCostCny: { type: Number, default: 0 },
      perUserCostCnyDelta: { type: Number, default: 0 },
    },
    sevenWindowAverage: {
      windowCount: { type: Number, default: 0 },
      costCny: { type: Number, default: 0 },
      eventCount: { type: Number, default: 0 },
      userCount: { type: Number, default: 0 },
      perUserCostCny: { type: Number, default: 0 },
      insufficientHistory: { type: Boolean, default: true },
    },
  },
  { _id: false },
);

const usageReportAnomalySchema = new Schema(
  {
    type: {
      type: String,
      enum: ['seven_window_spike', 'fixed_amount_threshold', 'missing_pricing'],
      required: true,
    },
    reportingSubjectId: String,
    userId: String,
    name: String,
    email: String,
    currentCostCny: Number,
    baselineCostCny: Number,
    multiplier: Number,
    thresholdSnapshotCny: Number,
    reason: { type: String, required: true },
  },
  { _id: false },
);

export const aiUsageEventSchema = new Schema<IAIUsageEvent>(
  {
    usageEventId: { type: String, required: true, trim: true, unique: true, index: true },
    tenantId: { type: String, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true, default: null },
    reportingSubjectId: { type: String, required: true, trim: true, index: true },
    businessType: { type: String, enum: aiUsageBusinessTypes, required: true, index: true },
    provider: { type: String, required: true, trim: true, index: true },
    model: { type: String, required: true, trim: true, index: true },
    modelKey: { type: String, trim: true },
    requestId: { type: String, trim: true, index: true },
    conversationId: { type: String, trim: true, index: true },
    messageId: { type: String, trim: true, index: true },
    actionRunId: { type: String, trim: true, index: true },
    batchId: { type: String, trim: true, index: true },
    itemId: { type: String, trim: true },
    status: { type: String, enum: aiUsageEventStatuses, required: true, index: true },
    inputTokens: { type: Number, default: 0, min: 0 },
    outputTokens: { type: Number, default: 0, min: 0 },
    cachedInputTokens: { type: Number, default: 0, min: 0 },
    cachedOutputTokens: { type: Number, default: 0, min: 0 },
    imageCount: { type: Number, default: 0, min: 0 },
    requestCount: { type: Number, default: 1, min: 0 },
    tokenValue: Number,
    costCny: { type: Number, default: 0, min: 0 },
    currency: { type: String, enum: ['CNY'], default: 'CNY' },
    pricingMissing: { type: Boolean, default: false, index: true },
    pricingSnapshot: pricingSnapshotSchema,
    metadata: { type: Schema.Types.Mixed },
    deliveryTombstone: { type: Boolean },
    deliveryRevision: { type: Number, min: 0 },
    deliveryDigest: String,
    deliverySource: String,
    deliverySourceKey: String,
    deliveryStatusRank: Number,
    anonymizedAt: { type: Date },
    occurredAt: { type: Date, required: true, default: Date.now, index: true },
    expiresAt: { type: Date, default: () => new Date(Date.now() + RETENTION_MS) },
  },
  { timestamps: true },
);

aiUsageEventSchema.index({ tenantId: 1, occurredAt: 1 });
aiUsageEventSchema.index({ reportingSubjectId: 1, occurredAt: 1 });
aiUsageEventSchema.index({ provider: 1, model: 1, businessType: 1, occurredAt: 1 });
aiUsageEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const aiModelPriceSchema = new Schema<IAIModelPrice>(
  {
    provider: { type: String, required: true, lowercase: true, trim: true, index: true },
    model: { type: String, required: true, trim: true, index: true },
    businessType: { type: String, enum: aiUsageBusinessTypes, index: true },
    inputPriceCnyPer1K: { type: Number, min: 0 },
    outputPriceCnyPer1K: { type: Number, min: 0 },
    imagePriceCny: { type: Number, min: 0 },
    requestPriceCny: { type: Number, min: 0 },
    tokenCreditToCny: { type: Number, min: 0 },
    currency: { type: String, enum: ['CNY'], default: 'CNY' },
    active: { type: Boolean, default: true, index: true },
    effectiveFrom: { type: Date, default: Date.now, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

aiModelPriceSchema.index(
  { provider: 1, model: 1, businessType: 1, effectiveFrom: -1 },
  { unique: true },
);

export const usageReportSchema = new Schema<IUsageReport>(
  {
    periodKey: { type: String, required: true, unique: true, index: true },
    timezone: { type: String, enum: ['Asia/Shanghai'], default: 'Asia/Shanghai' },
    windowStart: { type: Date, required: true, index: true },
    windowEnd: { type: Date, required: true, index: true },
    generatedAt: { type: Date, required: true, default: Date.now },
    status: { type: String, enum: ['generated', 'emailed', 'failed'], default: 'generated' },
    recipientEmails: { type: [String], default: [] },
    totals: { type: usageTotalsSchema, required: true, default: () => ({}) },
    byUser: { type: [usageReportUserSchema], default: [] },
    byModel: { type: [usageReportModelSchema], default: [] },
    byBusiness: { type: [usageReportBusinessSchema], default: [] },
    hourly: { type: [usageReportHourlySchema], default: [] },
    comparison: { type: usageReportComparisonSchema, default: () => ({}) },
    anomalies: { type: [usageReportAnomalySchema], default: [] },
    missingPricingCount: { type: Number, default: 0, min: 0 },
    email: {
      type: {
        sentAt: Date,
        error: String,
      },
      default: {},
    },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

usageReportSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const usageReportDeliverySchema = new Schema<IUsageReportDelivery>(
  {
    reportId: { type: Schema.Types.ObjectId, ref: 'UsageReport', index: true },
    periodKey: { type: String, required: true, index: true },
    recipientEmail: { type: String, required: true, trim: true },
    recipientEmailNormalized: { type: String, required: true, lowercase: true, trim: true },
    status: {
      type: String,
      enum: ['sending', 'sent', 'failed', 'skipped', 'not_configured'],
      required: true,
      index: true,
    },
    attemptCount: { type: Number, default: 0, min: 0 },
    manualResendCount: { type: Number, default: 0, min: 0 },
    lastError: String,
    lastSentAt: Date,
    lastAttemptAt: Date,
    lastManualResendBy: String,
    expiresAt: { type: Date, default: () => new Date(Date.now() + RETENTION_MS) },
  },
  { timestamps: true },
);

usageReportDeliverySchema.index({ periodKey: 1, recipientEmailNormalized: 1 }, { unique: true });
usageReportDeliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const usageReportSettingsSchema = new Schema<IUsageReportSettings>(
  {
    key: { type: String, enum: ['daily_usage_report'], required: true, unique: true },
    enabled: { type: Boolean, default: false },
    recipients: { type: [String], default: [] },
    thresholdCostCny: { type: Number, min: 0 },
    thresholdTokens: { type: Number, min: 0 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const adminAuditLogSchema = new Schema<IAdminAuditLog>(
  {
    tenantId: { type: String, index: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    actorEmail: { type: String, lowercase: true, trim: true },
    targetUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    targetEmail: { type: String, lowercase: true, trim: true },
    action: { type: String, required: true, trim: true, index: true },
    reason: { type: String, trim: true, maxlength: 1000 },
    metadata: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, default: () => new Date(Date.now() + RETENTION_MS) },
  },
  { timestamps: true },
);

adminAuditLogSchema.index({ createdAt: -1 });
adminAuditLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
