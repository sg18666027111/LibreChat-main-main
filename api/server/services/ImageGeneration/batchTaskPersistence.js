const {
  acquireImageBatchTaskLease,
  createImageBatchTaskItem,
  getImageBatchTaskItems,
  getImageGenerationJobByBatchItem,
  updateImageBatchTaskItem,
  updateImageBatchTaskItemWithLease,
  updateImageBatchTaskUsageDelivery,
} = require('~/models');
const { createHash } = require('crypto');
const {
  getBatchResultFilePath,
  toClientBatchResultImage,
} = require('~/server/services/ImageGeneration/batchResultStorage');

const BATCH_SUCCEEDED_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH_FAILED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_CANCELLED_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH_ITEM_LEASE_MS = 15 * 60 * 1000;
const PROVIDER_FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled']);
const RESUBMITTABLE_PROVIDER_STATUSES = new Set([...PROVIDER_FAILED_STATUSES, 'no_result']);
const PROVIDER_SUCCEEDED_STATUSES = new Set(['succeeded', 'success', 'completed', 'done']);

function getReferenceImageMetadata(referenceImage) {
  if (typeof referenceImage !== 'string' || !referenceImage) {
    return { hasReferenceImage: false };
  }
  const mimeType = /^data:([^;,]+);base64,/i.exec(referenceImage)?.[1] || undefined;
  return {
    hasReferenceImage: true,
    referenceImageMimeType: mimeType,
    referenceImageFingerprint: createHash('sha256').update(referenceImage).digest('hex'),
  };
}

function getTerminalExpiry(status, now = Date.now()) {
  let ttlMs;
  if (status === 'succeeded') {
    ttlMs = BATCH_SUCCEEDED_TTL_MS;
  } else if (status === 'failed') {
    ttlMs = BATCH_FAILED_TTL_MS;
  } else if (status === 'cancelled') {
    ttlMs = BATCH_CANCELLED_TTL_MS;
  }
  return ttlMs ? new Date(now + ttlMs) : undefined;
}

function hasActiveLease(item, now = Date.now()) {
  if (!item?.processingLeaseUntil) {
    return false;
  }
  return new Date(item.processingLeaseUntil).getTime() > now;
}

function getRecoveryMode(item, { respectActiveLease = false, now = Date.now() } = {}) {
  const status = String(item?.status || '').toLowerCase();
  if (status === 'succeeded' || status === 'cancelled') {
    return 'terminal';
  }
  if (status === 'provider_succeeded' || status === 'processing_result') {
    return 'reprocess_result';
  }
  // A failed output-processing attempt keeps its explicit, result-only retry.
  // Do not reinterpret a succeeded child as unfinished provider work.
  if (
    ['pending', 'failed'].includes(status) &&
    item?.retryMode === 'reprocess_result' &&
    (item.providerResult || item.providerTaskId)
  ) {
    return 'reprocess_result';
  }
  if (
    status === 'failed' &&
    item?.providerResult &&
    item?.providerTaskId &&
    PROVIDER_SUCCEEDED_STATUSES.has(String(item.providerStatus || '').toLowerCase())
  ) {
    return 'reprocess_result';
  }
  if (
    item?.internalTaskId &&
    !(['pending', 'failed'].includes(status) && item.retryMode === 'resubmit_provider')
  ) {
    if (
      status === 'failed' &&
      ['failed', 'status_unknown', 'cancelled', 'missing'].includes(item.internalJobStatus)
    ) {
      return 'submit_unknown';
    }
    return 'resume_polling';
  }
  if (status === 'submitting' || status === 'processing') {
    if (item?.providerTaskId) {
      return 'resume_polling';
    }
    return respectActiveLease && hasActiveLease(item, now) ? 'active_lease' : 'submit_unknown';
  }
  if (status === 'pending') {
    if (item?.retryMode === 'resume_polling' && item?.providerTaskId) {
      return 'resume_polling';
    }
    if (item?.retryMode === 'resubmit_provider' && item?.submitAttempt > 0) {
      // A new attempt is reserved only by the atomic explicit retry transition.
      if (item.internalJobItemId && !item.internalTaskId) {
        return 'resubmit_provider';
      }
      return RESUBMITTABLE_PROVIDER_STATUSES.has(String(item?.providerStatus || '').toLowerCase())
        ? 'resubmit_provider'
        : 'submit_unknown';
    }
    return 'resubmit_provider';
  }
  if (status === 'failed') {
    if (item?.retryMode === 'resume_polling' && item?.providerTaskId) {
      return 'resume_polling';
    }
    if (
      item?.providerTaskId &&
      PROVIDER_SUCCEEDED_STATUSES.has(String(item?.providerStatus || '').toLowerCase())
    ) {
      return item?.providerResult ? 'reprocess_result' : 'resume_polling';
    }
    if (
      item?.retryMode === 'resubmit_provider' &&
      RESUBMITTABLE_PROVIDER_STATUSES.has(String(item?.providerStatus || '').toLowerCase())
    ) {
      return 'resubmit_provider';
    }
    return 'submit_unknown';
  }
  return 'submit_unknown';
}

