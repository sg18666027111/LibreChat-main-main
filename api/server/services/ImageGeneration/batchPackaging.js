const { createHash, randomUUID } = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { getImageProviderBillingMetadata } = require('./providerBilling');
const { NEGATIVE_PROMPT, getImageSize } = require('~/server/services/ImageGeneration/prompt');
const {
  TEXT_TO_IMAGE_MODEL,
  generateTextToImage,
} = require('~/server/services/ImageGeneration/siliconflow');
const { generateAPIMartImage } = require('~/server/services/ImageGeneration/adapters/apimart');
const {
  isAPIMartImg2ResolvedModel,
  runAPIMartImg2JobAndWait,
  waitForAPIMartImg2Job,
  shouldUseAPIMartImg2AsyncForUser,
} = require('~/server/services/ImageGeneration/apimartImg2Async');
const { generateFalImage } = require('~/server/services/ImageGeneration/adapters/fal');
const { isFlareModel } = require('./adapters/fal/openaiGptImage25Flare');
const { generateFlareBatchImage, waitForFlareBatchResult } = require('./adapters/fal/flareBatch');
const { generateArkImage } = require('~/server/services/ImageGeneration/adapters/ark');
const {
  MODEL_REGISTRY,
  resolveImageGenerationModel,
} = require('~/server/services/ImageGeneration/models');
const { extractHostname, isHostAllowed } = require('~/server/services/ImageGeneration/resultProxy');
const {
  getAuthorizedBatchResultFile,
  saveBatchResultImage,
  toClientBatchResultImage,
  toStoredBatchResultImage,
} = require('~/server/services/ImageGeneration/batchResultStorage');
const {
  normalizeGeneratedImageOutput,
} = require('~/server/services/ImageGeneration/normalizeImageOutput');
const {
  getPromptTemplateForBatch,
  resolvePackagingStyleTemplates,
} = require('~/server/services/ImageGeneration/promptTemplateStore');
const {
  getSafeAPIMartError,
  getSafeAPIMartLogContext,
  maskTaskId,
  pollTask,
} = require('~/server/services/ImageGeneration/adapters/apimart/common');
const {
  recordImageUsage,
  admitImageUsage,
  releaseImageUsage,
  buildImageUsageEnvelope,
} = require('~/server/services/UsageLedgerService');
const { admissionError } = require('~/server/services/UsageDelivery/admission');
const {
  BATCH_ITEM_LEASE_MS,
  acquirePersistentItemLease,
  createPersistentBatchTask,
  getTerminalExpiry,
  getRecoveryMode,
  getReferenceImageMetadata,
  loadPersistentBatchTask,
  updatePersistentItem,
  updatePersistentItemWithLease,
  updatePersistentUsageDelivery,
} = require('~/server/services/ImageGeneration/batchTaskPersistence');

const BATCH_CONCURRENCY = 1;
const BATCH_TTL_MS = 24 * 60 * 60 * 1000;
const CLEAN_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_MAIN_IMAGE_ASPECT_RATIO = '1:1';
const BATCH_MAIN_IMAGE_SIZE = getImageSize(BATCH_MAIN_IMAGE_ASPECT_RATIO);
const BATCH_MAIN_IMAGE_WIDTH = 1024;
const BATCH_MAIN_IMAGE_HEIGHT = 1024;
const BATCH_OUTPUT_WIDTH = 800;
const BATCH_OUTPUT_HEIGHT = 800;
const BATCH_RESULT_PROCESSING_TIMEOUT_MS = 2 * 60 * 1000;
const BATCH_WORKER_ID = `batch-worker-${process.pid}-${randomUUID()}`;
const LEASABLE_ITEM_STATUSES = [
  'pending',
  'submitting',
  'processing',
  'provider_succeeded',
  'processing_result',
  'failed',
];
const batchTaskStore = new Map();

function cleanupExpiredBatchTasks() {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [id, batch] of batchTaskStore.entries()) {
    if (!batch?.createdAt || now - batch.createdAt <= BATCH_TTL_MS) {
      continue;
    }

    batchTaskStore.delete(id);
    cleanedCount += 1;
    console.log(`[BatchCleanup] removed batch: ${id}`);
  }

  console.log(`[BatchCleanup] total cleaned: ${cleanedCount}`);
  return cleanedCount;
}

const cleanupTimer = setInterval(cleanupExpiredBatchTasks, CLEAN_INTERVAL_MS);
if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

function createBatchId() {
  return `batch_${randomUUID().replace(/-/g, '')}`;
}

function getUserHash(userId) {
  if (!userId) {
    return null;
  }
  return createHash('sha256').update(String(userId)).digest('hex').slice(0, 12);
}

function createBatchItemId() {
  return `item_${randomUUID().replace(/-/g, '')}`;
}

function applyPersistentItem(item, record) {
  item.persistenceStatus = record.status;
  item.usageContext = record.usageContext;
  item.usageDelivery = record.usageDelivery;
  item.usageRecorded = record.usageRecorded;
  if (item.internalJobItemId !== record.internalJobItemId) {
    item.internalTaskId = undefined;
    item.internalJobStatus = undefined;
  }
  item.internalJobItemId = record.internalJobItemId;
  // A legacy record can acquire its child link during read-only hydration.
  item.internalTaskId = record.internalTaskId || item.internalTaskId;
  item.internalJobStatus = record.internalJobStatus || item.internalJobStatus;
  item.providerTaskId = record.providerTaskId || undefined;
  item.providerStatus = record.providerStatus || undefined;
  item.providerResult = record.providerResult || undefined;
  item.resultImage = record.resultImage || item.resultImage;
  item.retryMode = record.retryMode || undefined;
  item.errorKind = record.errorKind || undefined;
  item.error = record.error || undefined;
  item.retryCount = record.retryCount || 0;
  item.submitAttempt = record.submitAttempt || 0;
}

function batchUsageInput(task, item, extra = {}) {
  return {
    userId: task.userId,
    tenantId: task.tenantId,
    requestId: task.id,
    batchId: task.id,
    itemId: item.internalJobItemId || item.itemId,
    provider: task.provider,
    model: task.model,
    modelKey: task.modelKey,
    taskType: task.mode === 'i2i' ? 'single-image-edit' : 'text-to-image',
    businessType: 'batch_image_generation',
    usageContext: item.usageContext,
    ...extra,
  };
}

function pendingBatchUsage(item, input) {
  if (item.internalTaskId) return undefined; // The durable child is the sole accounting owner.
  const previous = item.usageDelivery;
  if (previous?.envelope?.event.status === input.status) return previous;
  const revision = (previous?.revision ?? 0) + 1;
  const envelope = buildImageUsageEnvelope({ ...input, revision });
  return { state: 'pending', revision, ...(envelope ? { envelope } : {}) };
}

async function deliverBatchUsage(task, item, input) {
  if (
    item.internalTaskId ||
    !item.usageDelivery ||
    ['durable', 'persisted'].includes(item.usageDelivery.state)
  )
    return;
  try {
    const result = await recordImageUsage({ ...input, envelope: item.usageDelivery.envelope });
    let state = 'pending';
    if (result?.durableAccepted === true) state = 'durable';
    if (result?.ledgerPersisted === true) state = 'persisted';
    const record = await updatePersistentUsageDelivery({
      batchId: task.id,
      itemId: item.itemId,
      eventId: item.usageContext?.eventId,
      revision: item.usageDelivery.revision,
      state,
    });
    if (record) applyPersistentItem(item, record);
  } catch {
    logger.warn('[UsageDelivery] Batch usage remains pending');
  }
}

