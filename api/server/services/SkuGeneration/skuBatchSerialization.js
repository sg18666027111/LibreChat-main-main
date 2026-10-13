function getBatchStatus(items) {
  if (!items.length) {
    return 'failed';
  }
  const statuses = items.map((item) => item.status);
  if (statuses.every((status) => status === 'cancelled')) {
    return 'cancelled';
  }
  if (statuses.some((status) => status === 'running')) {
    return 'running';
  }
  if (statuses.some((status) => status === 'pending')) {
    return 'pending';
  }
  const succeededCount = statuses.filter((status) => status === 'succeeded').length;
  const failedCount = statuses.filter((status) => status === 'failed').length;
  if (failedCount && succeededCount) {
    return 'partial_failed';
  }
  if (failedCount) {
    return 'failed';
  }
  if (succeededCount === statuses.length) {
    return 'completed';
  }
  return 'partial_failed';
}

function toClientItem(item) {
  const result = {
    itemId: item.itemId,
    itemIndex: item.itemIndex,
    text: item.text,
    status: item.status,
    outputFileId: item.outputFileId || undefined,
    error: item.error || undefined,
  };
  if (item.status === 'succeeded' && item.outputFileId) {
    const path = `/api/sku-generation/files/${encodeURIComponent(item.outputFileId)}`;
    result.previewUrl = path;
    result.downloadUrl = `${path}?download=1`;
  }
  return result;
}

function serializeSkuBatch({ batchId, items = [] }) {
  const sortedItems = [...items].sort(
    (left, right) => (left.itemIndex ?? 0) - (right.itemIndex ?? 0),
  );
  const completedCount = sortedItems.filter((item) => item.status === 'succeeded').length;
  const failedCount = sortedItems.filter((item) => item.status === 'failed').length;
  const first = sortedItems[0];
  return {
    batchId: batchId || first?.batchId,
    sourceFileId: first?.sourceFileId,
    leftIconFileId: first?.leftIconFileId,
    rightIconFileId: first?.rightIconFileId,
    templateKey: first?.templateKey,
    status: getBatchStatus(sortedItems),
    outputCount: sortedItems.length,
    completedCount,
    failedCount,
    items: sortedItems.map(toClientItem),
  };
}

module.exports = {
  getBatchStatus,
  serializeSkuBatch,
  toClientItem,
};
