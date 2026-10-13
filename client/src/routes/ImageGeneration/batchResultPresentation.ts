export type BatchRetryMode = 'resume_polling' | 'reprocess_result' | 'resubmit_provider';

export const BATCH_PROVIDER_STILL_PROCESSING_MESSAGE =
  '供应商仍在处理本次任务，系统将继续检查原任务。请勿重复提交，以免产生重复费用。';

export type BatchResultPresentationItem = {
  status: string;
  retryMode?: BatchRetryMode;
  providerStatus?: string | null;
};

export function getBatchResultFileUrl(batchId: string, itemId: string) {
  return `/api/batch/image-generation/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/file`;
}

export function isBatchResultFileUrl(url?: string | null) {
  if (!url) {
    return false;
  }

  return /^\/api\/batch\/image-generation\/[^/]+\/items\/[^/]+\/file(?:\?.*)?$/.test(url);
}

export function getBatchResultRecoveryUrl(batchId: string, itemId: string) {
  return `/api/batch/image-generation/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/recover-result`;
}

export function createBatchResultImage(batchId: string, itemId: string) {
  const url = getBatchResultFileUrl(batchId, itemId);
  return {
    url,
    proxiedUrl: url,
    downloadUrl: `${url}?download=1`,
  };
}

export function isProviderStillProcessingItem(item: BatchResultPresentationItem) {
  return (
    item.status === 'failed' &&
    item.retryMode === 'resume_polling' &&
    String(item.providerStatus || '').toUpperCase() === 'IN_PROGRESS'
  );
}

export function getBatchStatusPresentation(item: BatchResultPresentationItem) {
  if (isProviderStillProcessingItem(item)) {
    return {
      label: '生成时间较长',
      message: BATCH_PROVIDER_STILL_PROCESSING_MESSAGE,
    };
  }

  return null;
}

export function getBatchTaskStatusPresentation(items: BatchResultPresentationItem[]) {
  return items.some((item) => isProviderStillProcessingItem(item))
    ? {
        label: '生成时间较长',
        message: BATCH_PROVIDER_STILL_PROCESSING_MESSAGE,
      }
    : null;
}

export function getBatchRetryAction(
  status: string,
  retryMode?: BatchRetryMode,
  item?: Partial<BatchResultPresentationItem>,
) {
  if (status !== 'failed') {
    return null;
  }
  if (
    retryMode === 'resume_polling' &&
    String(item?.providerStatus || '').toUpperCase() === 'IN_PROGRESS'
  ) {
    return { label: '继续检查', mode: 'continue_check' as const };
  }
  if (retryMode === 'reprocess_result' || retryMode === 'resume_polling') {
    return { label: '重新加载', mode: 'reload' as const };
  }
  if (retryMode === 'resubmit_provider') {
    return { label: '重新生成', mode: 'regenerate' as const };
  }
  return null;
}