function createPersistenceConflictError() {
  const error = new Error('批量任务状态已由其他进程更新。');
  error.code = 'BATCH_TASK_STATE_CONFLICT';
  error.statusCode = 409;
  return error;
}

async function withBatchResultProcessingTimeout(operation) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error('图片结果处理超时。');
          error.code = 'IMAGE_OUTPUT_PROCESSING_TIMEOUT';
          reject(error);
        }, BATCH_RESULT_PROCESSING_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function transitionItemWithLease(task, item, statuses, updates, options = {}) {
  const record = await updatePersistentItemWithLease({
    batchId: task.id,
    itemId: item.itemId,
    workerId: BATCH_WORKER_ID,
    statuses,
    updates,
    releaseLease: Boolean(options.releaseLease),
    unsetFields: options.unsetFields || [],
  });
  if (!record) {
    throw createPersistenceConflictError();
  }
  applyPersistentItem(item, record);
  return record;
}

function injectTitle(prompt, title) {
  return prompt.replaceAll('{{title}}', title.trim());
}

function appendBatchMainImageOutputConstraint(prompt) {
  return `${prompt.trim()}

输出规格要求：
- 必须生成 1:1 方图
- 最终交付尺寸为 800x800
- 电商主图构图
- 商品主体居中完整展示
- 主体与重要文字保持在安全区域内，不要贴近四边
- 构图必须适合安全裁切为正方形
- 不要生成横版、竖版、长图或详情页比例
- 遵守电商平台合规要求
- 禁止虚假功效、医疗暗示、治疗承诺或夸张保证
- 不生成水印、二维码、平台违规营销词或误导性认证标识`;
}

function buildBatchMainImageRequestOptions() {
  return {
    aspectRatio: BATCH_MAIN_IMAGE_ASPECT_RATIO,
    size: BATCH_MAIN_IMAGE_SIZE,
    imageSize: BATCH_MAIN_IMAGE_SIZE,
    width: BATCH_MAIN_IMAGE_WIDTH,
    height: BATCH_MAIN_IMAGE_HEIGHT,
  };
}

function normalizeBase64Image(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.startsWith('data:') ? trimmed : `data:image/png;base64,${trimmed}`;
}

function normalizeGeneratedImage(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith('http')) {
      return { url: trimmed, b64_json: null };
    }
    if (trimmed.startsWith('data:')) {
      return { url: null, b64_json: trimmed };
    }
    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const imageString = typeof value.image === 'string' ? value.image.trim() : '';
  const directImage =
    imageString && (imageString.startsWith('http') || imageString.startsWith('data:'))
      ? normalizeGeneratedImage(imageString)
      : null;
  const url =
    value.url ||
    value.imageUrl ||
    value.image_url ||
    value.output_url ||
    value.resultUrl ||
    directImage?.url ||
    null;
  const b64_json =
    value.b64_json ||
    value.base64 ||
    (imageString && !imageString.startsWith('http') ? imageString : null) ||
    directImage?.b64_json ||
    null;

  if (!url && !b64_json) {
    return null;
  }

  return {
    url: url || null,
    b64_json: normalizeBase64Image(b64_json),
    width: Number.isFinite(Number(value.width)) ? Number(value.width) : null,
    height: Number.isFinite(Number(value.height)) ? Number(value.height) : null,
  };
}

function getFirstGeneratedImage(value, depth = 0) {
  const normalized = normalizeGeneratedImage(value);
  if (normalized) {
    return normalized;
  }

  if (!value || depth > 3) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const image = getFirstGeneratedImage(item, depth + 1);
      if (image) {
        return image;
      }
    }
    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const nestedKeys = ['images', 'data', 'output', 'outputs', 'result', 'results', 'artifacts'];
  for (const key of nestedKeys) {
    const image = getFirstGeneratedImage(value[key], depth + 1);
    if (image) {
      return image;
    }
  }

  return null;
}

function getResultImageDiagnostics(result) {
  return {
    resultKeys: result && typeof result === 'object' ? Object.keys(result) : [],
    hasImages: Boolean(Array.isArray(result?.images) && result.images.length),
    hasResultUrl: Boolean(result?.resultUrl),
    hasUrl: Boolean(result?.url),
    hasB64: Boolean(result?.b64_json),
    hasData: Boolean(result?.data),
    hasOutput: Boolean(result?.output || result?.outputs),
  };
}

function getBatchRequestDiagnostics(request) {
  return {
    expectedAspectRatio: BATCH_MAIN_IMAGE_ASPECT_RATIO,
    aspectRatio: request.aspectRatio || null,
    size: request.size || null,
    imageSize: request.imageSize || null,
    width: request.width || null,
    height: request.height || null,
    count: request.count || null,
    imageInputCount: Array.isArray(request.imageInputs) ? request.imageInputs.length : 0,
  };
}

function logBatchOutputNormalization({ task, item, resolvedModel, request, output, elapsedMs }) {
  logger.info('[BatchPackaging] output normalized', {
    batchId: task.id,
    provider: resolvedModel.provider,
    model: resolvedModel.model,
    templateId: item.templateId,
    templateName: item.templateName,
    mode: task.mode,
    taskType: request.taskType,
    ...getBatchRequestDiagnostics(request),
    originalWidth: output.originalWidth,
    originalHeight: output.originalHeight,
    targetWidth: output.width,
    targetHeight: output.height,
    normalized: output.normalized,
    resultHostname: output.sourceHostname || null,
    redirectHostnames: output.redirectHostnames || [],
    elapsedMs,
  });
}

const RESULT_ERROR_MESSAGES = {
  result_url_rejected: '生成结果地址未通过安全校验，请重试或联系管理员。',
  result_download_failed: '生成已完成，但图片下载失败，请重试。',
  invalid_image: '生成结果不是有效图片，请重试。',
  normalization_failed: '图片尺寸处理失败，请重试。',
  result_storage_failed: '生成已完成，但结果保存失败，请重试结果处理。',
};

function getBatchResultError(error) {
  let errorKind = error?.errorKind || null;
  if (!errorKind) {
    if (error?.code === 'RESULT_URL_REJECTED') {
      errorKind = 'result_url_rejected';
    } else if (
      [
        'RESULT_DOWNLOAD_FAILED',
        'RESULT_DOWNLOAD_TIMEOUT',
        'RESULT_DOWNLOAD_TOO_LARGE',
        'RESULT_URL_EXPIRED',
      ].includes(error?.code)
    ) {
      errorKind = 'result_download_failed';
    } else if (
      error?.name === 'AbortError' ||
      /operation was aborted|aborted/i.test(String(error?.message || ''))
    ) {
      errorKind = 'result_download_failed';
    } else if (['INVALID_RESULT_IMAGE', 'IMAGE_OUTPUT_INVALID'].includes(error?.code)) {
      errorKind = 'invalid_image';
    } else if (error?.code === 'RESULT_STORAGE_FAILED') {
      errorKind = 'result_storage_failed';
    } else if (
      ['IMAGE_OUTPUT_NORMALIZE_FAILED', 'IMAGE_OUTPUT_PROCESSING_TIMEOUT'].includes(error?.code)
    ) {
      errorKind = 'normalization_failed';
    }
  }
  return errorKind && RESULT_ERROR_MESSAGES[errorKind]
    ? { errorKind, message: RESULT_ERROR_MESSAGES[errorKind] }
    : null;
}

