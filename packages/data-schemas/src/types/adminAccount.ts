import type { Document, Types } from 'mongoose';

export type UserDeletionJobStatus = 'queued' | 'running' | 'failed' | 'completed';

export type UserDeletionJobStepStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';

export interface UserDeletionJobStepResult {
  step: string;
  status: UserDeletionJobStepStatus;
  count?: number;
  message?: string;
  updatedAt?: Date;
}

export interface IUserDeletionJob extends Document {
  _id: Types.ObjectId;
  targetReportingSubjectId: string;
  targetUserId?: Types.ObjectId | null;
  targetEmailNormalized?: string;
  status: UserDeletionJobStatus;
  currentStep?: string;
  stepResults: UserDeletionJobStepResult[];
  attemptCount: number;
  lastError?: string;
  createdBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
  completedAt?: Date;
  expiresAt?: Date;
}

export interface IEmailBlocklist extends Document {
  _id: Types.ObjectId;
  emailNormalized: string;
  emailOriginal?: string;
  reportingSubjectId?: string;
  reason?: string;
  active: boolean;
  createdBy?: Types.ObjectId;
  unblockedBy?: Types.ObjectId;
  unblockedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAdminMutationLock {
  _id: string;
  ownerId: string;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateUserDeletionJobInput {
  targetReportingSubjectId: string;
  targetUserId?: Types.ObjectId | string | null;
  targetEmailNormalized?: string;
  createdBy?: Types.ObjectId | string;
}

export interface SetUserDeletionStepInput {
  jobId: Types.ObjectId | string;
  step: string;
  status: UserDeletionJobStepStatus;
  count?: number;
  message?: string;
}

export interface UpsertEmailBlockInput {
  email: string;
  reportingSubjectId?: string;
  reason?: string;
  createdBy?: Types.ObjectId | string;
}

export interface AcquireAdminMutationLockInput {
  key: string;
  ownerId: string;
  leaseMs?: number;
  now?: Date;
}
