import { Schema } from 'mongoose';
import type { IImageBatchTask } from '~/types/imageBatchTask';

const imageBatchTaskSchema = new Schema<IImageBatchTask>(
  {
    tenantId: { type: String, index: true },
    userId: { type: String, required: true, index: true },
    batchId: { type: String, required: true, trim: true, index: true },
    itemId: { type: String, required: true, trim: true },
    templateId: { type: String, required: true, trim: true },
    templateName: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    provider: { type: String, required: true, trim: true, index: true },
    model: { type: String, required: true, trim: true },
    modelKey: { type: String, trim: true },
    generationMode: { type: String, enum: ['t2i', 'i2i'], required: true },
    prompt: { type: String, required: true },
    hasReferenceImage: { type: Boolean, default: false },
    referenceImageMimeType: { type: String, trim: true },
    referenceImageFingerprint: { type: String, trim: true, maxlength: 64 },
    status: {
      type: String,
      enum: [
        'pending',
        'submitting',
        'processing',
        'provider_succeeded',
        'processing_result',
        'succeeded',
        'failed',
        'cancelled',
      ],
      required: true,
      default: 'pending',
      index: true,
    },
    usageContext: { type: Schema.Types.Mixed, select: false },
    usageDelivery: { type: Schema.Types.Mixed, select: false },
    usageRecorded: { type: Boolean, default: false },
    internalJobItemId: { type: String, trim: true },
    internalTaskId: { type: String, trim: true },
    internalJobStatus: { type: String, trim: true },
    providerTaskId: { type: String, trim: true, index: true },
    providerStatus: { type: String, trim: true },
    providerResult: { type: Schema.Types.Mixed, select: false },
    resultProcessingPhase: {
      type: String,
      enum: [
        'download_started',
        'download_completed',
        'normalization_started',
        'normalization_completed',
      ],
    },
    resultProcessingUpdatedAt: { type: Date },
    resultImage: { type: Schema.Types.Mixed },
    retryMode: {
      type: String,
      enum: ['resume_polling', 'reprocess_result', 'resubmit_provider'],
    },
    errorKind: { type: String, trim: true },
    error: { type: String, trim: true, maxlength: 1000 },
    retryCount: { type: Number, default: 0, min: 0 },
    submitAttempt: { type: Number, default: 0, min: 0 },
    outputWidth: { type: Number, default: 800, min: 1 },
    outputHeight: { type: Number, default: 800, min: 1 },
    processingLeaseUntil: { type: Date, default: null, index: true },
    processingWorkerId: { type: String, default: null, trim: true },
    completedAt: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

imageBatchTaskSchema.index({ batchId: 1, itemId: 1 }, { unique: true });
imageBatchTaskSchema.index({ userId: 1, batchId: 1, createdAt: 1 });
imageBatchTaskSchema.index({ status: 1, processingLeaseUntil: 1 });
imageBatchTaskSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

imageBatchTaskSchema.index({ 'usageContext.reservationId': 1 }, { sparse: true });
imageBatchTaskSchema.index({ 'usageDelivery.state': 1, updatedAt: 1, _id: 1 });

export default imageBatchTaskSchema;