function isProviderFailure(error) {
  return ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(
    String(error?.providerStatus || '').toLowerCase(),
  );
}

function getItemRetryMode({ error, item, attemptedRetryMode }) {
  if (error?.retryMode) {
    return error.retryMode;
  }
  if (
    error?.code === 'IMAGE_GENERATION_TIMEOUT' &&
    (error?.providerTaskId || item?.providerTaskId)
  ) {
    return 'resume_polling';
  }
  if (isProviderFailure(error)) {
    return 'resubmit_provider';
  }
  if (error?.code === 'BATCH_NO_IMAGE') {
    return 'resubmit_provider';
  }
  if (getBatchResultError(error) && item?.providerResult?.status === 'succeeded') {
    return 'reprocess_result';
  }
  if (attemptedRetryMode === 'resume_polling') {
    return error?.code === 'IMAGE_GENERATION_TIMEOUT' ? 'resume_polling' : undefined;
  }
  return undefined;
}

async function createClientImage({ image, provider, task, item, onProgress }) {
  const normalizedImage = normalizeGeneratedImage(image);
  if (!normalizedImage?.url && !normalizedImage?.b64_json) {
    return null;
  }

  const output = await normalizeGeneratedImageOutput({
    image: normalizedImage,
    targetWidth: BATCH_OUTPUT_WIDTH,
    targetHeight: BATCH_OUTPUT_HEIGHT,
    isRemoteUrlAllowed: (url) => isHostAllowed(extractHostname(url)),
    sourceContext:
      provider === 'apimart' ? { sourceType: 'provider_result', provider: 'apimart' } : undefined,
    onProgress,
  });
  const storedImage = await saveBatchResultImage({ task, item, output });
  return toClientBatchResultImage({
    batchId: task.id,
    itemId: item.itemId,
    resultImage: storedImage,
  });
}

function serializeBatchTask(task) {
  if (!task) {
    return null;
  }

  const serializeResultImage = (image) => {
    if (!image) {
      return undefined;
    }
    const { url: _url, proxiedUrl: _proxiedUrl, downloadUrl: _downloadUrl, ...storedImage } = image;
    return storedImage;
  };

  return {
    id: task.id,
    title: task.title,
    mode: task.mode,
    provider: task.provider,
    modelKey: task.modelKey,
    model: task.model,
    outputSize: task.outputSize,
    outputWidth: task.outputWidth,
    outputHeight: task.outputHeight,
    referenceImage: task.referenceImage ? '[memory]' : undefined,
    status: task.status,
    cancelRequested: Boolean(task.cancelRequested),
    cancelledAt: task.cancelledAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    items: task.items.map((item) => ({
      itemId: item.itemId,
      templateId: item.templateId,
      templateName: item.templateName,
      prompt: item.prompt,
      status: item.status,
      resultImage: serializeResultImage(item.resultImage),
      error: item.error,
      errorKind: item.errorKind,
      retryMode: item.retryMode,
      retryCount: item.retryCount,
      provider: item.provider || task.provider,
      providerStatus: item.providerStatus,
      model: item.model || task.model,
      modelKey: item.modelKey || task.modelKey,
      submitAttempt: item.submitAttempt || 0,
    })),
  };
}

function recomputeBatchStatus(task) {
  if (task.status === 'cancelled' || task.cancelRequested) {
    task.status = 'cancelled';
    task.updatedAt = Date.now();
    return;
  }

  const hasRunning = task.items.some(
    (item) => item.status === 'running' || item.status === 'pending',
  );
  const hasSuccess = task.items.some((item) => item.status === 'success');
  const hasFailed = task.items.some((item) => item.status === 'failed');

  if (hasRunning) {
    task.status = task.items.some((item) => item.status === 'running') ? 'running' : 'pending';
  } else if (hasFailed && !hasSuccess) {
    task.status = 'failed';
  } else {
    task.status = 'done';
  }
  task.updatedAt = Date.now();
}

function isBatchCancelled(task) {
  return Boolean(task?.cancelRequested || task?.status === 'cancelled');
}

function markRemainingItemsCancelled(task, { includeRunning = false } = {}) {
  for (const item of task.items) {
    if (item.status === 'pending' || (includeRunning && item.status === 'running')) {
      item.status = 'cancelled';
      item.error = '任务已取消';
    }
  }
  task.updatedAt = Date.now();
}

function resolveBatchModel({ modelKey, model, taskType }) {
  const normalizedModelKey =
    typeof modelKey === 'string' && modelKey.trim() ? modelKey.trim() : null;
  const normalizedModel = typeof model === 'string' && model.trim() ? model.trim() : null;

  if (!normalizedModelKey && !normalizedModel) {
    const error = new Error('批量生成缺少单次生成当前选择的模型。');
    error.statusCode = 400;
    error.code = 'BATCH_MODEL_REQUIRED';
    throw error;
  }

  if (
    taskType === 'text-to-image' &&
    !normalizedModelKey &&
    normalizedModel === TEXT_TO_IMAGE_MODEL
  ) {
    return {
      modelKey: null,
      label: normalizedModel,
      provider: 'siliconflow',
      model: TEXT_TO_IMAGE_MODEL,
      capabilities: ['text-to-image'],
    };
  }

  const registryModelKey =
    normalizedModelKey ||
    (normalizedModel && MODEL_REGISTRY[normalizedModel] ? normalizedModel : null);

  return resolveImageGenerationModel({
    modelKey: registryModelKey,
    model: registryModelKey ? null : normalizedModel,
    taskType,
  });
}

async function generateImageByResolvedModel(resolvedModel, request, usageContext) {
  if (resolvedModel.provider === 'siliconflow') {
    if (request.taskType !== 'text-to-image') {
      const error = new Error('当前模型暂不支持图生图批量包装生成。');
      error.statusCode = 400;
      error.code = 'BATCH_MODEL_CAPABILITY_UNSUPPORTED';
      throw error;
    }

    return generateTextToImage({
      prompt: request.prompt,
      negativePrompt: NEGATIVE_PROMPT,
      size: request.size || BATCH_MAIN_IMAGE_SIZE,
      count: 1,
    });
  }

  if (resolvedModel.provider === 'apimart') {
    if (
      isAPIMartImg2ResolvedModel(resolvedModel) &&
      shouldUseAPIMartImg2AsyncForUser(request.userId)
    ) {
      return runAPIMartImg2JobAndWait({
        usageContext,
        userId: request.userId,
        tenantId: request.tenantId,
        requestId: request.requestId || request.batchId,
        frontendTaskId: request.frontendTaskId,
        batchTaskId: request.batchId,
        itemId: request.internalJobItemId || request.itemId,
        businessType: request.businessType || 'batch_image_generation',
        taskType: request.taskType,
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        modelKey: resolvedModel.modelKey,
        onJobUpdate: request.onJobUpdate,
        providerRequest: {
          ...request,
          model: resolvedModel.model,
        },
      });
    }
    return generateAPIMartImage({
      ...request,
      model: resolvedModel.model,
    });
  }

  if (resolvedModel.provider === 'fal') {
    if (isFlareModel(resolvedModel.model)) {
      return generateFlareBatchImage({ ...request, model: resolvedModel.model });
    }
    return generateFalImage({
      ...request,
      model: resolvedModel.model,
    });
  }

  if (resolvedModel.provider === 'ark') {
    return generateArkImage({
      ...request,
      model: resolvedModel.model,
    });
  }

  const error = new Error(`不支持的批量生图供应商：${resolvedModel.provider}`);
  error.statusCode = 400;
  error.code = 'BATCH_PROVIDER_UNSUPPORTED';
  throw error;
}

