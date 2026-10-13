const { beginImageWorkerTick, setImageWorkerRunning } = require('@librechat/api');
const { createHash, randomUUID } = require('crypto');
const { BSON } = require('bson');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');
const {
  recordImageUsage,
  admitImageUsage,
  releaseImageUsage,
  buildImageUsageEnvelope,
} = require('~/server/services/UsageLedgerService');
const {
  generateAPIMartImage,
  resumeAPIMartImage,
} = require('~/server/services/ImageGeneration/adapters/apimart');
const { getAPIMartConfig } = require('~/server/services/ImageGeneration/adapters/apimart/common');
const {
  extractHostname,
  registerResultImage,
  registerResultImageBuffer,
} = require('~/server/services/ImageGeneration/resultProxy');
const {
  createAPIMartImg2JobWorker,
  createAPIMartImg2ProviderAdapter,
  createMongoAPIMartImg2JobStore,
} = require('~/server/services/ImageGeneration/apimartImg2JobWorker');

const APIMART_IMG2_MODEL = 'gpt-image-2';
const APIMART_PROVIDER = 'apimart';
const APIMART_IMG2_ASYNC_VERSION = 2;
const APIMART_IMG2_ASYNC_MODES = new Set(['off', 'canary', 'all']);
const DEFAULT_WORKER_INTERVAL_MS = 1000;
const DEFAULT_JOB_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const APIMART_IMG2_JOB_BSON_SAFE_BYTES = 15 * 1024 * 1024;

function createInternalTaskId() {
  return `img2_${randomUUID().replace(/-/g, '')}`;
}

function getShortHash(value) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 12);
}

function getAPIMartAPIKeyFingerprint() {
  const { apiKey } = getAPIMartConfig();
  return getShortHash(apiKey);
}

function getAPIMartImg2ResourceKey(apiKeyFingerprint = getAPIMartAPIKeyFingerprint()) {
  return `${APIMART_PROVIDER}:${apiKeyFingerprint}:${APIMART_IMG2_MODEL}`;
}

