import type { HydratedDocument } from 'mongoose';

export interface IImageEgressWorkerSlot {
  _id: string;
  workerFamily: 'image-egress-v1';
  slotNumber: number;
  ownerId?: string | null;
  leaseId?: string | null;
  leaseUntil?: Date | null;
  heartbeatAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type IImageEgressWorkerSlotDocument = HydratedDocument<IImageEgressWorkerSlot>;