async function runBatchItem(task, item) {
  if (isBatchCancelled(task)) {
    item.status = 'cancelled';
    item.error = '任务已取消';
    task.updatedAt = Date.now();
    return;
  }

  const leasedRecord = await acquirePersistentItemLease({
    batchId: task.id,
    itemId: item.itemId,
    workerId: BATCH_WORKER_ID,
    statuses: LEASABLE_ITEM_STATUSES,
  });
  if (!leasedRecord) {
    item.status = 'running';
    return;
  }
  applyPersistentItem(item, leasedRecord);
  const attemptedRetryMode = getRecoveryMode({
    ...leasedRecord,
    internalTaskId: item.internalTaskId,
    internalJobStatus: item.internalJobStatus,
  });
  if (attemptedRetryMode === 'terminal') {
    return;
  }
  if (attemptedRetryMode === 'submit_unknown') {
    const errorMessage = '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。';
    await transitionItemWithLease(
      task,
      item,
      [item.persistenceStatus],
      {
        status: 'failed',
        errorKind: 'provider_submit_unknown',
        error: errorMessage,
        completedAt: new Date(),
        expiresAt: getTerminalExpiry('failed'),
      },
      { releaseLease: true },
    );
    item.status = 'failed';
    item.errorKind = 'provider_submit_unknown';
    item.error = errorMessage;
    return;
  }

  const runStartedAt = Date.now();
  const runId = (item.runId || 0) + 1;
  item.runId = runId;
  item.status = 'running';
  item.error = undefined;
  item.errorKind = undefined;
  task.status = 'running';
  task.updatedAt = Date.now();
  let resolvedModel = null;
  let providerRequest = null;

  try {
    const taskType = task.mode === 'i2i' ? 'single-image-edit' : 'text-to-image';
    const canReuseProviderResult =
      attemptedRetryMode === 'reprocess_result' &&
      item.providerResult?.status === 'succeeded' &&
      Boolean(item.providerResult?.image);
    const canResumeInternalJob =
      attemptedRetryMode === 'resume_polling' && Boolean(item.internalTaskId);
    const canResumeProviderPoll =
      !canResumeInternalJob &&
      (attemptedRetryMode === 'resume_polling' || attemptedRetryMode === 'reprocess_result') &&
      (task.provider === 'apimart' || (task.provider === 'fal' && isFlareModel(task.model))) &&
      Boolean(item.providerTaskId);
    // Persisted paid tasks can recover results after a model is retired.
    // Only these read/result branches bypass the current generation registry.
    resolvedModel =
      canReuseProviderResult || canResumeInternalJob || canResumeProviderPoll
        ? { modelKey: task.modelKey, model: task.model, provider: task.provider }
        : resolveBatchModel({ modelKey: task.modelKey, model: task.model, taskType });
    if (task.mode === 'i2i' && !task.referenceImage && attemptedRetryMode === 'resubmit_provider') {
      const error = new Error('参考图仅在原任务进程中可用于重新提交，请重新上传后发起新任务。');
      error.code = 'BATCH_REFERENCE_IMAGE_UNAVAILABLE';
      error.statusCode = 409;
      throw error;
    }
    providerRequest = {
      userId: task.userId,
      tenantId: task.tenantId,
      requestId: task.id,
      businessType: 'batch_image_generation',
      model: resolvedModel.model,
      modelKey: resolvedModel.modelKey,
      batchId: task.id,
      itemId: item.itemId,
      internalJobItemId: item.internalJobItemId,
      templateId: item.templateId,
      taskType,
      prompt: item.prompt,
      promptLength: item.prompt.length,
      imageInputs: task.mode === 'i2i' ? [task.referenceImage] : [],
      count: 1,
      isBatchMainImage: true,
      ...buildBatchMainImageRequestOptions(),
    };

    providerRequest.onJobUpdate = async (snapshot) => {
      await transitionItemWithLease(
        task,
        item,
        [item.persistenceStatus],
        {
          status: 'processing',
          internalTaskId: snapshot.internalTaskId,
          internalJobStatus: snapshot.status,
          providerTaskId: snapshot.providerTaskId || item.providerTaskId,
          providerStatus: snapshot.providerStatus || item.providerStatus,
          retryMode: 'resume_polling',
          error: undefined,
          errorKind: undefined,
          processingLeaseUntil: new Date(Date.now() + BATCH_ITEM_LEASE_MS),
        },
        { unsetFields: ['error', 'errorKind', 'completedAt', 'expiresAt'] },
      );
    };

    if (resolvedModel.provider === 'fal' && isFlareModel(resolvedModel.model)) {
      providerRequest.onProviderTaskSubmitted = async ({
        providerTaskId,
        providerMetadata,
        outputUrls,
      }) => {
        const image = outputUrls?.[0] ? { url: outputUrls[0] } : null;
        await transitionItemWithLease(task, item, ['submitting'], {
          status: image ? 'provider_succeeded' : 'processing',
          providerTaskId,
          providerStatus: image ? 'SUCCEEDED' : 'IN_PROGRESS',
          providerResult: {
            provider: 'fal',
            status: image ? 'succeeded' : 'processing',
            providerMetadata,
            image,
          },
          retryMode: image ? 'reprocess_result' : 'resume_polling',
        });
      };
      providerRequest.onProviderPoll = async ({ providerStatus }) => {
        await transitionItemWithLease(task, item, [item.persistenceStatus], {
          status: item.persistenceStatus,
          providerStatus,
          processingLeaseUntil: new Date(Date.now() + BATCH_ITEM_LEASE_MS),
        });
      };
    }

    if (attemptedRetryMode === 'resubmit_provider') {
      await transitionItemWithLease(task, item, [item.persistenceStatus], {
        status: 'submitting',
        retryMode: 'resubmit_provider',
        submitAttempt: (item.submitAttempt || 0) + 1,
        errorKind: undefined,
        error: undefined,
      });
      if (resolvedModel.provider === 'apimart') {
        providerRequest.onProviderTaskSubmitted = async ({ providerTaskId, providerStatus }) => {
          await transitionItemWithLease(task, item, ['submitting'], {
            status: 'processing',
            providerTaskId,
            providerStatus: providerStatus || 'IN_PROGRESS',
            retryMode: 'resume_polling',
          });
        };
        providerRequest.onProviderPoll = async ({ providerStatus }) => {
          await transitionItemWithLease(task, item, ['processing'], {
            status: 'processing',
            providerStatus,
            processingLeaseUntil: new Date(Date.now() + BATCH_ITEM_LEASE_MS),
          });
        };
      } else if (!providerRequest.onProviderTaskSubmitted) {
        await transitionItemWithLease(task, item, ['submitting'], {
          status: 'processing',
          providerStatus: 'IN_PROGRESS',
        });
      }
    }

    logger.info('[BatchPackaging] item request prepared', {
      batchId: task.id,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      templateId: item.templateId,
      templateName: item.templateName,
      mode: task.mode,
      taskType,
      promptLength: item.prompt.length,
      ...getBatchRequestDiagnostics(providerRequest),
    });

    logger.info('[BatchPackaging] retry mode selected', {
      batchId: task.id,
      itemId: item.itemId,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      retryCount: item.retryCount,
      retryMode: attemptedRetryMode,
      providerTaskIdMasked: maskTaskId(item.providerTaskId),
    });

    let result;
    if (canReuseProviderResult) {
      result = {
        images: [item.providerResult.image],
        billingMetadata: item.providerResult.billingMetadata,
        taskId: item.providerTaskId || null,
        status: 'success',
      };
    } else if (canResumeInternalJob) {
      result = await waitForAPIMartImg2Job({
        internalTaskId: item.internalTaskId,
        userId: task.userId,
        tenantId: task.tenantId,
        batchTaskId: task.id,
        itemId: item.internalJobItemId || item.itemId,
        model: task.model,
        onJobUpdate: providerRequest.onJobUpdate,
      });
    } else if (canResumeProviderPoll && resolvedModel.provider === 'fal') {
      result = await waitForFlareBatchResult({
        model: resolvedModel.model,
        providerTaskId: item.providerTaskId,
        providerMetadata: item.providerResult?.providerMetadata,
        onProviderPoll: providerRequest.onProviderPoll,
      });
    } else if (canResumeProviderPoll) {
      const completed = await pollTask({
        taskId: item.providerTaskId,
        model: resolvedModel.model,
        taskType,
        context: {
          modelKey: resolvedModel.modelKey,
          batchId: task.id,
          itemId: item.itemId,
          promptLength: item.prompt.length,
          providerTaskId: item.providerTaskId,
          onProviderPoll: async ({ providerStatus }) => {
            await transitionItemWithLease(task, item, [item.persistenceStatus], {
              status: item.persistenceStatus,
              providerStatus,
              processingLeaseUntil: new Date(Date.now() + BATCH_ITEM_LEASE_MS),
            });
          },
        },
      });
      result = { ...completed, taskId: item.providerTaskId };
    } else {
      const usageContext = await admitImageUsage(batchUsageInput(task, item));
      await transitionItemWithLease(task, item, [item.persistenceStatus], { usageContext });
      result = await generateImageByResolvedModel(resolvedModel, providerRequest, usageContext);
    }
    const firstImage = getFirstGeneratedImage(result);
    if (firstImage) {
      item.providerTaskId = result?.taskId || item.providerTaskId || undefined;
      const providerResult = {
        provider: resolvedModel.provider,
        billingMetadata: getImageProviderBillingMetadata(resolvedModel.provider, result),
        taskId: item.providerTaskId || null,
        status: 'succeeded',
        image: firstImage,
      };
      await transitionItemWithLease(task, item, [item.persistenceStatus], {
        status: 'provider_succeeded',
        providerTaskId: item.providerTaskId,
        providerStatus: 'SUCCEEDED',
        providerResult,
        retryMode: 'reprocess_result',
      });
      await transitionItemWithLease(task, item, ['provider_succeeded'], {
        status: 'processing_result',
        processingLeaseUntil: new Date(Date.now() + BATCH_ITEM_LEASE_MS),
      });
    }
    const normalizationStartedAt = Date.now();
    const image = await withBatchResultProcessingTimeout(
      createClientImage({
        image: firstImage,
        provider: resolvedModel.provider,
        task,
        item,
        onProgress: async (phase) => {
          await transitionItemWithLease(task, item, ['processing_result'], {
            status: 'processing_result',
            resultProcessingPhase: phase,
            resultProcessingUpdatedAt: new Date(),
            processingLeaseUntil: new Date(Date.now() + BATCH_ITEM_LEASE_MS),
          });
        },
      }),
    );
    if (!image) {
      logger.warn('[BatchPackaging] no image returned', {
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        taskType,
        ...getResultImageDiagnostics(result),
      });
      const error = new Error('no image returned');
      error.code = 'BATCH_NO_IMAGE';
      throw error;
    }
    logBatchOutputNormalization({
      task,
      item,
      resolvedModel,
      request: providerRequest,
      output: image,
      elapsedMs: Date.now() - normalizationStartedAt,
    });

    if (item.runId !== runId) {
      return;
    }

    if (isBatchCancelled(task) || (task.cancelledAt && task.cancelledAt >= runStartedAt)) {
      await transitionItemWithLease(
        task,
        item,
        [item.persistenceStatus],
        {
          status: 'cancelled',
          error: '任务已取消',
          completedAt: new Date(),
          expiresAt: getTerminalExpiry('cancelled'),
        },
        { releaseLease: true, unsetFields: ['providerResult'] },
      );
      item.status = 'cancelled';
      item.error = '任务已取消';
      task.status = 'cancelled';
      task.updatedAt = Date.now();
      return;
    }

    const usageInput = {
      usageContext: item.usageContext,
      userId: task.userId,
      tenantId: task.tenantId,
      requestId: task.id,
      batchId: task.id,
      itemId: item.internalJobItemId || item.itemId,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      modelKey: resolvedModel.modelKey,
      taskType,
      businessType: 'batch_image_generation',
      status: 'succeeded',
      imageCount: 1,
      providerTaskId: item.providerTaskId || result?.taskId || null,
      durationMs: Date.now() - runStartedAt,
      metadata: getImageProviderBillingMetadata(resolvedModel.provider, result),
    };
    await transitionItemWithLease(
      task,
      item,
      ['processing_result'],
      {
        status: 'succeeded',
        usageDelivery: pendingBatchUsage(item, usageInput),
        usageRecorded: false,
        resultImage: toStoredBatchResultImage(image),
        providerStatus: 'SUCCEEDED',
        completedAt: new Date(),
        expiresAt: getTerminalExpiry('succeeded'),
      },
      { releaseLease: true, unsetFields: ['providerResult'] },
    );
    item.status = 'success';
    item.resultImageUrl = image.url || undefined;
    item.resultImage = image;
    item.error = undefined;
    item.errorKind = undefined;
    item.retryMode = undefined;
    await deliverBatchUsage(task, item, usageInput);
  } catch (error) {
    if (item.runId !== runId) {
      return;
    }

    if (error?.code === 'BATCH_TASK_STATE_CONFLICT') {
      logger.warn('[BatchPackaging] stale worker update rejected', {
        batchId: task.id,
        itemId: item.itemId,
        workerId: BATCH_WORKER_ID,
        persistenceStatus: item.persistenceStatus,
      });
      return;
    }

    if (isBatchCancelled(task) || (task.cancelledAt && task.cancelledAt >= runStartedAt)) {
      await updatePersistentItem({
        batchId: task.id,
        itemId: item.itemId,
        statuses: LEASABLE_ITEM_STATUSES,
        updates: {
          status: 'cancelled',
          error: '任务已取消',
          completedAt: new Date(),
          expiresAt: getTerminalExpiry('cancelled'),
        },
        unsetFields: ['providerResult'],
      });
      item.status = 'cancelled';
      item.error = '任务已取消';
      task.status = 'cancelled';
      task.updatedAt = Date.now();
      return;
    }

    // The waiter has a bounded lifetime; its timeout is not a durable job
    // failure. Release this observer's lease so a later status read can resume.
    if (
      (item.internalTaskId && error?.code === 'APIMART_IMG2_INTERNAL_WAIT_TIMEOUT') ||
      (item.providerTaskId && error?.code === 'FAL_BATCH_WAIT_INTERRUPTED')
    ) {
      await transitionItemWithLease(
        task,
        item,
        [item.persistenceStatus],
        {
          status: 'processing',
          retryMode: 'resume_polling',
          internalTaskId: item.internalTaskId,
          internalJobStatus: item.internalJobStatus,
        },
        { releaseLease: true },
      );
      item.status = 'running';
      return;
    }
    if (item.internalTaskId && error?.code === 'APIMART_IMG2_JOB_NOT_FOUND') {
      item.internalJobStatus = 'missing';
    }
    item.status = 'failed';
    if (
      resolvedModel?.provider === 'fal' &&
      isFlareModel(resolvedModel.model) &&
      ['rejected', 'definitely_not_submitted'].includes(error?.submitOutcome)
    ) {
      error.retryMode = 'resubmit_provider';
      error.providerStatus = 'FAILED';
    }
    if (resolvedModel?.provider === 'apimart' && (error?.providerTaskId || item.providerTaskId)) {
      item.providerTaskId = item.providerTaskId || error.providerTaskId;
      if (!item.providerResult || item.providerResult.status !== 'succeeded') {
        item.providerResult = {
          provider: 'apimart',
          taskId: item.providerTaskId,
          status: error?.code === 'IMAGE_GENERATION_TIMEOUT' ? 'processing' : 'failed',
          image: null,
        };
      }
    }
    const resultError = getBatchResultError(error);
    const safeError =
      resolvedModel?.provider === 'apimart' && !resultError
        ? getSafeAPIMartError(error, {
            provider: 'apimart',
            model: resolvedModel.model,
            modelKey: resolvedModel.modelKey,
            batchId: task.id,
            itemId: item.templateId,
            taskType: providerRequest?.taskType,
            promptLength: item.prompt.length,
            providerTaskId: error?.providerTaskId,
            providerStatus: error?.providerStatus,
            timeoutMs: error?.timeoutMs,
            statusCode: error?.statusCode,
          })
        : error;
    item.errorKind = resultError?.errorKind || undefined;
    item.retryMode = getItemRetryMode({ error: safeError, item, attemptedRetryMode });
    item.error =
      resultError?.message ||
      safeError?.safeMessage ||
      safeError?.message ||
      '生成失败，请稍后重试。';
    item.providerStatus =
      safeError?.providerStatus ||
      item.providerStatus ||
      (error?.code === 'BATCH_NO_IMAGE' ? 'NO_RESULT' : undefined);
    const failureUsageInput = resolvedModel
      ? {
          usageContext: item.usageContext,
          userId: task.userId,
          tenantId: task.tenantId,
          requestId: task.id,
          batchId: task.id,
          itemId: item.internalJobItemId || item.itemId,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
          modelKey: resolvedModel.modelKey,
          taskType: providerRequest?.taskType || task.mode,
          businessType: 'batch_image_generation',
          status: 'failed',
          imageCount: 0,
          providerTaskId: item.providerTaskId || error?.providerTaskId || null,
          durationMs: Date.now() - runStartedAt,
          metadata: getImageProviderBillingMetadata(resolvedModel.provider, {
            billingMetadata: item.providerResult?.billingMetadata,
          }),
        }
      : null;
    const persistedFailure = await updatePersistentItemWithLease({
      batchId: task.id,
      itemId: item.itemId,
      workerId: BATCH_WORKER_ID,
      statuses: [item.persistenceStatus],
      updates: {
        status: 'failed',
        usageDelivery: failureUsageInput ? pendingBatchUsage(item, failureUsageInput) : undefined,
        usageRecorded: false,
        internalTaskId: item.internalTaskId,
        internalJobStatus: item.internalJobStatus,
        providerTaskId: item.providerTaskId,
        providerStatus: item.providerStatus,
        providerResult: item.providerResult,
        retryMode: item.retryMode,
        errorKind: item.errorKind,
        error: item.error,
        retryCount: item.retryCount || 0,
        completedAt: new Date(),
        expiresAt: getTerminalExpiry('failed'),
      },
      unsetFields: item.retryMode ? [] : ['retryMode'],
      releaseLease: true,
    });
    if (!persistedFailure) {
      logger.warn('[BatchPackaging] failed state persistence rejected', {
        batchId: task.id,
        itemId: item.itemId,
        workerId: BATCH_WORKER_ID,
        persistenceStatus: item.persistenceStatus,
      });
      return;
    }
    applyPersistentItem(item, persistedFailure);
    if (resolvedModel) await deliverBatchUsage(task, item, failureUsageInput);
    const failureContext = {
      batchId: task.id,
      provider: resolvedModel?.provider || task.provider || null,
      model: resolvedModel?.model || task.model,
      modelKey: resolvedModel?.modelKey || task.modelKey,
      mode: task.mode,
      templateId: item.templateId,
      templateName: item.templateName,
      taskType: providerRequest?.taskType || null,
      promptLength: item.prompt.length,
      statusCode: safeError?.statusCode,
      errorCode:
        safeError?.providerCode || safeError?.code || safeError?.statusCode || 'BATCH_ITEM_FAILED',
      errorName: safeError?.errorName || safeError?.name || null,
      errorMessage: safeError?.safeMessage || undefined,
      errorKind: item.errorKind || null,
      retryMode: item.retryMode,
      providerTaskIdMasked: maskTaskId(item.providerTaskId),
      resultHostname: safeError?.hostname || null,
      redirectHostname: safeError?.redirectHostname || null,
    };
    logger.warn('[BatchPackaging] item failed', {
      ...failureContext,
      ...(resolvedModel?.provider === 'apimart'
        ? getSafeAPIMartLogContext({
            ...failureContext,
            provider: 'apimart',
            providerTaskId: safeError?.providerTaskId,
            providerStatus: safeError?.providerStatus,
            timeoutMs: safeError?.timeoutMs,
          })
        : {}),
    });
  } finally {
    recomputeBatchStatus(task);
  }
}

