import { randomUUID } from 'crypto';
import type { FilterQuery, Model, Types } from 'mongoose';
import logger from '~/config/winston';
import { createIndexesWithRetry } from '~/utils/retry';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { createReportingSubjectId } from '~/schema/user';
import { aiUsageBusinessTypes } from '~/schema/aiUsage';
import type {
  AIUsagePricingSnapshot,
  UsageEnvelope,
  PricingEvidence,
  IAIModelPrice,
  IAIUsageEvent,
  IUsageReport,
  IUsageReportDelivery,
  IUsageReportSettings,
  IUser,
  AIUsageEventStatus,
  RecordAIUsageEventInput,
  UpsertAIModelPriceInput,
  UsageReportAnomaly,
  UsageReportBusinessRow,
  UsageReportComparison,
  UsageReportHourlyRow,
  UsageReportModelRow,
  UsageReportTotals,
  UsageReportUserRow,
} from '~/types';

export { aiUsageBusinessTypes };

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_RETENTION_MS = 30 * DAY_MS;
const SENSITIVE_METADATA_KEYS = new Set([
  'prompt',
  'messages',
  'text',
  'content',
  'input',
  'output',
  'image',
  'imageUrl',
  'image_url',
  'base64',
  'providerResult',
]);
const IDENTITY_METADATA_KEYS = [
  'userId',
  'user_id',
  'email',
  'userEmail',
  'user_email',
  'name',
  'userName',
  'username',
  'avatar',
  'picture',
  'displayName',
  'profileImage',
  'userSnapshot',
  'identitySnapshot',
  'profileSnapshot',
];
const IDENTITY_METADATA_KEY_LOOKUP = new Set(
  IDENTITY_METADATA_KEYS.map((key) => key.replace(/[-_\s]/g, '').toLowerCase()),
);

function isIdentityMetadataKey(key: string) {
  return IDENTITY_METADATA_KEY_LOOKUP.has(key.replace(/[-_\s]/g, '').toLowerCase());
}

function scrubDeletedIdentityMetadata(value: unknown): unknown {
  if (!value || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeletedIdentityMetadata(item));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isIdentityMetadataKey(key))
      .map(([key, item]) => [key, scrubDeletedIdentityMetadata(item)]),
  );
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toCents(value: unknown): number {
  return Math.round(toNumber(value) * 100);
}

function fromCents(value: number): number {
  return Number((value / 100).toFixed(2));
}

function addCny(left: number | undefined, right: number | undefined) {
  return fromCents(toCents(left) + toCents(right));
}

function emptyStatusCounts(): Record<AIUsageEventStatus, number> {
  return {
    submitted: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    status_unknown: 0,
  };
}

function safeMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !SENSITIVE_METADATA_KEYS.has(key)),
  );
}

function normalizeProvider(provider: string) {
  return provider.trim().toLowerCase();
}

function asObjectId(mongoose: typeof import('mongoose'), value?: Types.ObjectId | string | null) {
  if (!value) {
    return null;
  }
  if (value instanceof mongoose.Types.ObjectId) {
    return value;
  }
  return new mongoose.Types.ObjectId(value);
}

function emptyTotals(): UsageReportTotals {
  return {
    eventCount: 0,
    userCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cachedOutputTokens: 0,
    imageCount: 0,
    requestCount: 0,
    costCny: 0,
    textCostCny: 0,
    imageCostCny: 0,
    failedCount: 0,
    statusCounts: emptyStatusCounts(),
  };
}

function isImageBusinessType(event: Pick<IAIUsageEvent, 'businessType' | 'imageCount'>) {
  return (
    toNumber(event.imageCount) > 0 ||
    [
      'image_generation',
      'multi_reference_generation',
      'product_replacement',
      'white_background',
      'batch_image_generation',
      'canvas_generation',
      'main_image_generation',
      'detail_page_generation',
    ].includes(event.businessType)
  );
}

function addEventToTotals(totals: UsageReportTotals, event: IAIUsageEvent) {
  totals.eventCount += 1;
  totals.inputTokens += toNumber(event.inputTokens);
  totals.outputTokens += toNumber(event.outputTokens);
  totals.cachedInputTokens += toNumber(event.cachedInputTokens);
  totals.cachedOutputTokens += toNumber(event.cachedOutputTokens);
  totals.imageCount += toNumber(event.imageCount);
  totals.requestCount += toNumber(event.requestCount);
  totals.costCny = addCny(totals.costCny, event.costCny);
  if (isImageBusinessType(event)) {
    totals.imageCostCny = addCny(totals.imageCostCny, event.costCny);
  } else {
    totals.textCostCny = addCny(totals.textCostCny, event.costCny);
  }
  const status = event.status as AIUsageEventStatus;
  const statusCounts = totals.statusCounts ?? emptyStatusCounts();
  statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  totals.statusCounts = statusCounts;
  if (event.status === 'failed' || event.status === 'status_unknown') {
    totals.failedCount += 1;
  }
}

