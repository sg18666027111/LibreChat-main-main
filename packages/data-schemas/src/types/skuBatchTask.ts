import type { HydratedDocument, Types } from 'mongoose';

export type SkuBatchTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ISkuBatchTask {
  _id: Types.ObjectId;
  tenantId?: string;
  userId: string;
  batchId: string;
  itemId: string;
  itemIndex: number;
  sourceFileId: string;
  leftIconFileId?: string;
  rightIconFileId?: string;
  templateKey: string;
  text: string;
  status: SkuBatchTaskStatus;
  outputFileId?: string;
  error?: string;
  retryCount: number;
  processingLeaseUntil?: Date | null;
  processingWorkerId?: string | null;
  completedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ISkuBatchTaskDocument = HydratedDocument<ISkuBatchTask>;

export type CreateSkuBatchTaskInput = Omit<
  ISkuBatchTask,
  '_id' | 'createdAt' | 'updatedAt' | 'retryCount' | 'status'
> & {
  status?: SkuBatchTaskStatus;
  retryCount?: number;
};

export type UpdateSkuBatchTaskInput = Partial<
  Pick<
    ISkuBatchTask,
    | 'status'
    | 'outputFileId'
    | 'error'
    | 'retryCount'
    | 'processingLeaseUntil'
    | 'processingWorkerId'
    | 'completedAt'
    | 'expiresAt'
  >
>;
