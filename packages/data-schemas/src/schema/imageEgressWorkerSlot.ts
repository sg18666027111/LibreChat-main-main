import { Schema } from 'mongoose';
import type { IImageEgressWorkerSlot } from '~/types/imageEgressWorkerSlot';

const imageEgressWorkerSlotSchema = new Schema<IImageEgressWorkerSlot>(
  {
    _id: { type: String, required: true, trim: true },
    workerFamily: { type: String, enum: ['image-egress-v1'], required: true, trim: true },
    slotNumber: { type: Number, required: true, min: 0 },
    ownerId: { type: String, default: null, trim: true },
    leaseId: { type: String, default: null, trim: true },
    leaseUntil: { type: Date, default: null, index: true },
    heartbeatAt: { type: Date, default: null },
  },
  { timestamps: true },
);

imageEgressWorkerSlotSchema.index(
  { workerFamily: 1, slotNumber: 1 },
  { unique: true, name: 'uniq_image_egress_worker_slot' },
);

export default imageEgressWorkerSlotSchema;