function localYmd(date: Date) {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

function formatLocalDate(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatHourShanghai(date: Date) {
  const parts = localYmd(date);
  return `${formatLocalDate(parts.year, parts.month, parts.day)} ${String(parts.hour).padStart(
    2,
    '0',
  )}:00`;
}

export function getShanghaiUsageReportWindow(now = new Date()) {
  const parts = localYmd(now);
  const endLocal = new Date(Date.UTC(parts.year, parts.month, parts.day, 10, 0, 0, 0));
  if (parts.hour < 10) {
    endLocal.setUTCDate(endLocal.getUTCDate() - 1);
  }
  const windowEnd = new Date(endLocal.getTime() - SHANGHAI_OFFSET_MS);
  const windowStart = new Date(windowEnd.getTime() - DAY_MS);
  const endParts = localYmd(windowEnd);
  return {
    timezone: 'Asia/Shanghai' as const,
    periodKey: `${formatLocalDate(endParts.year, endParts.month, endParts.day)}@Asia/Shanghai`,
    windowStart,
    windowEnd,
  };
}

export function getDeletedUsageSubjectLabel(reportingSubjectId: string) {
  const safeSubjectId = String(reportingSubjectId || '')
    .replace(/^usr_/, '')
    .replace(/[^a-zA-Z0-9]/g, '');
  const suffix = safeSubjectId.slice(-8).toUpperCase();
  return `已删除用户 #${suffix || 'ANON'}`;
}

export function createAIUsageMethods(mongoose: typeof import('mongoose')) {
  const AIUsageEvent = mongoose.models.AIUsageEvent as Model<IAIUsageEvent>;
  const AIModelPrice = mongoose.models.AIModelPrice as Model<IAIModelPrice>;
  const UsageReport = mongoose.models.UsageReport as Model<IUsageReport>;
  const UsageReportDelivery = mongoose.models.UsageReportDelivery as Model<IUsageReportDelivery>;
  const UsageReportSettings = mongoose.models.UsageReportSettings as Model<IUsageReportSettings>;
  const User = mongoose.models.User as Model<IUser>;
  let storageInitialization: Promise<void> | undefined;

  async function ensureAIUsageStorage() {
    if (!storageInitialization) {
      storageInitialization = (async () => {
        for (const model of [
          AIUsageEvent,
          AIModelPrice,
          UsageReport,
          UsageReportDelivery,
          UsageReportSettings,
        ]) {
          try {
            await model.createCollection();
          } catch (error) {
            const mongoError = error as { code?: number; codeName?: string };
            if (mongoError.code !== 48 && mongoError.codeName !== 'NamespaceExists') {
              throw error;
            }
          }
          await createIndexesWithRetry(model);
        }
      })().catch((error) => {
        storageInitialization = undefined;
        throw error;
      });
    }
    return storageInitialization;
  }

  async function getOrCreateReportingSubjectId(userId?: Types.ObjectId | string | null) {
    if (!userId) {
      return `anon_${randomUUID().replace(/-/g, '')}`;
    }

    const objectId = asObjectId(mongoose, userId);
    const user = await User.findById(objectId).select('reportingSubjectId').lean<IUser>();
    if (user?.reportingSubjectId) {
      return user.reportingSubjectId;
    }

    const reportingSubjectId = createReportingSubjectId();
    const updated = await User.findOneAndUpdate(
      {
        _id: objectId,
        $or: [{ reportingSubjectId: null }, { reportingSubjectId: { $exists: false } }],
      },
      { $set: { reportingSubjectId } },
      { new: true },
    )
      .select('reportingSubjectId')
      .lean<IUser>();

    return updated?.reportingSubjectId ?? reportingSubjectId;
  }

  async function findPrice(input: RecordAIUsageEventInput) {
    const provider = normalizeProvider(input.provider);
    const occurredAt = input.occurredAt ?? new Date();
    const effectiveFilter: FilterQuery<IAIModelPrice> = {
      provider,
      model: input.model,
      active: true,
      $and: [
        {
          $or: [
            { businessType: input.businessType },
            { businessType: { $exists: false } },
            { businessType: null },
          ],
        },
        {
          $or: [
            { effectiveFrom: { $lte: occurredAt } },
            { effectiveFrom: { $exists: false } },
            { effectiveFrom: null },
          ],
        },
      ],
    };
    return AIModelPrice.findOne(effectiveFilter)
      .sort({ businessType: -1, effectiveFrom: -1, createdAt: -1 })
      .lean<IAIModelPrice>();
  }

  function computeCost(
    input: RecordAIUsageEventInput,
    price?: IAIModelPrice | AIUsagePricingCompatible | AIUsagePricingSnapshot | null,
  ) {
    if (typeof input.costCny === 'number' && Number.isFinite(input.costCny)) {
      return {
        costCny: Math.max(0, input.costCny),
        pricingMissing: false,
        pricingSnapshot: price
          ? {
              provider: price.provider,
              model: price.model,
              businessType: price.businessType,
              inputPriceCnyPer1K: price.inputPriceCnyPer1K,
              outputPriceCnyPer1K: price.outputPriceCnyPer1K,
              imagePriceCny: price.imagePriceCny,
              requestPriceCny: price.requestPriceCny,
              tokenCreditToCny: price.tokenCreditToCny,
              currency: 'CNY' as const,
            }
          : undefined,
      };
    }

    if (!price) {
      return { costCny: 0, pricingMissing: true, pricingSnapshot: undefined };
    }

    const costCny =
      (toNumber(input.inputTokens) / 1000) * toNumber(price.inputPriceCnyPer1K) +
      (toNumber(input.outputTokens) / 1000) * toNumber(price.outputPriceCnyPer1K) +
      toNumber(input.imageCount) * toNumber(price.imagePriceCny) +
      toNumber(input.requestCount, 1) * toNumber(price.requestPriceCny) +
      Math.abs(toNumber(input.tokenValue)) * toNumber(price.tokenCreditToCny);

    return {
      costCny: fromCents(toCents(costCny)),
      pricingMissing: false,
      pricingSnapshot: {
        provider: price.provider,
        model: price.model,
        businessType: price.businessType,
        inputPriceCnyPer1K: price.inputPriceCnyPer1K,
        outputPriceCnyPer1K: price.outputPriceCnyPer1K,
        imagePriceCny: price.imagePriceCny,
        requestPriceCny: price.requestPriceCny,
        tokenCreditToCny: price.tokenCreditToCny,
        currency: 'CNY' as const,
      },
    };
  }

  type AIUsagePricingCompatible = Pick<
    IAIModelPrice,
    | 'provider'
    | 'model'
    | 'businessType'
    | 'inputPriceCnyPer1K'
    | 'outputPriceCnyPer1K'
    | 'imagePriceCny'
    | 'requestPriceCny'
    | 'tokenCreditToCny'
  >;

  function getStatusRank(status: AIUsageEventStatus) {
    return {
      submitted: 0,
      status_unknown: 1,
      failed: 1,
      cancelled: 1,
      succeeded: 2,
    }[status];
  }

  async function upsertAIModelPrice(input: UpsertAIModelPriceInput) {
    await ensureAIUsageStorage();
    const provider = normalizeProvider(input.provider);
    return AIModelPrice.findOneAndUpdate(
      {
        provider,
        model: input.model,
        businessType: input.businessType,
        effectiveFrom: input.effectiveFrom ?? new Date(0),
      },
      {
        $set: {
          provider,
          model: input.model,
          businessType: input.businessType,
          inputPriceCnyPer1K: input.inputPriceCnyPer1K,
          outputPriceCnyPer1K: input.outputPriceCnyPer1K,
          imagePriceCny: input.imagePriceCny,
          requestPriceCny: input.requestPriceCny,
          tokenCreditToCny: input.tokenCreditToCny,
          active: input.active ?? true,
          currency: 'CNY',
          effectiveFrom: input.effectiveFrom ?? new Date(0),
          createdBy: input.createdBy ? asObjectId(mongoose, input.createdBy) : undefined,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean<IAIModelPrice>();
  }

  async function recordAIUsageEvent(input: RecordAIUsageEventInput) {
    await ensureAIUsageStorage();
    const existing = await AIUsageEvent.findOne({
      usageEventId: input.usageEventId,
    }).lean<IAIUsageEvent>();
    if (existing) {
      if (getStatusRank(input.status) < getStatusRank(existing.status)) {
        return existing;
      }
      const price =
        existing.pricingSnapshot ?? (existing.pricingMissing ? null : await findPrice(input));
      const cost = computeCost(input, price);
      return AIUsageEvent.findOneAndUpdate(
        { usageEventId: input.usageEventId },
        {
          $set: {
            status: input.status,
            inputTokens: toNumber(input.inputTokens),
            outputTokens: toNumber(input.outputTokens),
            cachedInputTokens: toNumber(input.cachedInputTokens),
            cachedOutputTokens: toNumber(input.cachedOutputTokens),
            imageCount: toNumber(input.imageCount),
            requestCount: toNumber(input.requestCount, 1),
            tokenValue: input.tokenValue,
            costCny: Math.max(0, cost.costCny),
            pricingMissing: cost.pricingMissing,
            pricingSnapshot: existing.pricingSnapshot ?? cost.pricingSnapshot,
            metadata: safeMetadata(input.metadata),
          },
        },
        { new: true },
      ).lean<IAIUsageEvent>();
    }

    const userId = asObjectId(mongoose, input.userId);
    const reportingSubjectId =
      input.reportingSubjectId ?? (await getOrCreateReportingSubjectId(userId));
    const price = await findPrice(input);
    const cost = computeCost(input, price);
    const doc = {
      usageEventId: input.usageEventId,
      tenantId: input.tenantId,
      userId,
      reportingSubjectId,
      businessType: input.businessType,
      provider: normalizeProvider(input.provider),
      model: input.model,
      modelKey: input.modelKey,
      requestId: input.requestId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      actionRunId: input.actionRunId,
      batchId: input.batchId,
      itemId: input.itemId,
      status: input.status,
      inputTokens: toNumber(input.inputTokens),
      outputTokens: toNumber(input.outputTokens),
      cachedInputTokens: toNumber(input.cachedInputTokens),
      cachedOutputTokens: toNumber(input.cachedOutputTokens),
      imageCount: toNumber(input.imageCount),
      requestCount: toNumber(input.requestCount, 1),
      tokenValue: input.tokenValue,
      costCny: Math.max(0, fromCents(toCents(cost.costCny))),
      currency: 'CNY',
      pricingMissing: cost.pricingMissing,
      pricingSnapshot: cost.pricingSnapshot,
      metadata: safeMetadata(input.metadata),
      occurredAt: input.occurredAt ?? new Date(),
      expiresAt:
        input.expiresAt ??
        new Date((input.occurredAt ?? new Date()).getTime() + REPORT_RETENTION_MS),
    };

    try {
      return await AIUsageEvent.findOneAndUpdate(
        { usageEventId: input.usageEventId },
        { $setOnInsert: doc },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean<IAIUsageEvent>();
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        const afterRace = await AIUsageEvent.findOne({
          usageEventId: input.usageEventId,
        }).lean<IAIUsageEvent>();
        if (afterRace) {
          return afterRace;
        }
      }
      logger.error('[AIUsage] Failed to record usage event', error);
      throw error;
    }
  }

  function deliveryError(code: string): Error & { code: string } {
    return Object.assign(new Error(code), { code });
  }

  async function resolveUsagePricing(input: RecordAIUsageEventInput): Promise<PricingEvidence> {
    if (typeof input.costCny === 'number' && Number.isFinite(input.costCny) && input.costCny >= 0) {
      return { kind: 'confirmed_cost', costCny: input.costCny };
    }
    const price = await findPrice(input);
    if (!price) return { kind: 'missing' };
    const snapshot = computeCost(input, price).pricingSnapshot;
    if (!snapshot) return { kind: 'missing' };
    return {
      kind: 'snapshot',
      snapshot: Object.fromEntries(
        Object.entries(snapshot).filter(([, value]) => value != null),
      ) as unknown as AIUsagePricingSnapshot,
    };
  }

  /** Internal delivery boundary. Never calls a provider, transaction writer or balance method. */
  /** A deduplication identity guard, not an expired billable usage row. No TTL or quantities. */
  async function sealExpiredUsageIdentity(envelope: UsageEnvelope) {
    if (Date.parse(envelope.expiresAt) > Date.now()) throw deliveryError('USAGE_INVALID');
    await ensureAIUsageStorage();
    const unset = Object.fromEntries(
      [
        'businessType',
        'provider',
        'model',
        'modelKey',
        'requestId',
        'conversationId',
        'messageId',
        'actionRunId',
        'batchId',
        'itemId',
        'currency',
        'occurredAt',
        'expiresAt',
        'inputTokens',
        'outputTokens',
        'totalTokens',
        'cachedInputTokens',
        'cachedOutputTokens',
        'requestCount',
        'imageCount',
        'tokenValue',
        'costCny',
        'pricingMissing',
        'pricingSnapshot',
        'metadata',
        'status',
        'deliveryRevision',
        'deliveryDigest',
        'deliveryStatusRank',
        'deliverySource',
        'deliverySourceKey',
      ].map((key) => [key, 1]),
    );
    await AIUsageEvent.updateOne(
      {
        usageEventId: envelope.event.usageEventId,
        reportingSubjectId: envelope.reportingSubjectId,
      },
      { $set: { userId: null, deliveryTombstone: true }, $unset: unset },
      { upsert: true, setDefaultsOnInsert: false, timestamps: false },
    );
  }

  async function persistUsageEnvelope(
    envelope: UsageEnvelope,
    digest: string,
  ): Promise<{
    persisted: true;
    revision: number;
    superseded: boolean;
  }> {
    const occurredAt = new Date(envelope.occurredAt);
    const expiresAt = new Date(envelope.expiresAt);
    if (
      !Number.isFinite(occurredAt.getTime()) ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() - occurredAt.getTime() > REPORT_RETENTION_MS ||
      expiresAt <= occurredAt ||
      !Number.isSafeInteger(envelope.revision) ||
      envelope.revision < 0 ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw deliveryError('USAGE_INVALID');
    if (expiresAt.getTime() <= Date.now()) throw deliveryError('USAGE_EXPIRED');
    await ensureAIUsageStorage();
    const input = envelope.event;
    const statusRank = getStatusRank(input.status);
    if (statusRank === undefined) throw deliveryError('USAGE_INVALID');
    const result = (revision: number, superseded = false) => ({
      persisted: true as const,
      revision,
      superseded,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await AIUsageEvent.findOne({
        usageEventId: input.usageEventId,
      }).lean<IAIUsageEvent>();
      if (existing?.deliveryTombstone) return result(envelope.revision, true);
      if (existing) {
        if (existing.deliveryRevision == null || !existing.deliveryDigest)
          throw deliveryError('USAGE_LEGACY_CONFLICT');
        if (
          existing.reportingSubjectId !== envelope.reportingSubjectId ||
          existing.provider !== normalizeProvider(input.provider) ||
          existing.model !== input.model ||
          existing.businessType !== input.businessType ||
          existing.deliverySource !== envelope.source ||
          existing.deliverySourceKey !== envelope.sourceKey
        )
          throw deliveryError('USAGE_IDENTITY_CONFLICT');
        if (existing.deliveryRevision === envelope.revision) {
          if (existing.deliveryDigest !== digest) throw deliveryError('USAGE_REVISION_CONFLICT');
          return result(existing.deliveryRevision);
        }
        if (
          existing.deliveryRevision > envelope.revision ||
          getStatusRank(existing.status) > statusRank
        ) {
          return result(existing.deliveryRevision, true);
        }
      }
      // Existing price evidence never depends on replay-time model configuration.
      let price: AIUsagePricingSnapshot | null = null;
      if (existing) price = existing.pricingSnapshot ?? null;
      else if (envelope.pricing.kind === 'snapshot') price = envelope.pricing.snapshot;
      const confirmedCost =
        envelope.pricing.kind === 'confirmed_cost' &&
        !existing?.pricingSnapshot &&
        !existing?.pricingMissing
          ? envelope.pricing.costCny
          : undefined;
      const cost = computeCost({ ...input, costCny: confirmedCost }, price);
      const update = {
        status: input.status,
        inputTokens: toNumber(input.inputTokens),
        outputTokens: toNumber(input.outputTokens),
        cachedInputTokens: toNumber(input.cachedInputTokens),
        cachedOutputTokens: toNumber(input.cachedOutputTokens),
        imageCount: toNumber(input.imageCount),
        requestCount: toNumber(input.requestCount, 1),
        tokenValue: input.tokenValue,
        costCny: cost.costCny,
        pricingMissing: cost.pricingMissing,
        pricingSnapshot: existing?.pricingSnapshot ?? cost.pricingSnapshot,
        metadata: safeMetadata(input.metadata),
        deliveryRevision: envelope.revision,
        deliveryDigest: digest,
        deliveryStatusRank: statusRank,
      };
      if (existing) {
        const updated = await AIUsageEvent.findOneAndUpdate(
          {
            usageEventId: input.usageEventId,
            deliveryTombstone: { $ne: true },
            deliveryRevision: existing.deliveryRevision,
            deliveryDigest: existing.deliveryDigest,
            status: existing.status,
          },
          { $set: update },
          { new: true },
        ).lean<IAIUsageEvent>();
        if (updated) return result(envelope.revision);
        continue;
      }
      const doc = {
        ...update,
        usageEventId: input.usageEventId,
        tenantId: input.tenantId,
        userId: asObjectId(mongoose, input.userId),
        reportingSubjectId: envelope.reportingSubjectId,
        businessType: input.businessType,
        provider: normalizeProvider(input.provider),
        model: input.model,
        modelKey: input.modelKey,
        requestId: input.requestId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        actionRunId: input.actionRunId,
        batchId: input.batchId,
        itemId: input.itemId,
        currency: 'CNY',
        occurredAt,
        expiresAt,
        deliverySource: envelope.source,
        deliverySourceKey: envelope.sourceKey,
      };
      try {
        const inserted = await AIUsageEvent.findOneAndUpdate(
          { usageEventId: input.usageEventId },
          { $setOnInsert: doc },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        ).lean<IAIUsageEvent>();
        if (
          inserted?.deliveryRevision === envelope.revision &&
          inserted.deliveryDigest === digest
        ) {
          return result(envelope.revision);
        }
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
      }
    }
    throw deliveryError('USAGE_WRITE_CONTENTION');
  }

  async function summarizeEvents(start: Date, end: Date) {
    const events = await AIUsageEvent.find({
      deliveryTombstone: { $ne: true },
      occurredAt: { $gte: start, $lt: end },
    })
      .sort({ occurredAt: 1 })
      .lean<IAIUsageEvent[]>();

    const totals = emptyTotals();
    const userSeen = new Set<string>();
    for (const event of events) {
      addEventToTotals(totals, event);
      userSeen.add(event.reportingSubjectId);
    }
    totals.userCount = userSeen.size;
    return { events, totals };
  }

  function perUserCost(totals: UsageReportTotals) {
    return totals.userCount > 0
      ? fromCents(Math.round(toCents(totals.costCny) / totals.userCount))
      : 0;
  }

  async function buildComparison(
    window: ReturnType<typeof getShanghaiUsageReportWindow>,
    currentTotals: UsageReportTotals,
  ): Promise<UsageReportComparison> {
    const previousStart = new Date(window.windowStart.getTime() - DAY_MS);
    const previousEnd = window.windowStart;
    const previous = await summarizeEvents(previousStart, previousEnd);

    const sevenTotals = emptyTotals();
    let sevenWindowCount = 0;
    for (let offset = 1; offset <= 7; offset += 1) {
      const end = new Date(window.windowStart.getTime() - (offset - 1) * DAY_MS);
      const start = new Date(end.getTime() - DAY_MS);
      const summary = await summarizeEvents(start, end);
      if (summary.events.length > 0) {
        sevenWindowCount += 1;
      }
      sevenTotals.eventCount += summary.totals.eventCount;
      sevenTotals.userCount += summary.totals.userCount;
      sevenTotals.inputTokens += summary.totals.inputTokens;
      sevenTotals.outputTokens += summary.totals.outputTokens;
      sevenTotals.cachedInputTokens += summary.totals.cachedInputTokens;
      sevenTotals.cachedOutputTokens += summary.totals.cachedOutputTokens;
      sevenTotals.imageCount += summary.totals.imageCount;
      sevenTotals.requestCount += summary.totals.requestCount;
      sevenTotals.costCny = addCny(sevenTotals.costCny, summary.totals.costCny);
      sevenTotals.textCostCny = addCny(sevenTotals.textCostCny, summary.totals.textCostCny);
      sevenTotals.imageCostCny = addCny(sevenTotals.imageCostCny, summary.totals.imageCostCny);
      sevenTotals.failedCount += summary.totals.failedCount;
    }

    const previousCost = previous.totals.costCny;
    const currentPerUser = perUserCost(currentTotals);
    const previousPerUser = perUserCost(previous.totals);
    return {
      previousWindow: {
        costCny: previousCost,
        costCnyDelta: addCny(currentTotals.costCny, -previousCost),
        costCnyPercentChange:
          previousCost > 0
            ? Number((((currentTotals.costCny - previousCost) / previousCost) * 100).toFixed(2))
            : null,
        hasComparableCostBase: previousCost > 0,
        eventCount: previous.totals.eventCount,
        eventCountDelta: currentTotals.eventCount - previous.totals.eventCount,
        userCount: previous.totals.userCount,
        userCountDelta: currentTotals.userCount - previous.totals.userCount,
        perUserCostCny: previousPerUser,
        perUserCostCnyDelta: addCny(currentPerUser, -previousPerUser),
      },
      sevenWindowAverage: {
        windowCount: sevenWindowCount,
        costCny:
          sevenWindowCount > 0
            ? fromCents(Math.round(toCents(sevenTotals.costCny) / sevenWindowCount))
            : 0,
        eventCount:
          sevenWindowCount > 0 ? Math.round(sevenTotals.eventCount / sevenWindowCount) : 0,
        userCount: sevenWindowCount > 0 ? Math.round(sevenTotals.userCount / sevenWindowCount) : 0,
        perUserCostCny: sevenWindowCount > 0 ? perUserCost(sevenTotals) : 0,
        insufficientHistory: sevenWindowCount < 7,
      },
    };
  }

  async function buildAnomalies({
    window,
    currentByUser,
    settings,
  }: {
    window: ReturnType<typeof getShanghaiUsageReportWindow>;
    currentByUser: UsageReportUserRow[];
    settings: IUsageReportSettings | null;
  }): Promise<UsageReportAnomaly[]> {
    const events = await AIUsageEvent.find({
      deliveryTombstone: { $ne: true },
      occurredAt: {
        $gte: new Date(window.windowStart.getTime() - 7 * DAY_MS),
        $lt: window.windowStart,
      },
    }).lean<IAIUsageEvent[]>();
    const bySubjectWindow = new Map<string, Map<number, number>>();
    for (const event of events) {
      const windowIndex = Math.floor(
        (window.windowStart.getTime() - event.occurredAt.getTime() - 1) / DAY_MS,
      );
      if (windowIndex < 0 || windowIndex > 6) {
        continue;
      }
      const subjectMap = bySubjectWindow.get(event.reportingSubjectId) ?? new Map<number, number>();
      subjectMap.set(windowIndex, addCny(subjectMap.get(windowIndex) ?? 0, event.costCny));
      bySubjectWindow.set(event.reportingSubjectId, subjectMap);
    }

    const threshold = toNumber(settings?.thresholdCostCny);
    const anomalies: UsageReportAnomaly[] = [];
    for (const row of currentByUser) {
      const subjectWindows = bySubjectWindow.get(row.reportingSubjectId);
      if (subjectWindows && subjectWindows.size >= 7) {
        const total = Array.from(subjectWindows.values()).reduce(
          (sum, value) => addCny(sum, value),
          0,
        );
        const baseline = fromCents(Math.round(toCents(total) / subjectWindows.size));
        if (baseline > 0 && row.costCny > baseline * 2) {
          anomalies.push({
            type: 'seven_window_spike',
            reportingSubjectId: row.reportingSubjectId,
            userId: row.userId,
            name: row.name,
            email: row.email,
            currentCostCny: row.costCny,
            baselineCostCny: baseline,
            multiplier: Number((row.costCny / baseline).toFixed(2)),
            reason: '当前用户成本超过过去7个完整窗口平均值的2倍',
          });
        }
      }
      if (threshold > 0 && row.costCny >= threshold) {
        anomalies.push({
          type: 'fixed_amount_threshold',
          reportingSubjectId: row.reportingSubjectId,
          userId: row.userId,
          name: row.name,
          email: row.email,
          currentCostCny: row.costCny,
          thresholdSnapshotCny: threshold,
          reason: '当前用户成本达到固定金额告警阈值',
        });
      }
    }
    return anomalies;
  }

  async function generateDailyUsageReport({ now = new Date() }: { now?: Date } = {}) {
    await ensureAIUsageStorage();
    const window = getShanghaiUsageReportWindow(now);
    const { events, totals } = await summarizeEvents(window.windowStart, window.windowEnd);

    const userIds = Array.from(
      new Set(events.map((event) => event.userId?.toString()).filter(Boolean) as string[]),
    );
    const users = await User.find({ _id: { $in: userIds } })
      .select('name email approvalStatus reportingSubjectId')
      .lean<IUser[]>();
    const userById = new Map(users.map((user) => [user._id.toString(), user]));

    const userSeen = new Set<string>();
    const byUserMap = new Map<string, UsageReportUserRow>();
    const byModelMap = new Map<string, UsageReportModelRow>();
    const byBusinessMap = new Map<string, UsageReportBusinessRow>();
    const hourlyMap = new Map<string, UsageReportHourlyRow>();
    let missingPricingCount = 0;

    for (const event of events) {
      userSeen.add(event.reportingSubjectId);
      if (event.pricingMissing) {
        missingPricingCount += 1;
      }

      const userId = event.userId?.toString();
      const user = userId ? userById.get(userId) : undefined;
      const userKey = event.reportingSubjectId;
      if (!byUserMap.has(userKey)) {
        const isDeletedSubject = !user && event.reportingSubjectId;
        byUserMap.set(userKey, {
          ...emptyTotals(),
          userId,
          reportingSubjectId: event.reportingSubjectId,
          name: user?.name ?? (isDeletedSubject ? getDeletedUsageSubjectLabel(userKey) : undefined),
          email: user?.email,
          approvalStatus: user?.approvalStatus,
        });
      }
      addEventToTotals(byUserMap.get(userKey) as UsageReportUserRow, event);

      const modelKey = `${event.provider}:${event.model}:${event.businessType}`;
      if (!byModelMap.has(modelKey)) {
        byModelMap.set(modelKey, {
          ...emptyTotals(),
          provider: event.provider,
          model: event.model,
          businessType: event.businessType,
        });
      }
      addEventToTotals(byModelMap.get(modelKey) as UsageReportModelRow, event);

      if (!byBusinessMap.has(event.businessType)) {
        byBusinessMap.set(event.businessType, {
          ...emptyTotals(),
          businessType: event.businessType,
        });
      }
      addEventToTotals(byBusinessMap.get(event.businessType) as UsageReportBusinessRow, event);

      const hourKey = formatHourShanghai(event.occurredAt);
      if (!hourlyMap.has(hourKey)) {
        hourlyMap.set(hourKey, { ...emptyTotals(), hour: hourKey });
      }
      addEventToTotals(hourlyMap.get(hourKey) as UsageReportHourlyRow, event);
    }

    totals.userCount = userSeen.size;
    for (const row of byUserMap.values()) {
      row.userCount = 1;
    }
    for (const row of byModelMap.values()) {
      row.userCount = 0;
    }
    for (const row of byBusinessMap.values()) {
      row.userCount = 0;
    }
    for (const row of hourlyMap.values()) {
      row.userCount = 0;
    }

    const settings = await UsageReportSettings.findOne({
      key: 'daily_usage_report',
    }).lean<IUsageReportSettings>();
    const comparison = await buildComparison(window, totals);
    const anomalies = await buildAnomalies({
      window,
      currentByUser: Array.from(byUserMap.values()),
      settings,
    });
    if (missingPricingCount > 0) {
      anomalies.push({
        type: 'missing_pricing',
        reason: `${missingPricingCount} events have missing pricing`,
      });
    }

    const reportDoc = {
      periodKey: window.periodKey,
      timezone: window.timezone,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      generatedAt: now,
      status: 'generated',
      recipientEmails: [],
      totals,
      byUser: Array.from(byUserMap.values()).sort((a, b) => b.costCny - a.costCny),
      byModel: Array.from(byModelMap.values()).sort((a, b) => b.costCny - a.costCny),
      byBusiness: Array.from(byBusinessMap.values()).sort((a, b) => b.costCny - a.costCny),
      hourly: Array.from(hourlyMap.values()).sort((a, b) => a.hour.localeCompare(b.hour)),
      comparison,
      anomalies,
      missingPricingCount,
      expiresAt: new Date(now.getTime() + REPORT_RETENTION_MS),
    };

    return UsageReport.findOneAndUpdate(
      { periodKey: window.periodKey },
      { $setOnInsert: reportDoc },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean<IUsageReport>();
  }

  async function getUsageReportSettings() {
    await ensureAIUsageStorage();
    return UsageReportSettings.findOneAndUpdate(
      { key: 'daily_usage_report' },
      { $setOnInsert: { key: 'daily_usage_report', enabled: false, recipients: [] } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean<IUsageReportSettings>();
  }

  async function anonymizeUsageForDeletedUser({
    userId,
    reportingSubjectId,
    now = new Date(),
  }: {
    userId?: Types.ObjectId | string | null;
    reportingSubjectId: string;
    now?: Date;
  }) {
    await ensureAIUsageStorage();
    const objectId = asObjectId(mongoose, userId);
    const filter: FilterQuery<IAIUsageEvent> = objectId
      ? { $or: [{ userId: objectId }, { reportingSubjectId }] }
      : { reportingSubjectId };
    const events = await AIUsageEvent.find(filter).select('_id metadata').lean<IAIUsageEvent[]>();
    if (!events.length) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    const result = await tenantSafeBulkWrite(
      AIUsageEvent,
      events.map((event) => {
        const scrubbedMetadata = scrubDeletedIdentityMetadata(event.metadata);
        const hasScrubbedMetadata =
          scrubbedMetadata &&
          typeof scrubbedMetadata === 'object' &&
          !Array.isArray(scrubbedMetadata);
        return {
          updateOne: {
            filter: { _id: event._id },
            update: {
              $set: {
                userId: null,
                anonymizedAt: now,
                ...(hasScrubbedMetadata
                  ? { metadata: scrubbedMetadata as Record<string, unknown> }
                  : {}),
              },
              ...(hasScrubbedMetadata ? {} : { $unset: { metadata: '' } }),
            },
          },
        };
      }),
    );

    return {
      matchedCount: result.matchedCount ?? events.length,
      modifiedCount: result.modifiedCount ?? 0,
    };
  }

  async function anonymizeUsageReportsForDeletedUser({
    userId,
    reportingSubjectId,
  }: {
    userId?: Types.ObjectId | string | null;
    reportingSubjectId: string;
  }) {
    await ensureAIUsageStorage();
    const userIdString = userId?.toString?.() ?? (userId ? String(userId) : undefined);
    const cutoff = new Date(Date.now() - REPORT_RETENTION_MS);
    const reports = await UsageReport.find({
      windowEnd: { $gte: cutoff },
      $or: [
        {
          byUser: {
            $elemMatch: {
              $or: [{ reportingSubjectId }, ...(userIdString ? [{ userId: userIdString }] : [])],
            },
          },
        },
        {
          anomalies: {
            $elemMatch: {
              $or: [{ reportingSubjectId }, ...(userIdString ? [{ userId: userIdString }] : [])],
            },
          },
        },
      ],
    });
    const displayName = getDeletedUsageSubjectLabel(reportingSubjectId);
    let modifiedCount = 0;
    for (const report of reports) {
      let changed = false;
      for (const row of report.byUser) {
        if (row.reportingSubjectId === reportingSubjectId || row.userId === userIdString) {
          row.reportingSubjectId = reportingSubjectId;
          row.userId = undefined;
          row.name = displayName;
          row.email = undefined;
          row.approvalStatus = undefined;
          changed = true;
        }
      }
      for (const row of report.anomalies || []) {
        if (row.reportingSubjectId === reportingSubjectId || row.userId === userIdString) {
          row.reportingSubjectId = reportingSubjectId;
          row.userId = undefined;
          row.name = displayName;
          row.email = undefined;
          changed = true;
        }
      }
      if (changed) {
        report.markModified('byUser');
        report.markModified('anomalies');
        await report.save();
        modifiedCount += 1;
      }
    }
    return { matchedCount: reports.length, modifiedCount };
  }

  return {
    anonymizeUsageForDeletedUser,
    anonymizeUsageReportsForDeletedUser,
    ensureAIUsageStorage,
    getDeletedUsageSubjectLabel,
    getOrCreateReportingSubjectId,
    recordAIUsageEvent,
    persistUsageEnvelope,
    sealExpiredUsageIdentity,
    resolveUsagePricing,
    upsertAIModelPrice,
    generateDailyUsageReport,
    getUsageReportSettings,
  };
}

export type AIUsageMethods = ReturnType<typeof createAIUsageMethods>;
