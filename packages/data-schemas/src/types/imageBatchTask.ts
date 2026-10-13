import type { UsageCaptureContext, UsageDeliverySourceState } from './aiUsage';
import type { HydratedDocument, Types } from 'mongoose';

export type ImageBatchGenerationMode = 't2i' | 'i2i';
export type ImageBatchTaskStatus =
  | 'pending'
  | 'submitting'
  | 'processing'
  | 'provider_succeeded'
  | 'processing_result'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type ImageBatchRetryMode = 'resume_polling' | 'reprocess_result' | 'resubmit_provider';
export type ImageBatchResultProcessingPhase =
  | 'download_started'
  | 'download_completed'
  | 'normalization_started'
  | 'normalization_completed';

export interface IImageBatchTask {
  _id: Types.ObjectId;
  tenantId?: string;
  userId: string;
  batchId: string;
  itemId: string;
  templateId: string;
  templateName: string;
  title: string;
  provider: string;
  model: string;
  modelKey?: string;
  generationMode: ImageBatchGenerationMode;
  prompt: string;
  hasReferenceImage: boolean;
  referenceImageMimeType?: string;
  referenceImageFingerprint?: string;
  status: ImageBatchTaskStatus;
  usageContext?: UsageCaptureContext;
  usageDelivery?: UsageDeliverySourceState;
  usageRecorded?: boolean;
  internalJobItemId?: string;
  internalTaskId?: string;
  internalJobStatus?: string;
  providerTaskId?: string;
  providerStatus?: string;
  providerResult?: Record<string, unknown>;
  resultProcessingPhase?: ImageBatchResultProcessingPhase;
  resultProcessingUpdatedAt?: Date;
  resultImage?: Record<string, unknown>;
  retryMode?: ImageBatchRetryMode;
  errorKind?: string;
  error?: string;
  retryCount: number;
  submitAttempt: number;
  outputWidth: number;
  outputHeight: number;
  processingLeaseUntil?: Date | null;
  processingWorkerId?: string | null;
  completedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type IImageBatchTaskDocument = HydratedDocument<IImageBatchTask>;

export type CreateImageBatchTaskInput = Omit<
  IImageBatchTask,
  | '_id'
  | 'createdAt'
  | 'updatedAt'
  | 'retryCount'
  | 'submitAttempt'
  | 'outputWidth'
  | 'outputHeight'
> & {
  retryCount?: number;
  submitAttempt?: number;
  outputWidth?: number;
  outputHeight?: number;
};

export type UpdateImageBatchTaskInput = Partial<
  Pick<
    IImageBatchTask,
    | 'usageContext'
    | 'usageDelivery'
    | 'usageRecorded'
    | 'status'
    | 'internalJobItemId'
    | 'internalTaskId'
    | 'internalJobStatus'
    | 'providerTaskId'
    | 'providerStatus'
    | 'providerResult'
    | 'resultProcessingPhase'
    | 'resultProcessingUpdatedAt'
    | 'resultImage'
    | 'retryMode'
    | 'errorKind'
    | 'error'
    | 'retryCount'
    | 'submitAttempt'
    | 'processingLeaseUntil'
    | 'processingWorkerId'
    | 'completedAt'
    | 'expiresAt'
  >
>;
