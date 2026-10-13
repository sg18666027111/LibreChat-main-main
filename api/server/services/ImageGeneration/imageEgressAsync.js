const { beginImageWorkerTick, setImageWorkerRunning } = require('@librechat/api');
const { randomUUID } = require('crypto');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');
const {
  recordImageUsage,
  admitImageUsage,
  releaseImageUsage,
  buildImageUsageEnvelope,
} = require('~/server/services/UsageLedgerService');
const { createFalImageEgressAdapter } = require('./adapters/fal');
const { createAPIMartGeminiImageEgressAdapter } = require('./adapters/apimart');
const {
  cleanupImageEgressInputRefs,
  promoteImageEgressInputRefsToJobOwnership,
  resolveImageEgressInputRefs,
  stageImageEgressInputs,
} = require('./imageEgressInputStorage');
const {
  cleanupUncommittedImageEgressOutput,
  downloadImageEgressOutputOnce,
  readImageEgressOutput,
  storeImageEgressOutput,
} = require('./imageEgressOutputStorage');
const {
  IMAGE_EGRESS_PROVIDER_MODEL_ALLOWSET,
  createImageEgressJobWorker,
  createMongoImageEgressJobStore,
  createMongoImageEgressSlotStore,
} = require('./imageEgressJobWorker');

const IMAGE_EGRESS_ASYNC_VERSION = 3;
const IMAGE_EGRESS_WORKER_FAMILY = 'image-egress-v1';
const IMAGE_EGRESS_ASYNC_MODES = new Set(['off', 'canary', 'all']);
const DEFAULT_WORKER_INTERVAL_MS = 1000;

function getImageEgressAsyncMode(env = process.env) {
  const mode = String(env.IMAGE_EGRESS_ASYNC_MODE || 'off')
    .trim()
    .toLowerCase();
  return IMAGE_EGRESS_ASYNC_MODES.has(mode) ? mode : 'off';
}

