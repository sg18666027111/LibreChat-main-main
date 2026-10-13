import { Schema } from 'mongoose';
import type { IImageProviderConcurrencyLease } from '~/types/imageProviderConcurrencyLease';

const imageProviderConcurrencyLeaseSchema = new Schema<IImageProviderConcurrencyLease>(
  {
    _id: { type: String, required: true, trim: true },
    resourceKey: { type: String, required: true, trim: true, index: true },
    slot: { type: Number, required: true, min: 0 },
    ownerId: { type: String, required: true, trim: true },
    internalTaskId: { type: String, required: true, trim: true, index: true },
    providerTaskId: { type: String, trim: true, index: true },
    leaseExpiresAt: { type: Date, required: true },
    heartbeatAt: { type: Date, required: true },
  },
  { timestamps: true },
);

imageProviderConcurrencyLeaseSchema.index({ resourceKey: 1, leaseExpiresAt: 1 });
imageProviderConcurrencyLeaseSchema.index({ leaseExpiresAt: 1 }, { expireAfterSeconds: 0 });

export default imageProviderConcurrencyLeaseSchema;