function getAPIMartImg2MaxConcurrency() {
  const parsed = Number.parseInt(process.env.APIMART_IMG2_MAX_CONCURRENCY || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function getAPIMartImg2AsyncMode() {
  const mode = String(process.env.APIMART_IMG2_ASYNC_MODE || 'off')
    .trim()
    .toLowerCase();
  return APIMART_IMG2_ASYNC_MODES.has(mode) ? mode : 'off';
}

function getAPIMartImg2AsyncCanaryUserIds() {
  return new Set(
    String(process.env.APIMART_IMG2_ASYNC_CANARY_USER_IDS || '')
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function getAPIMartImg2AsyncRolloutModeForUser(userId) {
  const mode = getAPIMartImg2AsyncMode();
  if (mode === 'all') {
    return 'all';
  }
  if (mode !== 'canary' || !userId) {
    return null;
  }
  return getAPIMartImg2AsyncCanaryUserIds().has(String(userId)) ? 'canary' : null;
}

function shouldUseAPIMartImg2AsyncForUser(userId) {
  return Boolean(getAPIMartImg2AsyncRolloutModeForUser(userId));
}

function shouldStartAPIMartImg2JobWorker() {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  if (nodeEnv === 'test' || nodeEnv === 'ci' || process.env.JEST_WORKER_ID) {
    return false;
  }
  const mode = getAPIMartImg2AsyncMode();
  if (mode === 'off') {
    return false;
  }
  if (mode === 'all') {
    return true;
  }
  return getAPIMartImg2AsyncCanaryUserIds().size > 0;
}

function getAPIMartImg2WorkerRolloutModes() {
  const mode = getAPIMartImg2AsyncMode();
  if (mode === 'all') {
    return ['canary', 'all'];
  }
  if (mode === 'canary') {
    return ['canary'];
  }
  return [];
}

function isAPIMartImg2ResolvedModel(resolvedModel) {
  return (
    resolvedModel?.provider === APIMART_PROVIDER &&
    [APIMART_IMG2_MODEL, 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'].includes(
      resolvedModel?.model,
    )
  );
}

function assertSafeAPIMartImg2JobDocument(input) {
  const size = BSON.calculateObjectSize(input);
  if (size <= APIMART_IMG2_JOB_BSON_SAFE_BYTES) {
    return;
  }
  const error = new Error('图片任务元数据过大，请压缩参考图或减少输入后重试。');
  error.code = 'APIMART_IMG2_JOB_PAYLOAD_TOO_LARGE';
  error.statusCode = 413;
  error.payloadBytes = size;
  throw error;
}

function getStateFromJobStatus(status) {
  if (status === 'succeeded') {
    return 'success';
  }
  if (status === 'failed' || status === 'cancelled') {
    return status;
  }
  if (status === 'status_unknown') {
    return 'status_unknown';
  }
  if (status === 'waiting') {
    return 'queued';
  }
  return 'running';
}

function withoutProxy(image) {
  return { ...image, proxiedUrl: null, downloadUrl: null };
}

function decorateImagesWithProxy(images, provider) {
  return images.map((image) => {
    if (Buffer.isBuffer(image?.buffer)) {
      const { buffer, contentType, originalUrl: _originalUrl, ...serializableImage } = image;
      const extension = contentType === 'image/jpeg' ? 'jpg' : contentType?.split('/')[1] || 'png';
      const registered = registerResultImageBuffer({
        buffer,
        contentType,
        provider,
        filename: `ai-image-result.${extension}`,
      });
      return {
        ...serializableImage,
        url: registered.proxyPath,
        b64_json: null,
        proxiedUrl: registered.proxyPath,
        downloadUrl: registered.downloadPath,
      };
    }

    if (!image?.url) {
      return withoutProxy(image);
    }

    const registered = registerResultImage({ resultUrl: image.url, provider });
    return {
      ...image,
      proxiedUrl: registered?.proxyPath ?? null,
      downloadUrl: registered?.downloadPath ?? null,
    };
  });
}

function buildClientResultImages(result, provider) {
  let sourceImages = [];
  if (Array.isArray(result?.images) && result.images.length) {
    sourceImages = result.images;
  } else if (result?.resultUrl) {
    sourceImages = [{ url: result.resultUrl, b64_json: null }];
  }

  if (!sourceImages.length) {
    return { images: [], outputCount: 0, resultHost: null };
  }

  const baseImages = sourceImages.map((image) => ({
    ...image,
    b64_json: image.b64_json ?? null,
  }));
  const resultHost = extractHostname(baseImages[0]?.originalUrl || baseImages[0]?.url);

  try {
    const images = decorateImagesWithProxy(baseImages, provider);
    return { images, outputCount: images.length, resultHost };
  } catch {
    return {
      images: baseImages.map(withoutProxy),
      outputCount: baseImages.length,
      resultHost,
    };
  }
}

let workerController = null;
let workerShutdown = false;
const inFlightTicks = new Set();
let immediateRunScheduled = false;

function createDefaultAPIMartImg2Worker() {
  const workerId = `apimart-img2-worker-${process.pid}-${randomUUID()}`;
  return createAPIMartImg2JobWorker({
    workerId,
    maxConcurrency: getAPIMartImg2MaxConcurrency(),
    store: createMongoAPIMartImg2JobStore({
      db,
      maxConcurrency: getAPIMartImg2MaxConcurrency(),
      rolloutModes: getAPIMartImg2WorkerRolloutModes(),
    }),
    provider: createAPIMartImg2ProviderAdapter({ generateAPIMartImage, resumeAPIMartImage }),
    recordUsage: recordImageUsage,
    prepareUsage: buildImageUsageEnvelope,
    admitUsage: (job) =>
      admitImageUsage({
        ...job,
        batchId: job.batchTaskId,
        subMode: job.subMode || job.payload?.subMode,
      }),
  });
}

function startAPIMartImg2JobWorker({ worker, intervalMs = DEFAULT_WORKER_INTERVAL_MS } = {}) {
  if (workerShutdown) {
    return null;
  }
  if (workerController) {
    return workerController;
  }
  worker ||= createDefaultAPIMartImg2Worker();

  let stopped = false;
  async function executeTick() {
    if (stopped || workerShutdown) {
      return;
    }
    setImageWorkerRunning('apimart_img2', true);
    const finishTick = beginImageWorkerTick('apimart_img2');
    let tickResult = 'success';
    try {
      await worker.runOnce();
    } catch (error) {
      tickResult = 'error';
      logger.warn('[ImageGeneration] APIMart img2 worker tick failed', {
        errorCode: error?.code || error?.statusCode || 'APIMART_IMG2_WORKER_TICK_FAILED',
        message: error?.safeMessage || error?.message,
      });
    } finally {
      finishTick(tickResult);
    }
  }

  function runTick() {
    const tick = executeTick();
    inFlightTicks.add(tick);
    const forget = () => inFlightTicks.delete(tick);
    void tick.then(forget, forget);
    return tick;
  }

  const timer = setInterval(runTick, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  const controller = {
    runTick,
    stop() {
      stopped = true;
      clearInterval(timer);
      if (workerController === controller) {
        setImageWorkerRunning('apimart_img2', false);
        workerController = null;
      }
    },
  };
  workerController = controller;
  setImageWorkerRunning('apimart_img2', true);
  return workerController;
}

function stopAPIMartImg2JobWorker() {
  workerShutdown = true;
  workerController?.stop();
}

async function waitForAPIMartImg2JobWorker() {
  await Promise.allSettled([...inFlightTicks]);
}

function scheduleAPIMartImg2JobRun() {
  if (workerShutdown || !shouldStartAPIMartImg2JobWorker()) {
    return;
  }
  const controller = startAPIMartImg2JobWorker();
  if (immediateRunScheduled) {
    return;
  }
  immediateRunScheduled = true;
  setImmediate(async () => {
    immediateRunScheduled = false;
    await controller.runTick();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enqueueAPIMartImg2Job({
  userId,
  tenantId,
  requestId,
  frontendTaskId,
  businessType,
  taskType,
  subMode,
  provider,
  model,
  modelKey,
  payload,
  batchTaskId,
  itemId,
  rolloutMode,
  usageContext,
}) {
  const internalTaskId = createInternalTaskId();
  const apiKeyFingerprint = getAPIMartAPIKeyFingerprint();
  const resourceKey = getAPIMartImg2ResourceKey(apiKeyFingerprint);
  const queueEnteredAt = new Date();
  const resolvedRolloutMode = rolloutMode || getAPIMartImg2AsyncRolloutModeForUser(userId);
  if (!resolvedRolloutMode) {
    const error = new Error('APIMart img2 async rollout is disabled for this user');
    error.code = 'APIMART_IMG2_ASYNC_DISABLED';
    error.statusCode = 400;
    throw error;
  }
  const createJob =
    db.findOrCreateImageGenerationJob ||
    (async (input) => ({
      job: await db.createImageGenerationJob(input),
      deduplicated: false,
    }));

  const jobInput = {
    tenantId,
    userId,
    internalTaskId,
    frontendTaskId,
    requestId: requestId || internalTaskId,
    batchTaskId,
    itemId,
    businessType,
    taskType,
    subMode,
    provider,
    model,
    modelKey,
    apiKeyFingerprint,
    resourceKey,
    asyncVersion: APIMART_IMG2_ASYNC_VERSION,
    rolloutMode: resolvedRolloutMode,
    workerEligible: true,
    payload: {
      ...payload,
      originalRequestId: requestId,
    },
    status: 'waiting',
    submittedToProvider: false,
    usageRecorded: false,
    queueEnteredAt,
  };
  jobInput.usageContext = await admitImageUsage({
    ...jobInput,
    batchId: batchTaskId,
    usageContext,
  });
  assertSafeAPIMartImg2JobDocument(jobInput);

  const { job, deduplicated } = await createJob(jobInput);
  if (deduplicated && jobInput.usageContext?.reservationId !== job.usageContext?.reservationId) {
    await releaseImageUsage(jobInput.usageContext);
  }
  const storedInternalTaskId = job.internalTaskId || internalTaskId;

  logger.info('[ImageGeneration] APIMart img2 internal job queued', {
    requestId,
    internalTaskId: storedInternalTaskId,
    frontendTaskId,
    businessType,
    taskType,
    provider,
    model,
    modelKey,
    asyncVersion: APIMART_IMG2_ASYNC_VERSION,
    rolloutMode: resolvedRolloutMode,
    apiKeyFingerprint,
    queueEnteredAt: job.queueEnteredAt || queueEnteredAt,
    submittedToProvider: false,
    finalStatus: 'waiting',
    deduplicated,
  });
  scheduleAPIMartImg2JobRun();

  return {
    internalTaskId: storedInternalTaskId,
    status: job.status || 'waiting',
    submittedToProvider: Boolean(job.submittedToProvider),
    queueEnteredAt: job.queueEnteredAt || queueEnteredAt,
    deduplicated,
  };
}

async function getAPIMartImg2JobStatus({ internalTaskId, userId }) {
  const job = await db.getImageGenerationJob({
    internalTaskId,
    userId,
    includeSensitive: true,
  });
  if (!job) {
    return null;
  }

  const resultImages =
    job.status === 'succeeded'
      ? buildClientResultImages(job.result, job.provider || APIMART_PROVIDER)
      : { images: [], outputCount: 0, resultHost: null };

  return {
    internalTaskId: job.internalTaskId,
    frontendTaskId: job.frontendTaskId || null,
    requestId: job.requestId,
    state: getStateFromJobStatus(job.status),
    status: job.status,
    submittedToProvider: Boolean(job.submittedToProvider),
    provider: job.provider,
    model: job.model,
    modelKey: job.modelKey || null,
    taskType: job.taskType,
    businessType: job.businessType,
    providerTaskId: job.providerTaskId || null,
    providerStatus: job.providerStatus || null,
    queueEnteredAt: job.queueEnteredAt || null,
    providerAcceptedAt: job.providerAcceptedAt || null,
    providerFinishedAt: job.providerFinishedAt || null,
    completedAt: job.completedAt || null,
    images: resultImages.images,
    outputCount: resultImages.outputCount,
    errorCode: job.errorCode || job.error?.code || null,
    message: job.error || null,
  };
}

async function runAPIMartImg2JobAndWait({
  userId,
  tenantId,
  requestId,
  frontendTaskId,
  batchTaskId,
  itemId,
  businessType,
  taskType,
  subMode,
  provider,
  model,
  modelKey,
  providerRequest,
  usageContext,
  onJobUpdate,
  pollIntervalMs = 1000,
  waitTimeoutMs = DEFAULT_JOB_WAIT_TIMEOUT_MS,
}) {
  const job = await enqueueAPIMartImg2Job({
    usageContext,
    userId,
    tenantId,
    requestId,
    frontendTaskId,
    batchTaskId,
    itemId,
    businessType,
    taskType,
    subMode,
    provider,
    model,
    modelKey,
    payload: Object.fromEntries(
      Object.entries(providerRequest || {}).filter(([, value]) => typeof value !== 'function'),
    ),
  });
  await onJobUpdate?.(job);
  return waitForAPIMartImg2Job({
    internalTaskId: job.internalTaskId,
    userId,
    tenantId,
    batchTaskId,
    itemId,
    model,
    onJobUpdate,
    pollIntervalMs,
    waitTimeoutMs,
  });
}

async function waitForAPIMartImg2Job({
  internalTaskId,
  userId,
  tenantId,
  batchTaskId,
  itemId,
  model,
  onJobUpdate,
  pollIntervalMs = 1000,
  waitTimeoutMs = DEFAULT_JOB_WAIT_TIMEOUT_MS,
}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= waitTimeoutMs) {
    scheduleAPIMartImg2JobRun();
    const stored = await db.getImageGenerationJob({
      internalTaskId,
      userId,
      includeSensitive: true,
    });
    if (
      !stored ||
      stored.userId !== userId ||
      (stored.tenantId || null) !== (tenantId || null) ||
      (batchTaskId && (stored.batchTaskId !== batchTaskId || stored.itemId !== itemId)) ||
      stored.provider !== APIMART_PROVIDER ||
      stored.asyncVersion !== APIMART_IMG2_ASYNC_VERSION ||
      (model && stored.model !== model)
    ) {
      const error = new Error('APIMart img2 internal job disappeared');
      error.code = 'APIMART_IMG2_JOB_NOT_FOUND';
      error.statusCode = 500;
      throw error;
    }
    await onJobUpdate?.({
      internalTaskId: stored.internalTaskId,
      status: stored.status,
      providerTaskId: stored.providerTaskId,
      providerStatus: stored.providerStatus,
    });
    if (stored.status === 'succeeded') {
      return {
        ...(stored.result || {}),
        taskId: stored.providerTaskId || stored.result?.taskId || null,
      };
    }
    if (
      stored.status === 'failed' ||
      stored.status === 'status_unknown' ||
      stored.status === 'cancelled'
    ) {
      const error = new Error(stored.error || 'APIMart img2 internal job did not succeed');
      error.code = stored.errorCode || `APIMART_IMG2_JOB_${String(stored.status).toUpperCase()}`;
      error.statusCode = stored.status === 'failed' ? 502 : 504;
      error.internalJobStatus = stored.status;
      error.providerTaskId = stored.providerTaskId || null;
      error.providerStatus = stored.providerStatus || null;
      throw error;
    }
    await sleep(pollIntervalMs);
  }

  const error = new Error('APIMart img2 internal job wait timed out');
  error.code = 'APIMART_IMG2_INTERNAL_WAIT_TIMEOUT';
  error.statusCode = 504;
  throw error;
}

module.exports = {
  stopAPIMartImg2JobWorker,
  waitForAPIMartImg2JobWorker,
  APIMART_IMG2_MODEL,
  APIMART_PROVIDER,
  enqueueAPIMartImg2Job,
  getAPIMartAPIKeyFingerprint,
  getAPIMartImg2AsyncMode,
  getAPIMartImg2AsyncRolloutModeForUser,
  getAPIMartImg2WorkerRolloutModes,
  getAPIMartImg2MaxConcurrency,
  getAPIMartImg2ResourceKey,
  getAPIMartImg2JobStatus,
  isAPIMartImg2ResolvedModel,
  runAPIMartImg2JobAndWait,
  waitForAPIMartImg2Job,
  scheduleAPIMartImg2JobRun,
  assertSafeAPIMartImg2JobDocument,
  shouldStartAPIMartImg2JobWorker,
  shouldUseAPIMartImg2AsyncForUser,
  startAPIMartImg2JobWorker,
};

if (shouldStartAPIMartImg2JobWorker()) {
  startAPIMartImg2JobWorker();
}
