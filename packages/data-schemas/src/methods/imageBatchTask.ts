import { usageSourceUpdate, usageSourceAcknowledgement } from './usageSourceUpdate';
import type { Model } from 'mongoose';
import type {
  CreateImageBatchTaskInput,
  IImageBatchTask,
  ImageBatchTaskStatus,
  UpdateImageBatchTaskInput,
} from '~/types/imageBatchTask';
import { createIndexesWithRetry } from '~/utils/retry';

function getModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.ImageBatchTask as Model<IImageBatchTask>;
}

export function createImageBatchTaskMethods(mongoose: typeof import('mongoose')) {
  const ImageBatchTask = getModel(mongoose);
  let storageInitialization: Promise<void> | undefined;

  function ensureImageBatchTaskStorage() {
    if (!storageInitialization) {
      storageInitialization = (async () => {
        try {
          await ImageBatchTask.createCollection();
        } catch (error) {
          const mongoError = error as { code?: number; codeName?: string };
          if (mongoError.code !== 48 && mongoError.codeName !== 'NamespaceExists') {
            throw error;
          }
        }
        await createIndexesWithRetry(ImageBatchTask);
      })().catch((error) => {
        storageInitialization = undefined;
        throw error;
      });
    }
    return storageInitialization;
  }

  async function createImageBatchTaskItem(input: CreateImageBatchTaskInput) {
    await ensureImageBatchTaskStorage();
    return ImageBatchTask.create(input);
  }

  async function getImageBatchTaskItem({
    batchId,
    itemId,
    includeSensitive = false,
  }: {
    batchId: string;
    itemId: string;
    includeSensitive?: boolean;
  }) {
    const query = ImageBatchTask.findOne({
      batchId,
      itemId,
      'usageDelivery.payloadPruned': { $ne: true },
    });
    if (includeSensitive) {
      query.select('+providerResult +usageContext +usageDelivery');
    }
    return query.lean();
  }

  async function getImageBatchTaskItems({
    batchId,
    userId,
    includeSensitive = false,
  }: {
    batchId: string;
    userId?: string;
    includeSensitive?: boolean;
  }) {
    const query = ImageBatchTask.find({
      'usageDelivery.payloadPruned': { $ne: true },
      batchId,
      ...(userId ? { userId } : {}),
    }).sort({
      createdAt: 1,
    });
    if (includeSensitive) {
      query.select('+providerResult +usageContext +usageDelivery');
    }
    return query.lean();
  }

  async function acquireImageBatchTaskLease({
    batchId,
    itemId,
    workerId,
    leaseMs,
    statuses,
    now = new Date(),
  }: {
    batchId: string;
    itemId: string;
    workerId: string;
    leaseMs: number;
    statuses: ImageBatchTaskStatus[];
    now?: Date;
  }) {
    const processingLeaseUntil = new Date(now.getTime() + leaseMs);
    return ImageBatchTask.findOneAndUpdate(
      {
        batchId,
        itemId,
        status: { $in: statuses },
        $or: [
          { processingLeaseUntil: null },
          { processingLeaseUntil: { $exists: false } },
          { processingLeaseUntil: { $lte: now } },
          { processingWorkerId: workerId },
        ],
      },
      {
        $set: { processingWorkerId: workerId, processingLeaseUntil },
        $unset: { expiresAt: 1 },
      },
      { new: true },
    )
      .select('+providerResult +usageContext +usageDelivery')
      .lean();
  }

  async function updateImageBatchTaskItemWithLease({
    batchId,
    itemId,
    workerId,
    statuses,
    updates,
    unsetFields = [],
    releaseLease = false,
    now = new Date(),
  }: {
    batchId: string;
    itemId: string;
    workerId: string;
    statuses: ImageBatchTaskStatus[];
    updates: UpdateImageBatchTaskInput;
    unsetFields?: Array<keyof IImageBatchTask>;
    releaseLease?: boolean;
    now?: Date;
  }) {
    const nextUpdates: UpdateImageBatchTaskInput = { ...updates };
    if (releaseLease) {
      nextUpdates.processingWorkerId = null;
      nextUpdates.processingLeaseUntil = null;
    }
    const update = usageSourceUpdate(nextUpdates, unsetFields);
    return ImageBatchTask.findOneAndUpdate(
      {
        batchId,
        itemId,
        status: { $in: statuses },
        processingWorkerId: workerId,
        processingLeaseUntil: { $gt: now },
      },
      update,
      { new: true },
    )
      .select('+providerResult +usageContext +usageDelivery')
      .lean();
  }

  async function updateImageBatchTaskItem({
    batchId,
    itemId,
    statuses,
    updates,
    unsetFields = [],
    expectedRetryCount,
    expectedInternalJobItemId,
  }: {
    batchId: string;
    itemId: string;
    statuses: ImageBatchTaskStatus[];
    expectedRetryCount?: number;
    expectedInternalJobItemId?: string | null;
    updates: UpdateImageBatchTaskInput;
    unsetFields?: Array<keyof IImageBatchTask>;
  }) {
    return ImageBatchTask.findOneAndUpdate(
      {
        batchId,
        itemId,
        status: { $in: statuses },
        ...(expectedRetryCount === undefined
          ? {}
          : {
              retryCount: expectedRetryCount === 0 ? { $in: [0, null] } : expectedRetryCount,
              internalJobItemId: expectedInternalJobItemId || null,
            }),
      },
      usageSourceUpdate(updates, unsetFields),
      { new: true },
    )
      .select('+providerResult +usageContext +usageDelivery')
      .lean();
  }

  async function updateImageBatchTaskUsageDelivery({
    batchId,
    itemId,
    eventId,
    revision,
    state,
  }: {
    batchId: string;
    itemId: string;
    eventId?: string;
    revision: number;
    state: 'pending' | 'durable' | 'persisted' | 'review';
  }) {
    return ImageBatchTask.findOneAndUpdate(
      {
        batchId,
        itemId,
        'usageContext.eventId': eventId || null,
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
      .select('+usageContext +usageDelivery +providerResult')
      .lean();
  }

  return {
    acquireImageBatchTaskLease,
    updateImageBatchTaskUsageDelivery,
    createImageBatchTaskItem,
    getImageBatchTaskItem,
    getImageBatchTaskItems,
    updateImageBatchTaskItem,
    updateImageBatchTaskItemWithLease,
  };
}

export type ImageBatchTaskMethods = ReturnType<typeof createImageBatchTaskMethods>;
