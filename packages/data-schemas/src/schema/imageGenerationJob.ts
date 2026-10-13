import { Schema } from 'mongoose';
import type { IImageGenerationJob } from '~/types/imageGenerationJob';

export const imageGenerationJobStatuses = [
  'waiting',
  'submitting',
  'submitted',
  'polling',
  'succeeded',
  'failed',
  'status_unknown',
  'cancelled',
] as const;

const imageGenerationJobSchema = new Schema<IImageGenerationJob>(
  {
    tenantId: { type: String, index: true },
    userId: { type: String, required: true, index: true },
    internalTaskId: { type: String, required: true, trim: true },
    frontendTaskId: { type: String, trim: true },
    requestId: { type: String, required: true, trim: true, index: true },
    batchTaskId: { type: String, trim: true, index: true },
    itemId: { type: String, trim: true, index: true },
    businessType: { type: String, required: true, trim: true, index: true },
    taskType: { type: String, required: true, trim: true, index: true },
    provider: { type: String, required: true, trim: true, index: true },
    model: { type: String, required: true, trim: true, index: true },
    modelKey: { type: String, trim: true },
    apiKeyFingerprint: { type: String, trim: true },
    resourceKey: { type: String, trim: true, index: true },
    asyncVersion: { type: Number, index: true },
    workerFamily: { type: String, enum: ['image-egress-v1'], trim: true, index: true },
    rolloutMode: { type: String, enum: ['canary', 'all'], trim: true, index: true },
    workerEligible: { type: Boolean, default: false, index: true },
    payload: { type: Schema.Types.Mixed, select: false },
    result: { type: Schema.Types.Mixed, select: false },
    providerMetadata: { type: Schema.Types.Mixed, select: false },
    status: {
      type: String,
      enum: imageGenerationJobStatuses,
      required: true,
      default: 'waiting',
      index: true,
    },
    submittedToProvider: { type: Boolean, default: false, index: true },
    usageRecorded: { type: Boolean, default: false },
    usageContext: { type: Schema.Types.Mixed, select: false },
    usageDelivery: { type: Schema.Types.Mixed, select: false },
    providerTaskId: { type: String, trim: true, index: true },
    providerStatus: { type: String, trim: true },
    providerErrorCode: { type: String, trim: true },
    providerErrorCategory: { type: String, trim: true },
    pollCount: { type: Number, default: 0, min: 0 },
    lastPolledAt: { type: Date },
    nextPollAt: { type: Date, index: true },
    currentOperation: {
      type: String,
      enum: ['input_read', 'status_read', 'result_read', 'output_download', 'output_storage'],
      index: true,
    },
    operationAttemptCount: { type: Number, default: 0, min: 0 },
    operationTransientFailureCount: { type: Number, default: 0, min: 0 },
    failedTurnCount: { type: Number, default: 0, min: 0 },
    lastOperationErrorCode: { type: String, trim: true },
    lastOperationAt: { type: Date },
    nextAttemptAt: { type: Date, index: true },
    deadlineAt: { type: Date },
    jobDeadlineAt: { type: Date },
    errorCode: { type: String, trim: true },
    error: { type: String, trim: true, maxlength: 1000 },
    queueEnteredAt: { type: Date, default: Date.now, index: true },
    providerStartedAt: { type: Date },
    providerAcceptedAt: { type: Date },
    providerFinishedAt: { type: Date },
    statusUnknownAt: { type: Date },
    // APIMart V2: local release does not establish the upstream execution outcome.
    providerOutcomeUnknown: { type: Boolean },
    manualReviewRequired: { type: Boolean },
    neverResubmit: { type: Boolean },
    localCapacityReleasedAt: { type: Date },
    localCapacityReleaseReason: { type: String, trim: true },
    completedAt: { type: Date },
    workerOwner: { type: String, default: null, trim: true },
    workerLeaseUntil: { type: Date, default: null, index: true },
    runVersion: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

imageGenerationJobSchema.index({ internalTaskId: 1 }, { unique: true });
imageGenerationJobSchema.index({ status: 1, workerLeaseUntil: 1, queueEnteredAt: 1 });
imageGenerationJobSchema.index({
  resourceKey: 1,
  submittedToProvider: 1,
  status: 1,
  providerTaskId: 1,
});
imageGenerationJobSchema.index({ userId: 1, createdAt: -1 });
imageGenerationJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
imageGenerationJobSchema.index(
  { userId: 1, frontendTaskId: 1, businessType: 1 },
  {
    unique: true,
    partialFilterExpression: {
      asyncVersion: 2,
      frontendTaskId: { $exists: true, $type: 'string' },
    },
  },
);
imageGenerationJobSchema.index(
  { userId: 1, frontendTaskId: 1, businessType: 1, asyncVersion: 1 },
  {
    name: 'uniq_image_egress_v3_frontend_identity',
    unique: true,
    partialFilterExpression: {
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
      frontendTaskId: { $exists: true, $type: 'string' },
    },
  },
);
imageGenerationJobSchema.index(
  { userId: 1, batchTaskId: 1, itemId: 1, asyncVersion: 1 },
  {
    name: 'uniq_image_egress_v3_batch_identity',
    unique: true,
    partialFilterExpression: {
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
      batchTaskId: { $exists: true, $type: 'string' },
      itemId: { $exists: true, $type: 'string' },
    },
  },
);
imageGenerationJobSchema.index(
  { userId: 1, batchTaskId: 1, itemId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      asyncVersion: 2,
      batchTaskId: { $exists: true, $type: 'string' },
      itemId: { $exists: true, $type: 'string' },
    },
  },
);

imageGenerationJobSchema.index({ 'usageContext.reservationId': 1 }, { sparse: true });
imageGenerationJobSchema.index({ 'usageDelivery.state': 1, updatedAt: 1, _id: 1 });

export default imageGenerationJobSchema;
