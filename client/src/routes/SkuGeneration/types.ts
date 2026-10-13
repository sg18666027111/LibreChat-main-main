export type SkuFileKind = 'source' | 'icon';
export type SkuTemplateAssetSlot = 'leftIcon' | 'rightIcon';

export type SkuFile = {
  fileId: string;
  filename?: string;
  contentType?: string;
  bytes?: number;
  width?: number;
  height?: number;
  previewUrl?: string;
};

export type SkuBatchItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type SkuBatchStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'partial_failed'
  | 'failed'
  | 'cancelled';

export type SkuBatchItem = {
  itemId: string;
  itemIndex: number;
  text: string;
  status: SkuBatchItemStatus;
  outputFileId?: string;
  previewUrl?: string;
  downloadUrl?: string;
  error?: string;
};

export type SkuBatchSummary = {
  batchId: string;
  sourceFileId?: string;
  leftIconFileId?: string;
  rightIconFileId?: string;
  templateKey?: string;
  status: SkuBatchStatus;
  outputCount: number;
  completedCount: number;
  failedCount: number;
  items: SkuBatchItem[];
};