function getClientItemStatus(record, recoveryMode) {
  if (record.status === 'succeeded') {
    return 'success';
  }
  if (record.status === 'cancelled') {
    return 'cancelled';
  }
  if (record.internalTaskId && recoveryMode === 'resume_polling') {
    return 'pending';
  }
  if (record.status === 'failed' || recoveryMode === 'submit_unknown') {
    return 'failed';
  }
  return 'pending';
}

function getClientRetryMode(recoveryMode) {
  return recoveryMode === 'resume_polling' ||
    recoveryMode === 'reprocess_result' ||
    recoveryMode === 'resubmit_provider'
    ? recoveryMode
    : undefined;
}

function recomputeLoadedTaskStatus(items) {
  if (items.some((item) => item.status === 'pending' || item.status === 'running')) {
    return 'pending';
  }
  if (items.every((item) => item.status === 'cancelled')) {
    return 'cancelled';
  }
  if (items.some((item) => item.status === 'success')) {
    return 'done';
  }
  return 'failed';
}

function buildPersistentItem(task, item) {
  return {
    userId: task.userId,
    tenantId: task.tenantId,
    batchId: task.id,
    itemId: item.itemId,
    templateId: item.templateId,
    templateName: item.templateName,
    title: task.title,
    provider: task.provider,
    model: task.model,
    modelKey: task.modelKey || undefined,
    generationMode: task.mode,
    prompt: item.prompt,
    ...getReferenceImageMetadata(task.referenceImage),
    status: item.persistenceStatus || 'pending',
    usageContext: item.usageContext,
    usageDelivery: item.usageDelivery,
    usageRecorded: item.usageRecorded,
    internalJobItemId: item.internalJobItemId,
    internalTaskId: item.internalTaskId,
    internalJobStatus: item.internalJobStatus,
    providerTaskId: item.providerTaskId,
    providerStatus: item.providerStatus,
    providerResult: item.providerResult,
    resultImage: item.resultImage,
    retryMode: item.retryMode,
    errorKind: item.errorKind,
    error: item.error,
    retryCount: item.retryCount || 0,
    submitAttempt: item.submitAttempt || 0,
    outputWidth: task.outputWidth || 800,
    outputHeight: task.outputHeight || 800,
  };
}

async function createPersistentBatchTask(task) {
  for (const item of task.items) {
    await createImageBatchTaskItem(buildPersistentItem(task, item));
  }
}

