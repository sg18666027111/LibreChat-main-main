import type { HydratedDocument } from 'mongoose';
import type { UsageCaptureContext, UsageDeliverySourceState } from './aiUsage';

export type ImageGenerationJobStatus =
  | 'waiting'
  | 'submitting'
  | 'submitted'
  | 'polling'
  | 'succeeded'
  | 'failed'
  | 'status_unknown'
  | 'cancelled';

export type ImageEgressOperation =
  | 'input_read'
  | 'status_read'
  | 'result_read'
  | 'output_download'
  | 'output_storage';

export interface IImageGenerationJob {
  tenantId?: string;
  userId: string;
  internalTaskId: string;
  frontendTaskId?: string;
  requestId: string;
  batchTaskId?: string;
  itemId?: string;
  businessType: string;
  taskType: string;
  provider: string;
  model: string;
  modelKey?: string;
  apiKeyFingerprint?: string;
  resourceKey?: string;
  asyncVersion?: number;
  workerFamily?: 'image-egress-v1';
  rolloutMode?: 'canary' | 'all';
  workerEligible?: boolean;
  payload?: unknown;
  result?: unknown;
  providerMetadata?: Record<string, unknown>;
  status: ImageGenerationJobStatus;
  submittedToProvider: boolean;
  usageRecorded: boolean;
  usageContext?: UsageCaptureContext;
  usageDelivery?: UsageDeliverySourceState;
  providerTaskId?: string;
  providerStatus?: string;
  providerErrorCode?: string;
  providerErrorCategory?: string;
  pollCount?: number;
  lastPolledAt?: Date;
  nextPollAt?: Date;
  currentOperation?: ImageEgressOperation;
  operationAttemptCount?: number;
  operationTransientFailureCount?: number;
  failedTurnCount?: number;
  lastOperationErrorCode?: string;
  lastOperationAt?: Date;
  nextAttemptAt?: Date;
  deadlineAt?: Date;
  jobDeadlineAt?: Date;
  errorCode?: string;
  error?: string;
  queueEnteredAt: Date;
  providerStartedAt?: Date;
  providerAcceptedAt?: Date;
  providerFinishedAt?: Date;
  statusUnknownAt?: Date;
  providerOutcomeUnknown?: boolean;
  manualReviewRequired?: boolean;
  neverResubmit?: boolean;
  localCapacityReleasedAt?: Date;
  localCapacityReleaseReason?: string;
  completedAt?: Date;
  workerOwner?: string | null;
  workerLeaseUntil?: Date | null;
  runVersion: number;
  expiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type IImageGenerationJobDocument = HydratedDocument<IImageGenerationJob>;

export type CreateImageGenerationJobInput = Omit<
  IImageGenerationJob,
  | 'status'
  | 'submittedToProvider'
  | 'usageRecorded'
  | 'queueEnteredAt'
  | 'workerOwner'
  | 'workerLeaseUntil'
  | 'runVersion'
> &
  Partial<
    Pick<
      IImageGenerationJob,
      'status' | 'submittedToProvider' | 'usageRecorded' | 'queueEnteredAt' | 'runVersion'
    >
  >;

export type UpdateImageGenerationJobInput = Partial<
  Omit<IImageGenerationJob, 'internalTaskId' | 'createdAt' | 'updatedAt'>
>;