async function runBatchTask(task) {
  if (task.runnerActive) {
    return;
  }

  task.runnerActive = true;
  let cursor = 0;
  const runnableItems = task.items.filter((item) => item.status === 'pending');
  const workerCount = Math.min(BATCH_CONCURRENCY, runnableItems.length);

  const runWorker = async () => {
    while (cursor < runnableItems.length) {
      if (isBatchCancelled(task)) {
        markRemainingItemsCancelled(task);
        break;
      }

      const item = runnableItems[cursor];
      cursor += 1;

      if (item.status !== 'pending') {
        continue;
      }

      await runBatchItem(task, item);

      if (isBatchCancelled(task)) {
        markRemainingItemsCancelled(task);
        break;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: workerCount }, runWorker));
  } finally {
    task.runnerActive = false;
    recomputeBatchStatus(task);
    if (!isBatchCancelled(task) && task.items.some((item) => item.status === 'pending')) {
      setImmediate(() => {
        void runBatchTask(task);
      });
    }
  }
}

function buildItemPrompt({ promptTemplate, packagingTemplate, title }) {
  const businessPrompt = promptTemplate?.prompt?.trim();
  if (!businessPrompt) {
    const error = new Error('默认全局提示词模板不可用。');
    error.statusCode = 500;
    error.code = 'BATCH_PROMPT_TEMPLATE_REQUIRED';
    throw error;
  }

  const basePrompt = `${businessPrompt}

包装款式参考：
${packagingTemplate.prompt.trim()}`;

  return appendBatchMainImageOutputConstraint(injectTitle(basePrompt, title));
}

