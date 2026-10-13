import type { Model } from 'mongoose';
import type { IImageProviderConcurrencyLease } from '~/types/imageProviderConcurrencyLease';
import { createIndexesWithRetry } from '~/utils/retry';

function getModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.ImageProviderConcurrencyLease as Model<IImageProviderConcurrencyLease>;
}

function getSlotLeaseId(resourceKey: string, slot: number) {
  return `${resourceKey}:slot:${slot}`;
}

function isDuplicateKeyError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: number }).code === 11000 ||
      (error as { codeName?: string }).codeName === 'DuplicateKey')
  );
}

export function createImageProviderConcurrencyLeaseMethods(mongoose: typeof import('mongoose')) {
  const ImageProviderConcurrencyLease = getModel(mongoose);
  let storageInitialization: Promise<void> | undefined;

  function ensureImageProviderConcurrencyLeaseStorage() {
    if (!storageInitialization) {
      storageInitialization = (async () => {
        try {
          await ImageProviderConcurrencyLease.createCollection();
        } catch (error) {
          const mongoError = error as { code?: number; codeName?: string };
          if (mongoError.code !== 48 && mongoError.codeName !== 'NamespaceExists') {
            throw error;
          }
        }
        await createIndexesWithRetry(ImageProviderConcurrencyLease);
      })().catch((error) => {
        storageInitialization = undefined;
        throw error;
      });
    }
    return storageInitialization;
  }

  async function acquireImageProviderConcurrencyLease({
    resourceKey,
    ownerId,
    internalTaskId,
    providerTaskId,
    maxConcurrency,
    leaseMs,
    now = new Date(),
  }: {
    resourceKey: string;
    ownerId: string;
    internalTaskId: string;
    providerTaskId?: string;
    maxConcurrency: number;
    leaseMs: number;
    now?: Date;
  }) {
    await ensureImageProviderConcurrencyLeaseStorage();
    const slotCount = Math.max(1, Math.floor(maxConcurrency || 1));
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);

    for (let slot = 0; slot < slotCount; slot += 1) {
      const leaseId = getSlotLeaseId(resourceKey, slot);
      try {
        const lease = await ImageProviderConcurrencyLease.findOneAndUpdate(
          {
            _id: leaseId,
            $or: [
              { leaseExpiresAt: null },
              { leaseExpiresAt: { $exists: false } },
              { leaseExpiresAt: { $lte: now } },
              { internalTaskId },
            ],
          },
          {
            $set: {
              resourceKey,
              slot,
              ownerId,
              internalTaskId,
              ...(providerTaskId ? { providerTaskId } : {}),
              leaseExpiresAt,
              heartbeatAt: now,
            },
          },
          { new: true, upsert: true },
        ).lean();
        if (lease) {
          return lease;
        }
      } catch (error) {
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
      }
    }

    return null;
  }

  async function heartbeatImageProviderConcurrencyLease({
    leaseId,
    ownerId,
    internalTaskId,
    providerTaskId,
    leaseMs,
    now = new Date(),
  }: {
    leaseId: string;
    ownerId: string;
    internalTaskId: string;
    providerTaskId?: string;
    leaseMs: number;
    now?: Date;
  }) {
    await ensureImageProviderConcurrencyLeaseStorage();
    return ImageProviderConcurrencyLease.findOneAndUpdate(
      {
        _id: leaseId,
        ownerId,
        internalTaskId,
        leaseExpiresAt: { $gt: now },
      },
      {
        $set: {
          heartbeatAt: now,
          ...(providerTaskId ? { providerTaskId } : {}),
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
        },
      },
      { new: true },
    ).lean();
  }

  async function releaseImageProviderConcurrencyLease({
    leaseId,
    ownerId,
    internalTaskId,
  }: {
    leaseId: string;
    ownerId: string;
    internalTaskId: string;
  }) {
    await ensureImageProviderConcurrencyLeaseStorage();
    const result = await ImageProviderConcurrencyLease.deleteOne({
      _id: leaseId,
      ownerId,
      internalTaskId,
    });
    return result.deletedCount > 0;
  }

  async function countActiveImageProviderConcurrencyLeases({
    resourceKey,
    now = new Date(),
  }: {
    resourceKey: string;
    now?: Date;
  }) {
    await ensureImageProviderConcurrencyLeaseStorage();
    return ImageProviderConcurrencyLease.countDocuments({
      resourceKey,
      leaseExpiresAt: { $gt: now },
    });
  }

  async function listActiveImageProviderConcurrencyLeases({
    resourceKey,
    now = new Date(),
  }: {
    resourceKey: string;
    now?: Date;
  }) {
    await ensureImageProviderConcurrencyLeaseStorage();
    return ImageProviderConcurrencyLease.find({ resourceKey, leaseExpiresAt: { $gt: now } })
      .select('internalTaskId ownerId leaseExpiresAt')
      .lean();
  }

  async function pruneExpiredImageProviderConcurrencyLeases({ now = new Date() }: { now?: Date }) {
    await ensureImageProviderConcurrencyLeaseStorage();
    return ImageProviderConcurrencyLease.deleteMany({ leaseExpiresAt: { $lte: now } });
  }

  return {
    acquireImageProviderConcurrencyLease,
    countActiveImageProviderConcurrencyLeases,
    listActiveImageProviderConcurrencyLeases,
    heartbeatImageProviderConcurrencyLease,
    pruneExpiredImageProviderConcurrencyLeases,
    releaseImageProviderConcurrencyLease,
  };
}

export type ImageProviderConcurrencyLeaseMethods = ReturnType<
  typeof createImageProviderConcurrencyLeaseMethods
>;
