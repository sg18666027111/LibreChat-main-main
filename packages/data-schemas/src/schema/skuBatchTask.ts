import { Schema } from 'mongoose';
import type { ISkuBatchTask } from '~/types/skuBatchTask';

const skuBatchTaskSchema = new Schema<ISkuBatchTask>(
  {
    tenantId: { type: String, index: true },
    userId: { type: String, required: true, index: true },
    batchId: { type: String, required: true, trim: true, index: true },
    itemId: { type: String, required: true, trim: true },
    itemIndex: { type: Number, required: true, min: 0 },
    sourceFileId: { type: String, required: true, trim: true },
    leftIconFileId: { type: String, trim: true },
    rightIconFileId: { type: String, trim: true },
    templateKey: { type: String, required: true, trim: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    status: {
      type: String,
      enum: ['pending', 'running', 'succeeded', 'failed', 'cancelled'],
      required: true,
      default: 'pending',
      index: true,
    },
    outputFileId: { type: String, trim: true },
    error: { type: String, trim: true, maxlength: 1000 },
    retryCount: { type: Number, default: 0, min: 0 },
    processingLeaseUntil: { type: Date, default: null, index: true },
    processingWorkerId: { type: String, default: null, trim: true },
    completedAt: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

skuBatchTaskSchema.index({ batchId: 1, itemId: 1 }, { unique: true });
skuBatchTaskSchema.index({ userId: 1, tenantId: 1, batchId: 1, itemIndex: 1, createdAt: 1 });
skuBatchTaskSchema.index({ status: 1, processingLeaseUntil: 1 });
skuBatchTaskSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default skuBatchTaskSchema;