function hydrateTask(records) {
  if (!records.length) {
    return null;
  }
  const first = records[0];
  const items = records.map((record) => {
    const recoveryMode = getRecoveryMode(record, { respectActiveLease: true });
    return {
      itemId: record.itemId,
      templateId: record.templateId,
      templateName: record.templateName,
      prompt: record.prompt,
      status: getClientItemStatus(record, recoveryMode),
      persistenceStatus: record.status,
      usageContext: record.usageContext,
      usageDelivery: record.usageDelivery,
      usageRecorded: record.usageRecorded,
      internalJobItemId: record.internalJobItemId,
      internalTaskId: record.internalTaskId,
      internalJobStatus: record.internalJobStatus,
      providerTaskId: record.providerTaskId,
      providerStatus: record.providerStatus,
      providerResult: record.providerResult,
      resultImage: record.resultImage
        ? toClientBatchResultImage({
            batchId: record.batchId,
            itemId: record.itemId,
            resultImage: record.resultImage,
          })
        : undefined,
      resultImageUrl: record.resultImage?.fileId
        ? getBatchResultFilePath(record.batchId, record.itemId)
        : undefined,
      retryMode: getClientRetryMode(recoveryMode),
      /**
       * Mongo 中原始的 retryMode。terminal（succeeded/cancelled）记录的运行时 retryMode
       * 会被上面归一化为 undefined，但坏成功态恢复（recover-result）必须能看到持久化
       * 原值才能判断 reprocess_result 是否安全，否则会被误判为不满足恢复条件。
       * 仅供服务内部使用，serializeBatchTask 不会输出该字段。
       */
      persistedRetryMode: record.retryMode,
      errorKind: record.errorKind,
      error:
        recoveryMode === 'submit_unknown'
          ? '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。'
          : record.error,
      retryCount: record.retryCount || 0,
      submitAttempt: record.submitAttempt || 0,
    };
  });
  return {
    id: first.batchId,
    userId: first.userId,
    tenantId: first.tenantId,
    title: first.title,
    mode: first.generationMode,
    modelKey: first.modelKey || null,
    model: first.model,
    provider: first.provider,
    outputSize: `${first.outputWidth || 800}x${first.outputHeight || 800}`,
    outputWidth: first.outputWidth || 800,
    outputHeight: first.outputHeight || 800,
    hasReferenceImage: Boolean(first.hasReferenceImage),
    referenceImageMimeType: first.referenceImageMimeType,
    referenceImageFingerprint: first.referenceImageFingerprint,
    status: recomputeLoadedTaskStatus(items),
    cancelRequested: items.every((item) => item.status === 'cancelled'),
    createdAt: new Date(first.createdAt).getTime(),
    updatedAt: Math.max(...records.map((record) => new Date(record.updatedAt).getTime())),
    runnerActive: false,
    items,
  };
}

async function loadPersistentBatchTask(batchId, userId) {
  const records = await getImageBatchTaskItems({
    batchId,
    ...(userId ? { userId } : {}),
    includeSensitive: true,
  });
  // Recover the enqueue -> batch-link crash window through the existing v2
  // batch identity. This is a read, never a find-or-create or provider submit.
  const recoveredRecords = await Promise.all(
    records.map(async (record) => {
      if (
        record.internalTaskId ||
        record.provider !== 'apimart' ||
        !['submitting', 'processing', 'failed'].includes(record.status) ||
        (record.status === 'failed' &&
          ['resubmit_provider', 'reprocess_result'].includes(record.retryMode))
      ) {
        return record;
      }
      const job = await getImageGenerationJobByBatchItem({
        userId: record.userId,
        tenantId: record.tenantId,
        batchTaskId: record.batchId,
        itemId: record.internalJobItemId || record.itemId,
        model: record.model,
      });
      return job
        ? { ...record, internalTaskId: job.internalTaskId, internalJobStatus: job.status }
        : record;
    }),
  );
  return hydrateTask(recoveredRecords);
}

async function acquirePersistentItemLease({ batchId, itemId, workerId, statuses }) {
  return acquireImageBatchTaskLease({
    batchId,
    itemId,
    workerId,
    leaseMs: BATCH_ITEM_LEASE_MS,
    statuses,
  });
}

async function updatePersistentItemWithLease(args) {
  return updateImageBatchTaskItemWithLease(args);
}

async function updatePersistentItem(args) {
  return updateImageBatchTaskItem(args);
}

module.exports = {
  BATCH_ITEM_LEASE_MS,
  BATCH_CANCELLED_TTL_MS,
  BATCH_FAILED_TTL_MS,
  BATCH_SUCCEEDED_TTL_MS,
  acquirePersistentItemLease,
  buildPersistentItem,
  createPersistentBatchTask,
  getReferenceImageMetadata,
  getRecoveryMode,
  hasActiveLease,
  getTerminalExpiry,
  hydrateTask,
  loadPersistentBatchTask,
  updatePersistentItem,
  updatePersistentItemWithLease,
  updatePersistentUsageDelivery: (args) => updateImageBatchTaskUsageDelivery(args),
};
