import { Schema } from 'mongoose';
import type { IAdminMutationLock, IEmailBlocklist, IUserDeletionJob } from '~/types/adminAccount';

const userDeletionJobStepResultSchema = new Schema(
  {
    step: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['pending', 'succeeded', 'failed', 'skipped'],
      required: true,
      default: 'pending',
    },
    count: { type: Number, min: 0 },
    message: { type: String, maxlength: 2000 },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

export const userDeletionJobSchema = new Schema<IUserDeletionJob>(
  {
    targetReportingSubjectId: { type: String, required: true, trim: true, index: true },
    targetUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true, default: null },
    targetEmailNormalized: { type: String, lowercase: true, trim: true, index: true },
    status: {
      type: String,
      enum: ['queued', 'running', 'failed', 'completed'],
      default: 'queued',
      index: true,
    },
    currentStep: { type: String, trim: true },
    stepResults: { type: [userDeletionJobStepResultSchema], default: [] },
    attemptCount: { type: Number, default: 0, min: 0 },
    lastError: { type: String, maxlength: 4000 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    completedAt: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

userDeletionJobSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { status: 'completed' } },
);
userDeletionJobSchema.index({ status: 1, updatedAt: 1 });

export const emailBlocklistSchema = new Schema<IEmailBlocklist>(
  {
    emailNormalized: { type: String, required: true, lowercase: true, trim: true, unique: true },
    emailOriginal: { type: String, trim: true },
    reportingSubjectId: { type: String, trim: true, index: true },
    reason: { type: String, trim: true, maxlength: 1000 },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    unblockedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    unblockedAt: { type: Date },
  },
  { timestamps: true },
);

emailBlocklistSchema.index({ emailNormalized: 1, active: 1 });

export const adminMutationLockSchema = new Schema<IAdminMutationLock>(
  {
    _id: { type: String, required: true, trim: true },
    ownerId: { type: String, required: true, trim: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

adminMutationLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