async function createBatchTask({
  userId,
  tenantId,
  storageConfig,
  title,
  mode,
  modelKey,
  model,
  referenceImage,
  templateIds,
  promptTemplateId,
}) {
  const normalizedTitle = typeof title === 'string' ? title.trim() : '';
  if (!normalizedTitle) {
    const error = new Error('请先填写商品标题。');
    error.statusCode = 400;
    throw error;
  }

  const normalizedMode = mode === 'i2i' ? 'i2i' : 't2i';
  if (normalizedMode === 'i2i' && !referenceImage) {
    const error = new Error('图生图模式请先上传参考图。');
    error.statusCode = 400;
    throw error;
  }

  const taskType = normalizedMode === 'i2i' ? 'single-image-edit' : 'text-to-image';
  const resolvedModel = resolveBatchModel({ modelKey, model, taskType });

  const selectedTemplates = await resolvePackagingStyleTemplates(templateIds);

  const promptTemplate = await getPromptTemplateForBatch(promptTemplateId);

  const now = Date.now();
  const task = {
    id: createBatchId(),
    userId: userId || null,
    tenantId: tenantId || undefined,
    storageConfig,
    title: normalizedTitle,
    mode: normalizedMode,
    modelKey: resolvedModel.modelKey,
    model: resolvedModel.model,
    provider: resolvedModel.provider,
    outputSize: `${BATCH_OUTPUT_WIDTH}x${BATCH_OUTPUT_HEIGHT}`,
    outputWidth: BATCH_OUTPUT_WIDTH,
    outputHeight: BATCH_OUTPUT_HEIGHT,
    referenceImage,
    status: 'pending',
    cancelRequested: false,
    cancelledAt: undefined,
    createdAt: now,
    updatedAt: now,
    runnerActive: false,
    items: selectedTemplates.map((template) => ({
      itemId: createBatchItemId(),
      templateId: template.key,
      templateName: template.name,
      prompt: buildItemPrompt({
        promptTemplate,
        packagingTemplate: template,
        title: normalizedTitle,
      }),
      status: 'pending',
      persistenceStatus: 'pending',
      resultImageUrl: undefined,
      resultImage: undefined,
      error: undefined,
      errorKind: undefined,
      retryMode: undefined,
      providerTaskId: undefined,
      providerResult: undefined,
      cancelledAt: undefined,
      retryCount: 0,
      submitAttempt: 0,
    })),
  };

  try {
    for (const item of task.items)
      item.usageContext = await admitImageUsage(batchUsageInput(task, item));
  } catch (error) {
    await Promise.all(task.items.map((item) => releaseImageUsage(item.usageContext)));
    throw error;
  }
  // Unknown Mongo create outcomes retain reservations for source reconciliation.
  await createPersistentBatchTask(task);
  batchTaskStore.set(task.id, task);
  setImmediate(() => {
    void runBatchTask(task);
  });

  logger.info('[BatchPackaging] batch created', {
    batchId: task.id,
    userHash: getUserHash(task.userId),
    provider: task.provider,
    model: task.model,
    modelKey: task.modelKey,
    mode: task.mode,
    promptTemplateId: promptTemplate?._id || null,
    promptTemplateKey: promptTemplate?.key || null,
    itemCount: task.items.length,
    hasReferenceImage: Boolean(referenceImage),
  });

  return task;
}

