import { usageSourceUpdate, usageSourceAcknowledgement } from './usageSourceUpdate';
import type { Model } from 'mongoose';
import type {
  CreateImageGenerationJobInput,
  IImageGenerationJob,
  ImageGenerationJobStatus,
  UpdateImageGenerationJobInput,
} from '~/types/imageGenerationJob';
import { createIndexesWithRetry } from '~/utils/retry';

function getModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.ImageGenerationJob as Model<IImageGenerationJob>;
}

export function createImageGenerationJobMethods(mongoose: typeof import('mongoose')) {
  const ImageGenerationJob = getModel(mongoose);
  let storageInitialization: Promise<void> | undefined;

  function ensureImageGenerationJobStorage() {
    if (!storageInitialization) {
      storageInitialization = (async () => {
        try {
          await ImageGenerationJob.createCollection();
        } catch (error) {
          const mongoError = error as { code?: number; codeName?: string };
          if (mongoError.code !== 48 && mongoError.codeName !== 'NamespaceExists') {
            throw error;
          }
        }
        await createIndexesWithRetry(ImageGenerationJob);
      })().catch((error) => {
        storageInitialization = undefined;
        throw error;
      });
    }
    return storageInitialization;
  }

  async function createImageGenerationJob(input: CreateImageGenerationJobInput) {
    await ensureImageGenerationJobStorage();
    return ImageGenerationJob.create(input);
  }

  function getIdempotencyQuery(input: CreateImageGenerationJobInput) {
    const asyncVersion = input.asyncVersion ?? 2;
    if (input.batchTaskId && input.itemId) {
      return {
        userId: input.userId,
        batchTaskId: input.batchTaskId,
        itemId: input.itemId,
        asyncVersion,
      };
    }
    if (input.frontendTaskId) {
      return {
        userId: input.userId,
        frontendTaskId: input.frontendTaskId,
        businessType: input.businessType,
        asyncVersion,
      };
    }
    return null;
  }

  async function findOrCreateImageGenerationJob(input: CreateImageGenerationJobInput) {
    await ensureImageGenerationJobStorage();
    try {
      const created = await ImageGenerationJob.create(input);
      const job = typeof created.toObject === 'function' ? created.toObject() : created;
      return { job, deduplicated: false };
    } catch (error) {
      const mongoError = error as { code?: number };
      const idempotencyQuery = getIdempotencyQuery(input);
      if (mongoError.code !== 11000 || !idempotencyQuery) {
        throw error;
      }
      const query = ImageGenerationJob.findOne({
        ...idempotencyQuery,
        'usageDelivery.payloadPruned': { $ne: true },
      });
      query.select('+payload +result +usageContext +usageDelivery');
      const existing = await query.lean();
      if (!existing) {
        throw error;
      }
      return { job: existing, deduplicated: true };
    }
  }

  async function getImageGenerationJob({
    internalTaskId,
    userId,
    includeSensitive = false,
  }: {
    internalTaskId: string;
    userId?: string;
    includeSensitive?: boolean;
  }) {
    const query = ImageGenerationJob.findOne({
      'usageDelivery.payloadPruned': { $ne: true },
      internalTaskId,
      ...(userId ? { userId } : {}),
    });
    if (includeSensitive) {
      query.select('+payload +result +usageContext +usageDelivery');
    }
    return query.lean();
  }

  async function getImageGenerationJobByBatchItem({
    userId,
    tenantId,
    batchTaskId,
    itemId,
    model,
  }: {
    userId: string;
    tenantId?: string;
    batchTaskId: string;
    itemId: string;
    model: string;
  }) {
    return ImageGenerationJob.findOne({
      'usageDelivery.payloadPruned': { $ne: true },
      userId,
      tenantId: tenantId || null,
      batchTaskId,
      itemId,
      model,
      provider: 'apimart',
      asyncVersion: 2,
      businessType: 'batch_image_generation',
    }).lean();
  }

  async function acquireImageGenerationJobLease({
    workerId,
    leaseMs,
    statuses,
    provider = 'apimart',
    model = 'gpt-image-2',
    models,
    rolloutModes,
    now = new Date(),
  }: {
    workerId: string;
    leaseMs: number;
    statuses: ImageGenerationJobStatus[];
    provider?: string;
    model?: string;
    models?: string[];
    rolloutModes?: Array<NonNullable<IImageGenerationJob['rolloutMode']>>;
    now?: Date;
  }) {
    await ensureImageGenerationJobStorage();
    const workerLeaseUntil = new Date(now.getTime() + leaseMs);
    const rolloutModeFilter = Array.isArray(rolloutModes)
      ? { rolloutMode: { $in: rolloutModes } }
      : {};
    return ImageGenerationJob.findOneAndUpdate(
      {
        provider,
        model: models !== undefined ? { $in: models } : model,
        ...rolloutModeFilter,
        asyncVersion: 2,
        workerEligible: true,
        status: { $in: statuses },
        $and: [
          {
            $or: [
              { workerLeaseUntil: null },
              { workerLeaseUntil: { $exists: false } },
              { workerLeaseUntil: { $lte: now } },
            ],
          },
          {
            $or: [
              { nextPollAt: null },
              { nextPollAt: { $exists: false } },
              { nextPollAt: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: { workerOwner: workerId, workerLeaseUntil },
        $inc: { runVersion: 1 },
        $unset: { expiresAt: 1 },
      },
      { new: true, sort: { queueEnteredAt: 1, createdAt: 1 } },
    )
      .select('+payload +result +usageContext +usageDelivery')
      .lean();
  }

  async function acquireImageEgressJobLease({
    workerId,
    leaseMs,
    statuses,
    rolloutModes,
    allowset,
    now = new Date(),
  }: {
    workerId: string;
    leaseMs: number;
    statuses: ImageGenerationJobStatus[];
    rolloutModes: Array<NonNullable<IImageGenerationJob['rolloutMode']>>;
    allowset: Array<Pick<IImageGenerationJob, 'provider' | 'model'>>;
    now?: Date;
  }) {
    if (!Array.isArray(allowset) || allowset.length === 0) {
      return null;
    }
    await ensureImageGenerationJobStorage();
    const workerLeaseUntil = new Date(now.getTime() + leaseMs);
    return ImageGenerationJob.findOneAndUpdate(
      {
        asyncVersion: 3,
        workerFamily: 'image-egress-v1',
        workerEligible: true,
        status: { $in: statuses },
        rolloutMode: { $in: rolloutModes },
        $or: allowset.map(({ provider, model }) => ({ provider, model })),
        $and: [
          {
            $or: [
              { workerLeaseUntil: null },
              { workerLeaseUntil: { $exists: false } },
              { workerLeaseUntil: { $lte: now } },
            ],
          },
          {
            $or: [
              { nextAttemptAt: null },
              { nextAttemptAt: { $exists: false } },
              { nextAttemptAt: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: { workerOwner: workerId, workerLeaseUntil },
        $inc: { runVersion: 1 },
        $unset: { expiresAt: 1 },
      },
      { new: true, sort: { queueEnteredAt: 1, createdAt: 1 } },
    )
      .select('+payload +result +providerMetadata +usageContext +usageDelivery')
      .lean();
  }

  async function findImageEgressJobByIdentity({
    userId,
    frontendTaskId,
    businessType,
    batchTaskId,
    itemId,
  }: {
    userId: string;
    frontendTaskId?: string;
    businessType?: string;
    batchTaskId?: string;
    itemId?: string;
  }) {
    const hasBatchIdentity = Boolean(batchTaskId?.trim() && itemId?.trim());
    const hasFrontendIdentity = Boolean(frontendTaskId?.trim() && businessType?.trim());
    if (!hasBatchIdentity && !hasFrontendIdentity) {
      return null;
    }
    const identity = hasBatchIdentity
      ? { userId, batchTaskId, itemId }
      : { userId, frontendTaskId, businessType };
    return ImageGenerationJob.findOne({
      'usageDelivery.payloadPruned': { $ne: true },
      ...identity,
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
    })
      .select('+payload +result +providerMetadata +usageContext +usageDelivery')
      .lean();
  }

  async function failInactiveImageEgressJob({
    internalTaskId,
    errorCode,
    error,
    now = new Date(),
  }: {
    internalTaskId: string;
    errorCode: string;
    error: string;
    now?: Date;
  }) {
    return ImageGenerationJob.findOneAndUpdate(
      {
        internalTaskId,
        asyncVersion: 3,
        workerFamily: 'image-egress-v1',
        status: 'waiting',
        workerEligible: false,
        $and: [
          { $or: [{ workerOwner: null }, { workerOwner: { $exists: false } }] },
          {
            $or: [
              { workerLeaseUntil: null },
              { workerLeaseUntil: { $exists: false } },
              { workerLeaseUntil: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: {
          status: 'failed',
          workerEligible: true,
          errorCode,
          error,
          completedAt: now,
        },
      },
      { new: true },
    )
      .select('+payload +result +providerMetadata +usageContext +usageDelivery')
      .lean();
  }

  async function hasNonterminalImageEgressJobReferencingFile({ fileId }: { fileId: string }) {
    const count = await ImageGenerationJob.countDocuments({
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
      status: { $in: ['waiting', 'submitting', 'polling'] },
      'payload.imageInputRefs.fileId': fileId,
    });
    return count > 0;
  }

  async function updateImageGenerationJobWithLease({
    internalTaskId,
    workerId,
    statuses,
    updates,
    unsetFields = [],
    releaseLease = false,
    allowExpiredLease = false,
    now = new Date(),
  }: {
    internalTaskId: string;
    workerId: string;
    statuses: ImageGenerationJobStatus[];
    updates: UpdateImageGenerationJobInput;
    unsetFields?: Array<keyof IImageGenerationJob>;
    releaseLease?: boolean;
    allowExpiredLease?: boolean;
    now?: Date;
  }) {
    const nextUpdates: UpdateImageGenerationJobInput = { ...updates };
    if (releaseLease) {
      nextUpdates.workerOwner = null;
      nextUpdates.workerLeaseUntil = null;
    }
    return ImageGenerationJob.findOneAndUpdate(
      {
        internalTaskId,
        status: { $in: statuses },
        workerOwner: workerId,
        ...(allowExpiredLease
          ? { provider: 'apimart', asyncVersion: 2 }
          : { workerLeaseUntil: { $gt: now } }),
      },
      usageSourceUpdate(nextUpdates, unsetFields),
      { new: true },
    )
      .select('+payload +result +providerMetadata +usageContext +usageDelivery')
      .lean();
  }

  async function updateImageGenerationJob({
    internalTaskId,
    statuses,
    updates,
    unsetFields = [],
  }: {
    internalTaskId: string;
    statuses: ImageGenerationJobStatus[];
    updates: UpdateImageGenerationJobInput;
    unsetFields?: Array<keyof IImageGenerationJob>;
  }) {
    return ImageGenerationJob.findOneAndUpdate(
      { internalTaskId, status: { $in: statuses } },
      usageSourceUpdate(updates, unsetFields),
      { new: true },
    )
      .select('+payload +result +providerMetadata +usageContext +usageDelivery')
      .lean();
  }

  async function countActiveImageGenerationProviderTasks({
    resourceKey,
    excludeInternalTaskId,
    excludeInternalTaskIds = [],
    provider = 'apimart',
    model = 'gpt-image-2',
    models,
  }: {
    resourceKey?: string;
    excludeInternalTaskId?: string;
    excludeInternalTaskIds?: string[];
    provider?: string;
    model?: string;
    models?: string[];
  }) {
    await ensureImageGenerationJobStorage();
    return ImageGenerationJob.countDocuments({
      provider,
      model: models !== undefined ? { $in: models } : model,
      ...(resourceKey ? { resourceKey } : {}),
      ...(excludeInternalTaskId || excludeInternalTaskIds.length
        ? {
            internalTaskId: {
              $nin: [
                ...excludeInternalTaskIds,
                ...(excludeInternalTaskId ? [excludeInternalTaskId] : []),
              ],
            },
          }
        : {}),
      asyncVersion: 2,
      workerEligible: true,
      status: { $in: ['submitting', 'submitted', 'polling', 'status_unknown'] },
      // Unknown outcome without a task ID is untrackable, not local capacity ownership.
      // It remains unclaimable; releasing capacity must never imply provider failure or retry.
      $or: [
        { status: 'submitting' },
        {
          submittedToProvider: true,
          providerTaskId: { $exists: true, $type: 'string', $ne: '' },
        },
      ],
    });
  }

  async function updateImageGenerationJobUsageDelivery({
    internalTaskId,
    revision,
    state,
  }: {
    internalTaskId: string;
    revision: number;
    state: 'pending' | 'durable' | 'persisted' | 'review';
  }) {
    return ImageGenerationJob.findOneAndUpdate(
      {
        internalTaskId,
        'usageDelivery.revision': revision,
        ...(state === 'persisted'
          ? {}
          : {
              'usageDelivery.state': {
                $in: state === 'pending' ? ['pending'] : ['pending', 'durable', 'review'],
              },
            }),
      },
      usageSourceAcknowledgement(state),
      { new: true },
    )
      .select('+usageContext +usageDelivery +payload +result')
      .lean();
  }

  return {
    acquireImageEgressJobLease,
    acquireImageGenerationJobLease,
    countActiveImageGenerationProviderTasks,
    createImageGenerationJob,
    findOrCreateImageGenerationJob,
    findImageEgressJobByIdentity,
    ensureImageGenerationJobStorage,
    failInactiveImageEgressJob,
    getImageGenerationJob,
    getImageGenerationJobByBatchItem,
    hasNonterminalImageEgressJobReferencingFile,
    updateImageGenerationJob,
    updateImageGenerationJobUsageDelivery,
    updateImageGenerationJobWithLease,
  };
}

export type ImageGenerationJobMethods = ReturnType<typeof createImageGenerationJobMethods>;
