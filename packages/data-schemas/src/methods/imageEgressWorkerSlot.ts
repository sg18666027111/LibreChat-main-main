import { randomUUID } from 'crypto';
import type { Model } from 'mongoose';
import type { IImageEgressWorkerSlot } from '~/types/imageEgressWorkerSlot';
import { createIndexesWithRetry } from '~/utils/retry';

function getModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.ImageEgressWorkerSlot as Model<IImageEgressWorkerSlot>;
}

function isDuplicateKeyError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: number }).code === 11000 ||
      (error as { codeName?: string }).codeName === 'DuplicateKey')
  );
}

export function createImageEgressWorkerSlotMethods(mongoose: typeof import('mongoose')) {
  const ImageEgressWorkerSlot = getModel(mongoose);
  let storageInitialization: Promise<void> | undefined;

  function ensureImageEgressWorkerSlotStorage() {
    if (!storageInitialization) {
      storageInitialization = (async () => {
        try {
          await ImageEgressWorkerSlot.createCollection();
        } catch (error) {
          const mongoError = error as { code?: number; codeName?: string };
          if (mongoError.code !== 48 && mongoError.codeName !== 'NamespaceExists') {
            throw error;
          }
        }
        await createIndexesWithRetry(ImageEgressWorkerSlot);
      })().catch((error) => {
        storageInitialization = undefined;
        throw error;
      });
    }
    return storageInitialization;
  }

  async function acquireImageEgressWorkerSlot({
    workerFamily,
    ownerId,
    maxConcurrency,
    leaseMs,
    now = new Date(),
  }: {
    workerFamily: 'image-egress-v1';
    ownerId: string;
    maxConcurrency: number;
    leaseMs: number;
    now?: Date;
  }) {
    await ensureImageEgressWorkerSlotStorage();
    const slotCount = Math.max(1, Math.floor(maxConcurrency || 1));
    const leaseUntil = new Date(now.getTime() + leaseMs);

    for (let slotNumber = 0; slotNumber < slotCount; slotNumber += 1) {
      const leaseId = randomUUID();
      try {
        const slot = await ImageEgressWorkerSlot.findOneAndUpdate(
          {
            _id: `${workerFamily}:slot:${slotNumber}`,
            $or: [
              { ownerId: null },
              { ownerId: { $exists: false } },
              { leaseUntil: null },
              { leaseUntil: { $exists: false } },
              { leaseUntil: { $lte: now } },
            ],
          },
          {
            $set: {
              workerFamily,
              slotNumber,
              ownerId,
              leaseId,
              leaseUntil,
              heartbeatAt: now,
            },
          },
          { new: true, upsert: true },
        ).lean();
        if (slot) {
          return slot;
        }
      } catch (error) {
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
      }
    }
    return null;
  }

  async function heartbeatImageEgressWorkerSlot({
    leaseId,
    ownerId,
    leaseMs,
    now = new Date(),
  }: {
    leaseId: string;
    ownerId: string;
    leaseMs: number;
    now?: Date;
  }) {
    await ensureImageEgressWorkerSlotStorage();
    return ImageEgressWorkerSlot.findOneAndUpdate(
      { leaseId, ownerId, leaseUntil: { $gt: now } },
      { $set: { heartbeatAt: now, leaseUntil: new Date(now.getTime() + leaseMs) } },
      { new: true },
    ).lean();
  }

  async function releaseImageEgressWorkerSlot({
    leaseId,
    ownerId,
    now = new Date(),
  }: {
    leaseId: string;
    ownerId: string;
    now?: Date;
  }) {
    await ensureImageEgressWorkerSlotStorage();
    const slot = await ImageEgressWorkerSlot.findOneAndUpdate(
      { leaseId, ownerId },
      { $set: { ownerId: null, leaseId: null, leaseUntil: null, heartbeatAt: now } },
      { new: true },
    ).lean();
    return Boolean(slot);
  }

  return {
    acquireImageEgressWorkerSlot,
    heartbeatImageEgressWorkerSlot,
    ensureImageEgressWorkerSlotStorage,
    releaseImageEgressWorkerSlot,
  };
}

export type ImageEgressWorkerSlotMethods = ReturnType<typeof createImageEgressWorkerSlotMethods>;