async function getBatchTask(id, userId, { resume = true } = {}) {
  const task = await loadPersistentBatchTask(id, userId);
  if (!task) {
    return null;
  }

  const cachedTask = batchTaskStore.get(task.id);
  const sameCachedTask =
    cachedTask?.id === task.id &&
    cachedTask.userId === task.userId &&
    (cachedTask.tenantId || null) === (task.tenantId || null);
  if (sameCachedTask && cachedTask.runnerActive) {
    return cachedTask;
  }
  if (
    sameCachedTask &&
    task.mode === 'i2i' &&
    cachedTask.mode === task.mode &&
    Date.now() - cachedTask.createdAt <= BATCH_TTL_MS &&
    task.hasReferenceImage &&
    task.referenceImageFingerprint &&
    getReferenceImageMetadata(cachedTask.referenceImage).referenceImageFingerprint ===
      task.referenceImageFingerprint
  ) {
    task.referenceImage = cachedTask.referenceImage;
  }

  batchTaskStore.set(task.id, task);
  if (resume && task.items.some((item) => item.status === 'pending')) {
    setImmediate(() => {
      void runBatchTask(task);
    });
  }
  return task;
}

async function retryBatchItem(batchId, templateId, userId) {
  const task = await getBatchTask(batchId, userId, { resume: false });
  if (!task) {
    const error = new Error('批量任务不存在。');
    error.statusCode = 404;
    throw error;
  }

  const item = task.items.find((candidate) => candidate.templateId === templateId);
  if (!item) {
    const error = new Error('模板任务不存在。');
    error.statusCode = 404;
    throw error;
  }

  if (item.status === 'running' || item.status === 'pending') {
    return task;
  }
  if (
    item.status === 'cancelled' ||
    item.errorKind === 'provider_submit_unknown' ||
    !item.retryMode
  ) {
    const error = new Error(
      item.status === 'cancelled'
        ? '已取消任务不能重新执行。'
        : '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。',
    );
    error.statusCode = 409;
    error.code = 'BATCH_ITEM_RETRY_NOT_SAFE';
    throw error;
  }

  const retryCount = (item.retryCount || 0) + 1;
  const resubmit = item.retryMode === 'resubmit_provider';
  if (
    resubmit &&
    !item.internalTaskId &&
    item.usageContext &&
    !['durable', 'persisted'].includes(item.usageDelivery?.state)
  ) {
    // The next attempt replaces this source document; its predecessor must first
    // be durably accepted elsewhere, even if the ledger is still offline.
    let captured;
    try {
      captured = await recordImageUsage({
        usageContext: item.usageContext,
        envelope: item.usageDelivery?.envelope,
      });
    } catch {
      throw admissionError();
    }
    if (captured?.durableAccepted !== true && captured?.ledgerPersisted !== true)
      throw admissionError();
  }
  // Persist before enqueue: retries after a crash reuse this identity and the
  // existing unique index still deduplicates concurrent submissions.
  const internalJobItemId = resubmit ? createBatchItemId() : item.internalJobItemId;
  const usageContext = resubmit
    ? await admitImageUsage(
        batchUsageInput(task, { ...item, internalJobItemId, usageContext: undefined }),
      )
    : item.usageContext;
  const reset = await updatePersistentItem({
    batchId,
    itemId: item.itemId,
    statuses: ['failed'],
    expectedRetryCount: item.retryCount || 0,
    expectedInternalJobItemId: item.internalJobItemId || null,
    updates: {
      status: 'pending',
      retryMode: item.retryMode,
      internalJobItemId,
      usageContext,
      ...(resubmit
        ? {}
        : {
            providerTaskId: item.providerTaskId,
            providerStatus: item.providerStatus,
            providerResult: item.providerResult,
          }),
      retryCount,
      processingWorkerId: null,
      processingLeaseUntil: null,
    },
    unsetFields: [
      'error',
      'errorKind',
      'completedAt',
      'expiresAt',
      'resultImage',
      ...(resubmit
        ? [
            'usageDelivery',
            'usageRecorded',
            'internalTaskId',
            'internalJobStatus',
            'providerTaskId',
            'providerStatus',
            'providerResult',
          ]
        : []),
    ],
  });
  if (!reset) {
    if (resubmit) await releaseImageUsage(usageContext);
    throw createPersistenceConflictError();
  }

  applyPersistentItem(item, reset);
  task.cancelRequested = false;
  task.status = 'pending';
  item.runId = (item.runId || 0) + 1;
  item.status = 'pending';
  item.resultImageUrl = undefined;
  item.resultImage = undefined;
  item.error = undefined;
  item.errorKind = undefined;
  item.cancelledAt = undefined;
  item.retryCount = retryCount;
  item.persistenceStatus = 'pending';
  task.updatedAt = Date.now();
  setImmediate(() => {
    void runBatchTask(task);
  });
  logger.info('[BatchPackaging] item retry scheduled', {
    batchId,
    itemId: templateId,
    retryCount: item.retryCount,
    retryMode: item.retryMode || 'resubmit_provider',
    providerTaskIdMasked: maskTaskId(item.providerTaskId),
  });
  return task;
}

