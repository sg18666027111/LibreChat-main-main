export type BatchPollingRetryMode = 'resume_polling' | 'reprocess_result' | 'resubmit_provider';

export type BatchPollingItem = {
  itemId?: string;
  templateId: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  resultImages?: unknown[];
  error?: string;
  errorMessage?: string;
  errorKind?: string;
  retryMode?: BatchPollingRetryMode;
};

export type BatchPollingTask<TItem extends BatchPollingItem = BatchPollingItem> = {
  id: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  items: TItem[];
};

function getItemKey(item: BatchPollingItem) {
  return item.itemId || item.templateId;
}

export function isProviderSubmitUnknownItem(item: BatchPollingItem) {
  return item.status === 'failed' && item.errorKind === 'provider_submit_unknown';
}

function clearSuccessErrorFields<TItem extends BatchPollingItem>(item: TItem): TItem {
  return {
    ...item,
    error: undefined,
    errorMessage: undefined,
    errorKind: undefined,
    retryMode: undefined,
  };
}

export function shouldPollPackagingBatch(batch?: BatchPollingTask | null) {
  if (!batch) {
    return false;
  }
  if (batch.status === 'pending' || batch.status === 'running') {
    return true;
  }
  return false;
}

export function mergePackagingBatchState<TBatch extends BatchPollingTask>(
  previous: TBatch | null,
  next: TBatch,
): TBatch {
  if (!previous || previous.id !== next.id) {
    return {
      ...next,
      items: next.items.map((item) => (item.status === 'success' ? clearSuccessErrorFields(item) : item)),
    };
  }

  const previousItems = new Map(previous.items.map((item) => [getItemKey(item), item]));
  const mergedItems = next.items.map((item) => {
    const previousItem = previousItems.get(getItemKey(item));
    if (previousItem?.status === 'success' && item.status !== 'success') {
      return previousItem;
    }
    return item.status === 'success' ? clearSuccessErrorFields(item) : item;
  });

  if (previous.status === 'done' && next.status !== 'done') {
    return previous;
  }

  return {
    ...next,
    items: mergedItems,
  };
}
