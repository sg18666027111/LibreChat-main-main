import type { Document, Types } from 'mongoose';

export type AccountApprovalStatus = 'pending' | 'active' | 'suspended' | 'rejected' | 'deleting';
export type AIUsageBusinessType =
  | 'chat'
  | 'vision_analysis'
  | 'image_generation'
  | 'multi_reference_generation'
  | 'product_replacement'
  | 'white_background'
  | 'batch_image_generation'
  | 'canvas_generation'
  | 'main_image_generation'
  | 'detail_page_generation'
  | 'other';
export type AIUsageEventStatus =
  | 'submitted'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'status_unknown';

export interface AIUsagePricingSnapshot {
  provider?: string;
  model?: string;
  businessType?: AIUsageBusinessType;
  inputPriceCnyPer1K?: number;
  outputPriceCnyPer1K?: number;
  imagePriceCny?: number;
  requestPriceCny?: number;
  tokenCreditToCny?: number;
  currency: 'CNY';
}

export interface IAIUsageEvent extends Omit<Document, 'model'> {
  _id: Types.ObjectId;
  usageEventId: string;
  tenantId?: string;
  userId?: Types.ObjectId | null;
  reportingSubjectId: string;
  businessType: AIUsageBusinessType;
  provider: string;
  model: string;
  modelKey?: string;
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  actionRunId?: string;
  batchId?: string;
  itemId?: string;
  status: AIUsageEventStatus;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cachedOutputTokens: number;
  imageCount: number;
  requestCount: number;
  tokenValue?: number;
  costCny: number;
  currency: 'CNY';
  pricingMissing: boolean;
  pricingSnapshot?: AIUsagePricingSnapshot;
  metadata?: Record<string, unknown>;
  deliveryTombstone?: boolean;
  deliveryRevision?: number;
  deliveryDigest?: string;
  deliverySource?: UsageSource;
  deliverySourceKey?: string;
  deliveryStatusRank?: number;
  anonymizedAt?: Date;
  occurredAt: Date;
  expiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAIModelPrice extends Omit<Document, 'model'> {
  _id: Types.ObjectId;
  provider: string;
  model: string;
  businessType?: AIUsageBusinessType;
  inputPriceCnyPer1K?: number;
  outputPriceCnyPer1K?: number;
  imagePriceCny?: number;
  requestPriceCny?: number;
  tokenCreditToCny?: number;
  currency: 'CNY';
  active: boolean;
  effectiveFrom?: Date;
  createdBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UsageReportTotals {
  eventCount: number;
  userCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cachedOutputTokens: number;
  imageCount: number;
  requestCount: number;
  costCny: number;
  textCostCny?: number;
  imageCostCny?: number;
  failedCount: number;
  statusCounts?: Record<AIUsageEventStatus, number>;
}

export interface UsageReportUserRow extends UsageReportTotals {
  userId?: string;
  reportingSubjectId: string;
  name?: string;
  email?: string;
  approvalStatus?: AccountApprovalStatus;
}

export interface UsageReportModelRow extends UsageReportTotals {
  provider: string;
  model: string;
  businessType: AIUsageBusinessType;
}

export interface UsageReportHourlyRow extends UsageReportTotals {
  hour: string;
}

export interface UsageReportBusinessRow extends UsageReportTotals {
  businessType: AIUsageBusinessType;
}

export interface UsageReportPreviousWindowComparison {
  costCny: number;
  costCnyDelta: number;
  costCnyPercentChange: number | null;
  hasComparableCostBase: boolean;
  eventCount: number;
  eventCountDelta: number;
  userCount: number;
  userCountDelta: number;
  perUserCostCny: number;
  perUserCostCnyDelta: number;
}

export interface UsageReportSevenWindowAverage {
  windowCount: number;
  costCny: number;
  eventCount: number;
  userCount: number;
  perUserCostCny: number;
  insufficientHistory: boolean;
}

export interface UsageReportComparison {
  previousWindow: UsageReportPreviousWindowComparison;
  sevenWindowAverage: UsageReportSevenWindowAverage;
}

export interface UsageReportAnomaly {
  type: 'seven_window_spike' | 'fixed_amount_threshold' | 'missing_pricing';
  reportingSubjectId?: string;
  userId?: string;
  name?: string;
  email?: string;
  currentCostCny?: number;
  baselineCostCny?: number;
  multiplier?: number;
  thresholdSnapshotCny?: number;
  reason: string;
}

export interface IUsageReport extends Document {
  _id: Types.ObjectId;
  periodKey: string;
  timezone: 'Asia/Shanghai';
  windowStart: Date;
  windowEnd: Date;
  generatedAt: Date;
  status: 'generated' | 'emailed' | 'failed';
  recipientEmails: string[];
  totals: UsageReportTotals;
  byUser: UsageReportUserRow[];
  byModel: UsageReportModelRow[];
  byBusiness: UsageReportBusinessRow[];
  hourly: UsageReportHourlyRow[];
  comparison?: UsageReportComparison;
  anomalies: UsageReportAnomaly[];
  missingPricingCount: number;
  email?: {
    sentAt?: Date;
    error?: string;
  };
  expiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IUsageReportDelivery extends Document {
  _id: Types.ObjectId;
  reportId?: Types.ObjectId;
  periodKey: string;
  recipientEmail: string;
  recipientEmailNormalized: string;
  status: 'sending' | 'sent' | 'failed' | 'skipped' | 'not_configured';
  attemptCount: number;
  manualResendCount: number;
  lastError?: string;
  lastSentAt?: Date;
  lastAttemptAt?: Date;
  lastManualResendBy?: string;
  expiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IUsageReportSettings extends Document {
  _id: Types.ObjectId;
  key: 'daily_usage_report';
  enabled: boolean;
  recipients: string[];
  thresholdCostCny?: number;
  thresholdTokens?: number;
  updatedBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAdminAuditLog extends Document {
  _id: Types.ObjectId;
  tenantId?: string;
  actorId?: Types.ObjectId;
  actorEmail?: string;
  targetUserId?: Types.ObjectId;
  targetEmail?: string;
  action: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface RecordAIUsageEventInput {
  usageEventId: string;
  tenantId?: string;
  userId?: Types.ObjectId | string | null;
  reportingSubjectId?: string;
  businessType: AIUsageBusinessType;
  provider: string;
  model: string;
  modelKey?: string;
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  actionRunId?: string;
  batchId?: string;
  itemId?: string;
  status: AIUsageEventStatus;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cachedOutputTokens?: number;
  imageCount?: number;
  requestCount?: number;
  tokenValue?: number;
  costCny?: number;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  expiresAt?: Date;
}

export interface UpsertAIModelPriceInput {
  provider: string;
  model: string;
  businessType?: AIUsageBusinessType;
  inputPriceCnyPer1K?: number;
  outputPriceCnyPer1K?: number;
  imagePriceCny?: number;
  requestPriceCny?: number;
  tokenCreditToCny?: number;
  active?: boolean;
  effectiveFrom?: Date;
  createdBy?: Types.ObjectId | string;
}

/** JSON-safe event captured before asynchronous ledger delivery. */
export type UsageSource = 'image' | 'batch' | 'chat' | 'assistant' | 'transaction';
export type DeliveryFailure = 'invalid' | 'oversize' | 'full' | 'unavailable' | 'conflict';
export type CaptureResult =
  | { durableAccepted: true; ledgerPersisted: boolean; eventId: string; revision: number }
  | { durableAccepted: false; ledgerPersisted: false; reason: DeliveryFailure };
export type PricingEvidence =
  | { kind: 'snapshot'; snapshot: AIUsagePricingSnapshot }
  | { kind: 'confirmed_cost'; costCny: number }
  | { kind: 'missing' };
export interface UsageEnvelope {
  schemaVersion: 1;
  source: UsageSource;
  sourceKey: string;
  revision: number;
  event: Omit<
    RecordAIUsageEventInput,
    'occurredAt' | 'expiresAt' | 'reportingSubjectId' | 'costCny' | 'userId'
  > & {
    userId?: string | null;
  };
  occurredAt: string;
  expiresAt: string;
  reportingSubjectId: string;
  pricing: PricingEvidence;
}
export interface UsageReservation {
  id: string;
  remainingBytes: number;
  expiresAt: string;
}
export interface UsageClaim {
  envelope: UsageEnvelope;
  digest: string;
  token: string;
  attempts: number;
}
export interface UsageStats {
  pendingCount: number;
  pendingBytes: number;
  reservedBytes: number;
  oldestPendingSeconds: number;
  quarantinedCount: number;
  writable: boolean;
}

export interface UsageDeliverySourceState {
  /** Original source-document TTL, restored only after durable capture. */
  cleanupAfter?: string;
  payloadPruned?: boolean;
  envelope?: UsageEnvelope;
  revision: number;
  state: 'pending' | 'durable' | 'persisted' | 'review';
}
export interface UsageCaptureContext {
  source: UsageSource;
  sourceKey: string;
  eventId: string;
  occurredAt: string;
  expiresAt: string;
  reportingSubjectId: string;
  pricing: PricingEvidence;
  reservationId: string;
}