async function recoverBatchItemResult(batchId, itemId, userId, tenantId) {
  const task = await getBatchTask(batchId, userId, { resume: false });
  if (!task || (task.tenantId || null) !== (tenantId || null)) {
    const error = new Error('批量任务不存在。');
    error.statusCode = 404;
    throw error;
  }

  const item = task.items.find((candidate) => candidate.itemId === itemId);
  if (!item) {
    const error = new Error('批量结果不存在。');
    error.statusCode = 404;
    throw error;
  }

  const rejectRecovery = (errorKind, message = '当前成功结果不满足安全恢复条件。') => {
    logger.warn('[BatchPackaging] result recovery rejected', { batchId, itemId, errorKind });
    const error = new Error(message);
    error.statusCode = 409;
    error.code = errorKind;
    throw error;
  };

  if (item.status === 'pending' || item.status === 'running') {
    return task;
  }
  if (item.status !== 'success' || item.persistenceStatus !== 'succeeded') {
    rejectRecovery('recovery_status_mismatch', '当前任务状态不支持结果恢复。');
  }
  if (String(item.providerStatus || '').toUpperCase() !== 'SUCCEEDED') {
    rejectRecovery('recovery_provider_status_mismatch');
  }
  if (!item.providerTaskId) {
    rejectRecovery('recovery_missing_provider_task_id');
  }

  const storedFile = await getAuthorizedBatchResultFile({
    task,
    itemId,
    userId,
    tenantId,
  });
  if (item.resultImage?.fileId && storedFile) {
    return task;
  }

  /**
   * terminal 记录在水合时会把运行时 retryMode 归一化为 undefined，恢复判断必须
   * 使用持久化原值（persistedRetryMode）。旧数据兼容：仅当持久化 retryMode 缺失、
   * 且已确认 provider 成功 + providerTaskId 存在 + 稳定文件缺失（以上均已校验）时，
   * 才推导为 reprocess_result；持久化为其它显式模式一律拒绝。
   */
  const persistedRetryMode = item.persistedRetryMode ?? item.retryMode;
  if (persistedRetryMode != null && persistedRetryMode !== 'reprocess_result') {
    rejectRecovery('recovery_retry_mode_mismatch');
  }

  const reset = await updatePersistentItem({
    batchId,
    itemId,
    statuses: ['succeeded'],
    updates: {
      status: 'processing_result',
      retryMode: 'reprocess_result',
      errorKind: undefined,
      error: undefined,
      completedAt: undefined,
      expiresAt: undefined,
      processingWorkerId: null,
      processingLeaseUntil: null,
    },
    unsetFields: ['resultImage', 'completedAt', 'expiresAt', 'errorKind', 'error'],
  });
  if (!reset) {
    const latestTask = await getBatchTask(batchId, userId, { resume: false });
    return latestTask || task;
  }

  applyPersistentItem(item, reset);
  item.status = 'pending';
  item.resultImage = undefined;
  item.resultImageUrl = undefined;
  item.error = undefined;
  item.errorKind = undefined;
  item.retryMode = 'reprocess_result';
  task.status = 'pending';
  task.updatedAt = Date.now();
  batchTaskStore.set(task.id, task);
  setImmediate(() => {
    void runBatchTask(task);
  });
  logger.info('[BatchPackaging] result recovery scheduled', {
    batchId,
    itemId,
    providerTaskIdMasked: maskTaskId(item.providerTaskId),
  });
  return task;
}

async function cancelBatchTask(batchId, userId) {
  const task = await getBatchTask(batchId, userId, { resume: false });
  if (!task) {
    const error = new Error('批量任务不存在。');
    error.statusCode = 404;
    throw error;
  }

  if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
    return task;
  }

  const now = Date.now();
  for (const item of task.items) {
    if (!['pending', 'running'].includes(item.status)) {
      continue;
    }
    const cancelledItem = await updatePersistentItem({
      batchId,
      itemId: item.itemId,
      statuses: LEASABLE_ITEM_STATUSES,
      updates: {
        status: 'cancelled',
        error: '任务已取消',
        completedAt: new Date(now),
        expiresAt: getTerminalExpiry('cancelled', now),
        processingWorkerId: null,
        processingLeaseUntil: null,
      },
      unsetFields: ['providerResult'],
    });
    if (!cancelledItem) {
      logger.warn('[BatchPackaging] cancelled state persistence rejected', {
        batchId,
        itemId: item.itemId,
        persistenceStatus: item.persistenceStatus,
      });
    }
  }
  task.cancelRequested = true;
  task.cancelledAt = now;
  task.status = 'cancelled';
  task.updatedAt = now;
  markRemainingItemsCancelled(task, { includeRunning: true });

  logger.info('[BatchPackaging] batch cancelled', {
    batchId: task.id,
    userHash: getUserHash(task.userId),
    mode: task.mode,
  });

  return task;
}

module.exports = {
  batchTaskStore,
  cancelBatchTask,
  createBatchTask,
  getBatchResultError,
  getBatchTask,
  recoverBatchItemResult,
  retryBatchItem,
  serializeBatchTask,
};