function getImageEgressCanaryUserIds(env = process.env) {
  return new Set(
    String(env.IMAGE_EGRESS_ASYNC_CANARY_USER_IDS || '')
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function getImageEgressMaxConcurrency(env = process.env) {
  const raw = String(env.IMAGE_EGRESS_MAX_CONCURRENCY || '').trim();
  const parsed = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function shouldUseImageEgressAsyncForUser({ userId, env = process.env }) {
  const mode = getImageEgressAsyncMode(env);
  if (mode === 'all') {
    return 'all';
  }
  if (mode !== 'canary' || !userId) {
    return null;
  }
  return getImageEgressCanaryUserIds(env).has(String(userId)) ? 'canary' : null;
}

function getImageEgressWorkerRolloutModes(env = process.env) {
  const mode = getImageEgressAsyncMode(env);
  if (mode === 'all') {
    return ['canary', 'all'];
  }
  if (mode === 'canary' && getImageEgressCanaryUserIds(env).size > 0) {
    return ['canary'];
  }
  return [];
}

function shouldStartImageEgressWorker(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || '').toLowerCase();
  if (nodeEnv === 'test' || nodeEnv === 'ci' || env.JEST_WORKER_ID) {
    return false;
  }
  return getImageEgressWorkerRolloutModes(env).length > 0;
}

function createInternalTaskId() {
  return `img3_${randomUUID().replace(/-/g, '')}`;
}

function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.codeName === 'DuplicateKey';
}

function getDefaultJobStore() {
  return {
    findByIdentity(identity) {
      return db.findImageEgressJobByIdentity(identity);
    },
    createJob(input) {
      return db.createImageGenerationJob(input);
    },
    activateJob({ job }) {
      return db.updateImageGenerationJob({
        internalTaskId: job.internalTaskId,
        statuses: ['waiting'],
        updates: { workerEligible: true },
      });
    },
    failInactiveJob({ internalTaskId, errorCode, error }) {
      return db.failInactiveImageEgressJob({ internalTaskId, errorCode, error });
    },
    failUnusableJob({ internalTaskId, errorCode, error, workerEligible = false }) {
      return db.updateImageGenerationJob({
        internalTaskId,
        statuses: ['waiting', 'failed'],
        updates: {
          status: 'failed',
          workerEligible,
          errorCode,
          error,
          completedAt: new Date(),
        },
      });
    },
  };
}

function getDefaultInputStorage() {
  return {
    stage: stageImageEgressInputs,
    promote: promoteImageEgressInputRefsToJobOwnership,
    cleanup: cleanupImageEgressInputRefs,
  };
}

function getIdentity({ userId, frontendTaskId, businessType, batchTaskId, itemId }) {
  return { userId, frontendTaskId, businessType, batchTaskId, itemId };
}

async function findOrStageAndEnqueueImageEgressJob({
  req,
  userId,
  tenantId,
  frontendTaskId,
  requestId,
  batchTaskId,
  itemId,
  businessType,
  taskType,
  subMode,
  provider,
  model,
  modelKey,
  payload = {},
  imageInputs = [],
  inputMetadata,
  rolloutMode,
  deps = {},
  usageContext,
}) {
  if (!rolloutMode || !['canary', 'all'].includes(rolloutMode)) {
    const error = new Error('Image egress async rollout is disabled for this user');
    error.code = 'IMAGE_EGRESS_ASYNC_DISABLED';
    error.statusCode = 400;
    throw error;
  }
  const hasFrontendIdentity = Boolean(frontendTaskId?.trim?.() && businessType?.trim?.());
  const hasBatchIdentity = Boolean(batchTaskId?.trim?.() && itemId?.trim?.());
  if (!hasFrontendIdentity && !hasBatchIdentity) {
    const error = new Error('A durable frontend or batch task identity is required');
    error.code = 'IMAGE_EGRESS_IDENTITY_REQUIRED';
    error.statusCode = 400;
    throw error;
  }
  if (Number(payload?.count ?? 1) !== 1) {
    const error = new Error('image-egress-v1 currently supports exactly one durable output');
    error.code = 'IMAGE_EGRESS_OUTPUT_COUNT_UNSUPPORTED';
    error.statusCode = 400;
    throw error;
  }

  const jobStore = deps.jobStore || getDefaultJobStore();
  const inputStorage = deps.inputStorage || getDefaultInputStorage();
  const identity = getIdentity({ userId, frontendTaskId, businessType, batchTaskId, itemId });
  const existing = await jobStore.findByIdentity(identity);
  if (existing) {
    if (existing.status === 'waiting' && existing.workerEligible === false) {
      try {
        await inputStorage.promote({
          internalTaskId: existing.internalTaskId,
          refs: existing.payload?.imageInputRefs || [],
        });
        const activated = await jobStore.activateJob({ job: existing });
        if (activated) {
          scheduleImageEgressJobRun();
          return { job: activated, created: false };
        }
      } catch {
        // Reconciliation is idempotent; keep the existing non-claimable job for a later attempt.
      }
    }
    return { job: existing, created: false };
  }

  const internalTaskId = createInternalTaskId();
  const admittedContext = await admitImageUsage({
    userId,
    tenantId,
    requestId: requestId || internalTaskId,
    batchId: batchTaskId,
    itemId,
    businessType,
    taskType,
    subMode,
    provider,
    model,
    modelKey,
    usageContext,
  });
  const staged = await inputStorage.stage({
    req,
    requestId,
    taskType,
    imageInputs,
    metadata: inputMetadata,
  });
  const refs = staged.refs || [];
  const cleanup = () =>
    inputStorage.cleanup({ req, userId, tenantId, refs, payload: { imageInputRefs: refs } });
  const { imageInputs: _inlineImages, ...durablePayload } = payload;
  const jobInput = {
    usageContext: admittedContext,
    tenantId,
    userId,
    internalTaskId,
    frontendTaskId,
    requestId: requestId || internalTaskId,
    batchTaskId,
    itemId,
    businessType,
    taskType,
    provider,
    model,
    modelKey,
    asyncVersion: IMAGE_EGRESS_ASYNC_VERSION,
    workerFamily: IMAGE_EGRESS_WORKER_FAMILY,
    rolloutMode,
    workerEligible: false,
    payload: {
      ...durablePayload,
      subMode,
      imageInputRefs: refs,
      inputMetadata,
      stagingBatchId: staged.stagingBatchId,
    },
    status: 'waiting',
    submittedToProvider: false,
    usageRecorded: false,
    currentOperation: 'input_read',
    queueEnteredAt: new Date(),
  };

  let job;
  try {
    job = await jobStore.createJob(jobInput);
  } catch (error) {
    await cleanup();
    if (isDuplicateKeyError(error)) {
      const winner = await jobStore.findByIdentity(identity);
      if (winner) {
        if (admittedContext?.reservationId !== winner.usageContext?.reservationId)
          await releaseImageUsage(admittedContext);
        return { job: winner, created: false };
      }
    }
    throw error;
  }

  async function recoverUnusableCreatedJob(error) {
    const failure = {
      internalTaskId: job.internalTaskId,
      errorCode: error?.code || 'IMAGE_EGRESS_INPUT_OWNERSHIP_FAILED',
      error: error?.message || 'Image egress input ownership failed',
    };
    let terminalizedJob;
    try {
      terminalizedJob = await jobStore.failInactiveJob(failure);
    } catch {
      // An unknown compare-and-set outcome must not clean inputs that an activated job may own.
    }
    if (!terminalizedJob) {
      let current;
      try {
        current = await jobStore.findByIdentity(identity);
      } catch {
        // The caller will fail closed; a later idempotent request can reconcile the job.
      }
      return { terminalized: false, current };
    }
    let cleaned = false;
    try {
      await cleanup();
      cleaned = true;
    } catch {
      // A terminalized job remains eligible so its worker can retry durable cleanup.
    }
    if (cleaned) {
      try {
        await jobStore.failUnusableJob({ ...failure, workerEligible: false });
      } catch {
        scheduleImageEgressJobRun();
      }
    } else {
      scheduleImageEgressJobRun();
    }
    return { terminalized: true, current: terminalizedJob };
  }

  try {
    await inputStorage.promote({ internalTaskId: job.internalTaskId, refs });
  } catch (error) {
    const recovery = await recoverUnusableCreatedJob(error);
    if (
      !recovery.terminalized &&
      recovery.current?.workerEligible === true &&
      ['waiting', 'submitting', 'polling', 'succeeded'].includes(recovery.current.status)
    ) {
      scheduleImageEgressJobRun();
      return { job: recovery.current, created: true };
    }
    throw error;
  }

  try {
    let activated;
    let activationAmbiguous = false;
    try {
      activated = await jobStore.activateJob({ job });
    } catch {
      activationAmbiguous = true;
      try {
        activated = await jobStore.activateJob({ job });
      } catch {
        // Re-read below; activation is idempotent but its result may be unknown.
      }
    }
    if (!activated && activationAmbiguous) {
      let confirmed;
      try {
        confirmed = await jobStore.findByIdentity(identity);
      } catch {
        // Never clean inputs after an ambiguous activation that may already be claimable.
      }
      if (confirmed?.workerEligible === true) {
        scheduleImageEgressJobRun();
        return { job: confirmed, created: true };
      }
      const error = new Error(
        confirmed
          ? 'Image egress job activation was confirmed inactive'
          : 'Image egress job activation outcome could not be confirmed',
      );
      error.code = confirmed
        ? 'IMAGE_EGRESS_JOB_ACTIVATION_FAILED'
        : 'IMAGE_EGRESS_JOB_ACTIVATION_UNKNOWN';
      error.skipInactiveRecovery = !confirmed;
      throw error;
    }
    if (!activated) {
      const error = new Error('Image egress job activation could not be confirmed');
      error.code = 'IMAGE_EGRESS_JOB_ACTIVATION_FAILED';
      throw error;
    }
    job = activated;
  } catch (error) {
    if (!error.skipInactiveRecovery) {
      const recovery = await recoverUnusableCreatedJob(error);
      if (
        !recovery.terminalized &&
        recovery.current?.workerEligible === true &&
        ['waiting', 'submitting', 'polling', 'succeeded'].includes(recovery.current.status)
      ) {
        scheduleImageEgressJobRun();
        return { job: recovery.current, created: true };
      }
    }
    throw error;
  }

  scheduleImageEgressJobRun();
  return { job, created: true };
}

async function getImageEgressJobStatus({ internalTaskId, userId }) {
  if (typeof db.getImageGenerationJob !== 'function') {
    return null;
  }
  const job = await db.getImageGenerationJob({ internalTaskId, userId, includeSensitive: true });
  if (
    !job ||
    job.asyncVersion !== IMAGE_EGRESS_ASYNC_VERSION ||
    job.workerFamily !== IMAGE_EGRESS_WORKER_FAMILY
  ) {
    return null;
  }
  let state = 'running';
  if (job.status === 'waiting') {
    state = 'queued';
  } else if (job.status === 'succeeded') {
    state = 'success';
  } else if (job.status === 'failed' || job.status === 'status_unknown') {
    state = job.status;
  }
  const resultUrl = `/api/image-generation/tasks/${job.internalTaskId}/result-image`;
  const error =
    job.status === 'failed' || job.status === 'status_unknown'
      ? {
          code: job.errorCode || 'IMAGE_GENERATION_FAILED',
          message: job.error || '图片生成失败，请重新生成。',
          retryableByUser: true,
        }
      : undefined;
  return {
    internalTaskId: job.internalTaskId,
    frontendTaskId: job.frontendTaskId || null,
    requestId: job.requestId,
    state,
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
    images: job.status === 'succeeded' ? [{ url: resultUrl, downloadUrl: resultUrl }] : [],
    outputCount: job.status === 'succeeded' ? 1 : 0,
    ...(error
      ? { error, errorCode: error.code, message: error.message, retryableByUser: true }
      : {}),
  };
}

async function readImageEgressJobOutput({ internalTaskId, userId, tenantId }) {
  if (typeof db.getImageGenerationJob !== 'function') {
    return null;
  }
  const job = await db.getImageGenerationJob({ internalTaskId, userId, includeSensitive: true });
  if (
    !job ||
    job.asyncVersion !== IMAGE_EGRESS_ASYNC_VERSION ||
    job.workerFamily !== IMAGE_EGRESS_WORKER_FAMILY ||
    job.status !== 'succeeded' ||
    !job.result?.fileRef
  ) {
    return null;
  }
  return readImageEgressOutput({
    userId,
    tenantId,
    fileRef: job.result.fileRef,
  });
}

function isImageEgressAsyncResolvedModel(resolvedModel) {
  return IMAGE_EGRESS_PROVIDER_MODEL_ALLOWSET.some(
    ({ provider, model }) => provider === resolvedModel?.provider && model === resolvedModel?.model,
  );
}

let workerController = null;
let workerShutdown = false;
const inFlightTicks = new Set();
let immediateRunScheduled = false;

function createDefaultImageEgressWorker({
  rolloutModes,
  getRolloutModes,
  maxConcurrency,
  shouldStop,
} = {}) {
  const adapters = Object.fromEntries(
    IMAGE_EGRESS_PROVIDER_MODEL_ALLOWSET.map(({ provider, model }) => [
      `${provider}:${model}`,
      provider === 'fal'
        ? createFalImageEgressAdapter({ model })
        : createAPIMartGeminiImageEgressAdapter({ model }),
    ]),
  );
  return createImageEgressJobWorker({
    workerId: `image-egress-worker-${process.pid}-${randomUUID()}`,
    jobStore: createMongoImageEgressJobStore({ db }),
    slotStore: createMongoImageEgressSlotStore({ db }),
    adapters,
    inputStorage: {
      resolve: resolveImageEgressInputRefs,
      cleanup: cleanupImageEgressInputRefs,
    },
    outputStorage: {
      download: downloadImageEgressOutputOnce,
      store: storeImageEgressOutput,
      cleanupUncommitted: cleanupUncommittedImageEgressOutput,
    },
    recordUsage: recordImageUsage,
    prepareUsage: buildImageUsageEnvelope,
    admitUsage: (job) =>
      admitImageUsage({
        ...job,
        batchId: job.batchTaskId,
        subMode: job.subMode || job.payload?.subMode,
      }),
    rolloutModes,
    getRolloutModes,
    maxConcurrency,
    shouldStop,
  });
}

function startImageEgressWorker({
  env = process.env,
  intervalMs = DEFAULT_WORKER_INTERVAL_MS,
  deps = {},
} = {}) {
  if (workerShutdown || !shouldStartImageEgressWorker(env)) {
    return null;
  }
  if (workerController) {
    return workerController;
  }
  const createWorker = deps.createWorker || createDefaultImageEgressWorker;
  const worker = createWorker({
    rolloutModes: getImageEgressWorkerRolloutModes(env),
    getRolloutModes: () => getImageEgressWorkerRolloutModes(env),
    maxConcurrency: getImageEgressMaxConcurrency(env),
    shouldStop: () => workerShutdown,
  });
  const initializeStorage =
    deps.initializeStorage ||
    (() =>
      Promise.all([db.ensureImageGenerationJobStorage(), db.ensureImageEgressWorkerSlotStorage()]));
  let storageReady = null;
  function ensureStorageReady() {
    storageReady ||= Promise.resolve()
      .then(() => initializeStorage())
      .catch((error) => {
        storageReady = null;
        throw error;
      });
    return storageReady;
  }
  let stopped = false;
  async function executeTick() {
    if (stopped || workerShutdown) {
      return null;
    }
    const enabled = getImageEgressWorkerRolloutModes(env).length > 0;
    setImageWorkerRunning('image_egress', enabled);
    if (!enabled) {
      return null;
    }
    const finishTick = beginImageWorkerTick('image_egress');
    let tickResult = 'success';
    try {
      await ensureStorageReady();
      if (stopped || workerShutdown) {
        return null;
      }
      return await worker.runOnce();
    } catch (error) {
      tickResult = 'error';
      logger.warn('[ImageGeneration] image-egress-v1 worker tick failed', {
        errorCode: error?.code || 'IMAGE_EGRESS_WORKER_TICK_FAILED',
      });
      return null;
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
  timer.unref?.();
  const controller = {
    runTick,
    stop() {
      stopped = true;
      clearInterval(timer);
      if (workerController === controller) {
        setImageWorkerRunning('image_egress', false);
        workerController = null;
      }
    },
  };
  workerController = controller;
  setImageWorkerRunning('image_egress', true);
  return workerController;
}

function stopImageEgressWorker() {
  workerShutdown = true;
  workerController?.stop();
}

async function waitForImageEgressWorker() {
  await Promise.allSettled([...inFlightTicks]);
}

function scheduleImageEgressJobRun(env = process.env) {
  const controller = startImageEgressWorker({ env });
  if (!controller || immediateRunScheduled) {
    return;
  }
  immediateRunScheduled = true;
  setImmediate(async () => {
    immediateRunScheduled = false;
    await controller.runTick();
  });
}

module.exports = {
  stopImageEgressWorker,
  waitForImageEgressWorker,
  IMAGE_EGRESS_ASYNC_VERSION,
  IMAGE_EGRESS_WORKER_FAMILY,
  createDefaultImageEgressWorker,
  findOrStageAndEnqueueImageEgressJob,
  getImageEgressAsyncMode,
  getImageEgressCanaryUserIds,
  getImageEgressJobStatus,
  getImageEgressMaxConcurrency,
  getImageEgressWorkerRolloutModes,
  isImageEgressAsyncResolvedModel,
  readImageEgressJobOutput,
  shouldStartImageEgressWorker,
  shouldUseImageEgressAsyncForUser,
  scheduleImageEgressJobRun,
  startImageEgressWorker,
};

if (shouldStartImageEgressWorker(process.env)) {
  startImageEgressWorker({ env: process.env });
}
