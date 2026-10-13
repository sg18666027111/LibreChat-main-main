import type { Model } from 'mongoose';
import type {
  CreateSkuBatchTaskInput,
  ISkuBatchTask,
  SkuBatchTaskStatus,
  UpdateSkuBatchTaskInput,
} from '~/types/skuBatchTask';
import { createIndexesWithRetry } from '~/utils/retry';

function getModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.SkuBatchTask as Model<ISkuBatchTask>;
}

function getOwnershipFilter({ userId, tenantId }: { userId?: string; tenantId?: string }) {
  return {
    ...(userId ? { userId } : {}),
    ...(tenantId ? { tenantId } : { tenantId: null }),
  };
}

export function createSkuBatchTaskMethods(mongoose: typeof import('mongoose')) {
  const SkuBatchTask = getModel(mongoose);
  let storageInitialization: Promise<void> | undefined;

  function ensureSkuBatchTaskStorage() {
    if (!storageInitialization) {
      storageInitialization = (async () => {
        try {
          await SkuBatchTask.createCollection();
        } catch (error) {
          const mongoError = error as { code?: number; codeName?: string };
          if (mongoError.code !== 48 && mongoError.codeName !== 'NamespaceExists') {
            throw error;
          }
        }
        await createIndexesWithRetry(SkuBatchTask);
      })().catch((error) => {
        storageInitialization = undefined;
        throw error;
      });
    }
    return storageInitialization;
  }

  async function createSkuBatchTaskItem(input: CreateSkuBatchTaskInput) {
    await ensureSkuBatchTaskStorage();
    return SkuBatchTask.create(input);
  }

  async function getSkuBatchTaskItem({
    batchId,
    itemId,
    userId,
    tenantId,
  }: {
    batchId: string;
    itemId: string;
    userId?: string;
    tenantId?: string;
  }) {
    return SkuBatchTask.findOne({
      batchId,
      itemId,
      ...getOwnershipFilter({ userId, tenantId }),
    }).lean();
  }

  async function getSkuBatchTaskItems({
    batchId,
    userId,
    tenantId,
  }: {
    batchId: string;
    userId?: string;
    tenantId?: string;
  }) {
    return SkuBatchTask.find({
      batchId,
      ...getOwnershipFilter({ userId, tenantId }),
    })
      .sort({ itemIndex: 1, createdAt: 1 })
      .lean();
  }

  async function acquireSkuBatchTaskLease({
    batchId,
    itemId,
    workerId,
    leaseMs,
    statuses = ['pending'],
    now = new Date(),
  }: {
    batchId: string;
    itemId: string;
    workerId: string;
    leaseMs: number;
    statuses?: SkuBatchTaskStatus[];
    now?: Date;
  }) {
    const processingLeaseUntil = new Date(now.getTime() + leaseMs);
    return SkuBatchTask.findOneAndUpdate(
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
        $set: {
          status: 'running',
          processingWorkerId: workerId,
          processingLeaseUntil,
        },
        $unset: { expiresAt: 1 },
      },
      { new: true },
    ).lean();
  }

  async function updateSkuBatchTaskItemWithLease({
    batchId,
    itemId,
    workerId,
    statuses,
    updates,
    now = new Date(),
  }: {
    batchId: string;
    itemId: string;
    workerId: string;
    statuses: SkuBatchTaskStatus[];
    updates: UpdateSkuBatchTaskInput;
    now?: Date;
  }) {
    return SkuBatchTask.findOneAndUpdate(
      {
        batchId,
        itemId,
        status: { $in: statuses },
        processingWorkerId: workerId,
        processingLeaseUntil: { $gt: now },
      },
      {
        $set: {
          ...updates,
          processingWorkerId: null,
          processingLeaseUntil: null,
        },
      },
      { new: true },
    ).lean();
  }

  async function updateSkuBatchTaskItem({
    batchId,
    itemId,
    userId,
    tenantId,
    statuses,
    updates,
  }: {
    batchId: string;
    itemId: string;
    userId?: string;
    tenantId?: string;
    statuses: SkuBatchTaskStatus[];
    updates: UpdateSkuBatchTaskInput;
  }) {
    return SkuBatchTask.findOneAndUpdate(
      {
        batchId,
        itemId,
        status: { $in: statuses },
        ...getOwnershipFilter({ userId, tenantId }),
      },
      { $set: updates },
      { new: true },
    ).lean();
  }

  return {
    acquireSkuBatchTaskLease,
    createSkuBatchTaskItem,
    getSkuBatchTaskItem,
    getSkuBatchTaskItems,
    updateSkuBatchTaskItem,
    updateSkuBatchTaskItemWithLease,
  };
}

export type SkuBatchTaskMethods = ReturnType<typeof createSkuBatchTaskMethods>;
