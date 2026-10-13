const { createAPIMartImageTiming } = require('@librechat/api');
const { createHash, randomUUID } = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { getImageProviderBillingMetadata } = require('./providerBilling');
const {
  cleanupAPIMartImg2JobInputRefs,
  resolveAPIMartImg2JobPayload,
} = require('~/server/services/ImageGeneration/apimartImg2InputStorage');

const DEFAULT_RESOURCE_KEY = 'apimart:test-key:gpt-image-2';
const WORKER_MODELS = ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'];
const APIMART_IMG2_ASYNC_VERSION = 2;
const DEFAULT_JOB_LEASE_MS = 30_000;
const DEFAULT_PROVIDER_LEASE_MS = 120_000;
const DEFAULT_RETRY_POLL_DELAY_MS = 30_000;
const DEFAULT_FINAL_OBSERVATION_MS = 30 * 60 * 1000;
const JOB_STATUSES = [
  'waiting',
  'submitting',
  'submitted',
  'polling',
  'succeeded',
  'failed',
  'status_unknown',
  'cancelled',
];
const CLAIMABLE_JOB_STATUSES = ['waiting', 'submitting', 'submitted', 'polling'];
const CLAIM_STATUS_PRIORITY = new Map([
  ['submitted', 0],
  ['polling', 0],
  ['submitting', 1],
  ['waiting', 2],
]);
const ACTIVE_PROVIDER_JOB_STATUSES = ['submitting', 'submitted', 'polling', 'status_unknown'];

function getShortHash(value) {
  if (!value) {
    return null;
  }
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function maskTaskId(value) {
  if (!value) {
    return null;
  }
  const text = String(value);
  if (text.length <= 8) {
    return `${text.slice(0, 2)}***${text.slice(-2)}`;
  }
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function toTime(value) {
  return value ? new Date(value).getTime() : null;
}

function getDurationMs(start, end = new Date()) {
  const startMs = toTime(start);
  if (!startMs) {
    return null;
  }
  return Math.max(0, end.getTime() - startMs);
}

function normalizeProviderStatus(status) {
  return String(status || '')
    .trim()
    .toLowerCase();
}

function getProviderErrorCode(error) {
  return (
    error?.providerErrorCode ||
    error?.providerCode ||
    error?.code ||
    error?.responseBody?.error?.code ||
    error?.responseBody?.code ||
    error?.responseBody?.data?.code ||
    null
  );
}

function getProviderErrorCategory(error) {
  const code = String(getProviderErrorCode(error) || '').toLowerCase();
  if (code === '17419' || code.includes('no_image')) {
    return 'terminal_no_image';
  }
  if (
    error?.code === 'IMAGE_GENERATION_TIMEOUT' ||
    error?.code === 'APIMART_IMAGE_SUBMIT_TIMEOUT' ||
    code.includes('timeout')
  ) {
    return 'timeout';
  }
  return code ? 'provider_error' : null;
}

function hasValidImageResult(result) {
  if (result?.resultUrl) {
    return true;
  }
  return (
    Array.isArray(result?.images) &&
    result.images.some((image) => Boolean(image?.url || image?.buffer))
  );
}

function isTerminalProviderFailure(error) {
  const providerStatus = normalizeProviderStatus(error?.providerStatus);
  const code = String(getProviderErrorCode(error) || '').toLowerCase();
  if (code === '17419' || code.includes('no_image')) {
    return true;
  }
  return (
    [
      'completed',
      'complete',
      'success',
      'succeeded',
      'failed',
      'failure',
      'error',
      'cancelled',
      'canceled',
    ].includes(providerStatus) && Boolean(code || error?.safeMessage || error?.message)
  );
}

function isProviderStillProcessing(error) {
  const providerStatus = normalizeProviderStatus(error?.providerStatus);
  if (
    ['in_progress', 'processing', 'running', 'pending', 'queued', 'submitted'].includes(
      providerStatus,
    )
  ) {
    return true;
  }
  return error?.code === 'IMAGE_GENERATION_TIMEOUT' && providerStatus !== 'completed';
}

function hasExceededFinalObservation(job, now = new Date()) {
  const acceptedAt = job?.providerAcceptedAt || job?.providerStartedAt || job?.queueEnteredAt;
  const acceptedMs = toTime(acceptedAt);
  return Boolean(acceptedMs && now.getTime() - acceptedMs >= DEFAULT_FINAL_OBSERVATION_MS);
}

// A local submit timeout cannot prove the provider outcome. Keep the job unknown
// and unclaimable, while releasing local capacity when there is no task to poll.
function getUnknownSubmissionCapacityAudit(now) {
  return {
    providerOutcomeUnknown: true,
    manualReviewRequired: true,
    neverResubmit: true,
    localCapacityReleasedAt: now,
    localCapacityReleaseReason: 'status_unknown_without_provider_task_id',
  };
}

function getSafeJobLog(job, extra = {}) {
  const now = extra.now || new Date();
  return {
    requestId: job.requestId || job.internalTaskId,
    internalTaskId: job.internalTaskId,
    frontendTaskId: job.frontendTaskId || null,
    batchTaskId: job.batchTaskId || null,
    itemId: job.itemId || null,
    userHash: getShortHash(job.userId),
    workerId: extra.workerId || null,
    permitOwner: extra.permitOwner || null,
    businessType: job.businessType || null,
    taskType: job.taskType || null,
    provider: job.provider || 'apimart',
    model: job.model || 'gpt-image-2',
    modelKey: job.modelKey || null,
    asyncVersion: job.asyncVersion || null,
    rolloutMode: job.rolloutMode || null,
    apiKeyFingerprint: job.apiKeyFingerprint || null,
    queueEnteredAt: job.queueEnteredAt || null,
    providerStartedAt: extra.providerStartedAt || job.providerStartedAt || null,
    providerAcceptedAt: extra.providerAcceptedAt || job.providerAcceptedAt || null,
    providerFinishedAt: extra.providerFinishedAt || job.providerFinishedAt || null,
    providerTaskIdMasked: maskTaskId(extra.providerTaskId || job.providerTaskId),
    queueWaitMs:
      extra.providerStartedAt || job.providerStartedAt
        ? getDurationMs(
            job.queueEnteredAt,
            new Date(extra.providerStartedAt || job.providerStartedAt),
          )
        : null,
    providerDurationMs:
      extra.providerStartedAt || job.providerStartedAt
        ? getDurationMs(extra.providerStartedAt || job.providerStartedAt, now)
        : null,
    totalDurationMs: getDurationMs(job.queueEnteredAt || job.createdAt, now),
    currentConcurrency: extra.currentConcurrency ?? null,
    httpStatus: extra.httpStatus ?? null,
    providerStatus: extra.providerStatus || job.providerStatus || null,
    providerErrorCode: extra.providerErrorCode || job.providerErrorCode || null,
    providerErrorCategory: extra.providerErrorCategory || job.providerErrorCategory || null,
    pollCount: extra.pollCount ?? job.pollCount ?? null,
    errorCode: extra.errorCode || null,
    submittedToProvider: extra.submittedToProvider ?? Boolean(job.submittedToProvider),
    finalStatus: extra.finalStatus || job.status || null,
    lateResponse: Boolean(extra.lateResponse),
  };
}

function createInMemoryAPIMartImg2JobStore({
  maxConcurrency = 1,
  now = () => new Date(),
  rolloutModes,
} = {}) {
  const jobs = new Map();
  const providerPermits = new Map();
  const allowedRolloutModes = Array.isArray(rolloutModes) ? new Set(rolloutModes) : null;

  function pruneExpiredPermits(current = now()) {
    for (const [leaseId, permit] of providerPermits.entries()) {
      if (permit.leaseExpiresAt <= current) {
        providerPermits.delete(leaseId);
      }
    }
  }

  async function createJob(input) {
    const createdAt = now();
    const job = {
      ...input,
      status: input.status || 'waiting',
      provider: input.provider || 'apimart',
      model: input.model || 'gpt-image-2',
      resourceKey: input.resourceKey || DEFAULT_RESOURCE_KEY,
      asyncVersion: input.asyncVersion ?? APIMART_IMG2_ASYNC_VERSION,
      rolloutMode: input.rolloutMode || 'canary',
      workerEligible: input.workerEligible ?? true,
      submittedToProvider: Boolean(input.submittedToProvider),
      usageRecorded: Boolean(input.usageRecorded),
      pollCount: input.pollCount || 0,
      queueEnteredAt: input.queueEnteredAt || createdAt,
      createdAt,
      updatedAt: createdAt,
      workerOwner: null,
      workerLeaseUntil: null,
      result: null,
      error: null,
    };
    jobs.set(job.internalTaskId, job);
    return { ...job };
  }

  async function getJob(internalTaskId) {
    const job = jobs.get(internalTaskId);
    return job ? { ...job } : null;
  }

  async function claimNextWaitingJob({
    workerId,
    leaseMs = DEFAULT_JOB_LEASE_MS,
    statuses = ['waiting'],
    now: current,
  }) {
    const timestamp = current || now();
    const candidates = Array.from(jobs.values())
      .filter((job) => {
        if (!statuses.includes(job.status)) {
          return false;
        }
        if (job.asyncVersion !== APIMART_IMG2_ASYNC_VERSION || job.workerEligible !== true) {
          return false;
        }
        if (allowedRolloutModes && !allowedRolloutModes.has(job.rolloutMode)) {
          return false;
        }
        if (job.workerLeaseUntil && job.workerLeaseUntil > timestamp) {
          return false;
        }
        if (job.nextPollAt && job.nextPollAt > timestamp) {
          return false;
        }
        return true;
      })
      .sort((left, right) => {
        const leftPriority = CLAIM_STATUS_PRIORITY.get(left.status) ?? 99;
        const rightPriority = CLAIM_STATUS_PRIORITY.get(right.status) ?? 99;
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        const leftQueuedAt = toTime(left.queueEnteredAt || left.createdAt) || 0;
        const rightQueuedAt = toTime(right.queueEnteredAt || right.createdAt) || 0;
        return leftQueuedAt - rightQueuedAt;
      });

    for (const job of candidates) {
      job.workerOwner = workerId;
      job.workerLeaseUntil = new Date(timestamp.getTime() + leaseMs);
      job.updatedAt = timestamp;
      return { ...job };
    }
    return null;
  }

  async function releaseJobClaim({ internalTaskId, workerId }) {
    const job = jobs.get(internalTaskId);
    if (!job || job.workerOwner !== workerId) {
      return null;
    }
    job.workerOwner = null;
    job.workerLeaseUntil = null;
    job.updatedAt = now();
    return { ...job };
  }

  async function heartbeatJobClaim({ internalTaskId, workerId, leaseMs, now: current }) {
    const timestamp = current || now();
    const job = jobs.get(internalTaskId);
    if (
      !job ||
      job.workerOwner !== workerId ||
      (job.workerLeaseUntil && job.workerLeaseUntil <= timestamp) ||
      ['succeeded', 'failed', 'status_unknown', 'cancelled'].includes(job.status)
    ) {
      return null;
    }
    job.workerLeaseUntil = new Date(timestamp.getTime() + leaseMs);
    job.updatedAt = timestamp;
    return { ...job };
  }

  async function updateJob({ internalTaskId, workerId, updates }) {
    const job = jobs.get(internalTaskId);
    if (!job || (workerId && job.workerOwner !== workerId)) {
      return null;
    }
    Object.assign(job, updates, { updatedAt: now() });
    return { ...job };
  }

  async function updateUsageDelivery({ internalTaskId, revision, state }) {
    const job = jobs.get(internalTaskId);
    if (
      !job ||
      job.usageDelivery?.revision !== revision ||
      (job.usageDelivery.state === 'persisted' && state !== 'persisted') ||
      (state === 'pending' && job.usageDelivery.state !== 'pending')
    )
      return null;
    job.usageDelivery = { ...job.usageDelivery, state };
    job.usageRecorded = state === 'persisted';
    return { ...job };
  }

  async function acquireProviderPermit({
    resourceKey = DEFAULT_RESOURCE_KEY,
    ownerId,
    internalTaskId,
    providerTaskId,
    leaseMs = DEFAULT_PROVIDER_LEASE_MS,
    now: current,
  }) {
    const timestamp = current || now();
    pruneExpiredPermits(timestamp);
    if (
      Array.from(jobs.values()).some(
        (job) =>
          job.internalTaskId !== internalTaskId &&
          job.resourceKey === resourceKey &&
          job.asyncVersion === APIMART_IMG2_ASYNC_VERSION &&
          job.workerEligible === true &&
          ACTIVE_PROVIDER_JOB_STATUSES.includes(job.status) &&
          (job.status === 'submitting' || (job.submittedToProvider === true && job.providerTaskId)),
      )
    ) {
      return null;
    }
    const active = Array.from(providerPermits.values()).filter(
      (permit) => permit.resourceKey === resourceKey,
    );
    const existingTaskPermit = active.find((permit) => permit.internalTaskId === internalTaskId);
    if (existingTaskPermit) {
      existingTaskPermit.ownerId = ownerId;
      existingTaskPermit.providerTaskId =
        providerTaskId || existingTaskPermit.providerTaskId || null;
      existingTaskPermit.heartbeatAt = timestamp;
      existingTaskPermit.leaseExpiresAt = new Date(timestamp.getTime() + leaseMs);
      return { ...existingTaskPermit };
    }
    if (active.length >= maxConcurrency) {
      return null;
    }
    const leaseId = `${resourceKey}:${ownerId}:${internalTaskId}`;
    const permit = {
      leaseId,
      resourceKey,
      ownerId,
      internalTaskId,
      providerTaskId: providerTaskId || null,
      leaseExpiresAt: new Date(timestamp.getTime() + leaseMs),
      heartbeatAt: timestamp,
    };
    providerPermits.set(leaseId, permit);
    return { ...permit };
  }

  async function heartbeatProviderPermit({
    leaseId,
    ownerId,
    internalTaskId,
    providerTaskId,
    leaseMs = DEFAULT_PROVIDER_LEASE_MS,
    now: current,
  }) {
    const timestamp = current || now();
    const permit = providerPermits.get(leaseId);
    if (
      !permit ||
      permit.ownerId !== ownerId ||
      permit.internalTaskId !== internalTaskId ||
      permit.leaseExpiresAt <= timestamp
    ) {
      return null;
    }
    permit.heartbeatAt = timestamp;
    permit.leaseExpiresAt = new Date(timestamp.getTime() + leaseMs);
    if (providerTaskId) {
      permit.providerTaskId = providerTaskId;
    }
    return { ...permit };
  }

  async function releaseProviderPermit({ leaseId, ownerId, internalTaskId }) {
    const permit = providerPermits.get(leaseId);
    if (
      !permit ||
      permit.ownerId !== ownerId ||
      (internalTaskId && permit.internalTaskId !== internalTaskId)
    ) {
      return false;
    }
    providerPermits.delete(leaseId);
    return true;
  }

  async function getCurrentConcurrency(resourceKey = DEFAULT_RESOURCE_KEY) {
    pruneExpiredPermits();
    return Array.from(providerPermits.values()).filter(
      (permit) => permit.resourceKey === resourceKey,
    ).length;
  }

  return {
    createJob,
    getJob,
    claimNextWaitingJob,
    heartbeatJobClaim,
    releaseJobClaim,
    updateJob,
    updateUsageDelivery,
    acquireProviderPermit,
    heartbeatProviderPermit,
    releaseProviderPermit,
    getCurrentConcurrency,
  };
}

function createAPIMartImg2JobWorker({
  workerId,
  maxConcurrency = 1,
  store,
  provider,
  recordUsage,
  prepareUsage,
  admitUsage,
  resolveJobPayload = resolveAPIMartImg2JobPayload,
  cleanupJobPayload = cleanupAPIMartImg2JobInputRefs,
  jobLeaseMs = DEFAULT_JOB_LEASE_MS,
  providerLeaseMs = DEFAULT_PROVIDER_LEASE_MS,
  heartbeatIntervalMs,
} = {}) {
  if (!workerId) {
    throw new Error('APIMart img2 worker requires workerId');
  }

  const resolvedHeartbeatIntervalMs =
    heartbeatIntervalMs ?? Math.max(1000, Math.floor(Math.min(jobLeaseMs, providerLeaseMs) / 3));

  function startLeaseHeartbeat(job, permit, claimOwner) {
    if (
      !Number.isFinite(resolvedHeartbeatIntervalMs) ||
      resolvedHeartbeatIntervalMs <= 0 ||
      (typeof store.heartbeatJobClaim !== 'function' &&
        typeof store.heartbeatProviderPermit !== 'function')
    ) {
      return () => {};
    }

    const timer = setInterval(() => {
      void (async () => {
        try {
          if (typeof store.heartbeatJobClaim === 'function') {
            await store.heartbeatJobClaim({
              internalTaskId: job.internalTaskId,
              workerId: claimOwner,
              leaseMs: jobLeaseMs,
            });
          }
          if (typeof store.heartbeatProviderPermit === 'function') {
            await store.heartbeatProviderPermit({
              leaseId: permit.leaseId,
              ownerId: claimOwner,
              internalTaskId: job.internalTaskId,
              providerTaskId: job.providerTaskId || permit.providerTaskId || undefined,
              leaseMs: providerLeaseMs,
            });
          }
        } catch {
          // A missed heartbeat is recovered by owner checks and lease expiry.
        }
      })();
    }, resolvedHeartbeatIntervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    return () => clearInterval(timer);
  }
  if (!store) {
    throw new Error('APIMart img2 worker requires store');
  }
  if (!provider || typeof provider.generate !== 'function') {
    throw new Error('APIMart img2 worker requires provider.generate');
  }

  function imageUsageInput(job, { status, result, providerTaskId, startedAt }) {
    const imageCount = Array.isArray(result?.images)
      ? result.images.length
      : Number(Boolean(result?.resultUrl));
    const metadata = getImageProviderBillingMetadata(job.provider, result);
    const finishedAt = job.providerFinishedAt || job.statusUnknownAt;
    return {
      userId: job.userId,
      tenantId: job.tenantId,
      requestId: job.requestId || job.internalTaskId,
      batchId: job.batchTaskId,
      itemId: job.itemId,
      provider: job.provider,
      model: job.model,
      modelKey: job.modelKey,
      taskType: job.taskType,
      businessType: job.businessType,
      status,
      imageCount,
      providerTaskId,
      durationMs:
        startedAt && finishedAt ? new Date(finishedAt).getTime() - startedAt.getTime() : undefined,
      usageContext: job.usageContext,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
  }

  function pendingUsage(job, input) {
    const previous = job.usageDelivery;
    let revision = input.status === 'submitted' ? 0 : 1;
    if (previous && input.status !== 'submitted') {
      revision =
        previous.envelope?.event?.status === input.status
          ? previous.revision
          : Math.max(1, previous.revision + 1);
    }
    const envelope =
      typeof prepareUsage === 'function' ? prepareUsage({ ...input, revision }) : undefined;
    return { state: 'pending', revision, ...(envelope ? { envelope } : {}) };
  }

  async function deliverUsage(job, input) {
    if (typeof recordUsage !== 'function') return;
    try {
      const result = await recordUsage({ ...input, envelope: job.usageDelivery?.envelope });
      let state = 'pending';
      if (result?.ledgerPersisted === true) state = 'persisted';
      else if (result?.durableAccepted === true) state = 'durable';
      await store.updateUsageDelivery?.({
        internalTaskId: job.internalTaskId,
        revision: job.usageDelivery.revision,
        state,
      });
    } catch {
      // The source envelope already exists. Accounting failure must not enter provider failure/retry handling.
      logger.warn('[UsageDelivery] Image ledger capture remains pending');
    }
  }

  async function recordSubmittedUsageOnce(job, providerTaskId) {
    const latest = await store.getJob(job.internalTaskId);
    if (
      !latest ||
      !['submitting', 'submitted', 'polling'].includes(latest.status) ||
      ['durable', 'persisted'].includes(latest.usageDelivery?.state) ||
      typeof recordUsage !== 'function'
    )
      return;
    const input = imageUsageInput(latest, { status: 'submitted', providerTaskId });
    const updated = await store.updateJob({
      internalTaskId: job.internalTaskId,
      workerId,
      updates: { usageRecorded: false, usageDelivery: pendingUsage(latest, input) },
    });
    if (updated) await deliverUsage(updated, input);
  }

  async function recordFinalUsage(job, options) {
    await deliverUsage(job, imageUsageInput(job, options));
  }

  async function readCurrentConcurrency(resourceKey) {
    if (typeof store.getCurrentConcurrency !== 'function') {
      return null;
    }
    try {
      return await store.getCurrentConcurrency(resourceKey);
    } catch {
      return null;
    }
  }

  async function safelyCleanupJobPayload(job) {
    if (!job || typeof cleanupJobPayload !== 'function') {
      return;
    }
    try {
      await cleanupJobPayload(job);
    } catch (error) {
      logger.warn('[ImageGeneration] APIMart img2 staged input cleanup failed', {
        requestId: job.requestId || job.internalTaskId,
        internalTaskId: job.internalTaskId,
        errorCode: error?.code || error?.statusCode || 'APIMART_IMG2_INPUT_CLEANUP_FAILED',
      });
    }
  }

  let activeRuns = 0;

  async function runOnce() {
    if (activeRuns >= maxConcurrency) {
      return null;
    }
    activeRuns += 1;
    try {
      return await runOnceInternal(maxConcurrency > 1 ? `${workerId}-${randomUUID()}` : workerId);
    } finally {
      activeRuns -= 1;
    }
  }

  async function runOnceInternal(workerId) {
    const job = await store.claimNextWaitingJob({
      workerId,
      leaseMs: jobLeaseMs,
      statuses: CLAIMABLE_JOB_STATUSES,
    });
    if (!job) {
      return null;
    }

    if (job.status !== 'waiting' && !job.providerTaskId) {
      const providerStartedAt = job.providerStartedAt
        ? new Date(job.providerStartedAt)
        : new Date();
      const updated = await store.updateJob({
        internalTaskId: job.internalTaskId,
        workerId,
        updates: {
          status: 'status_unknown',
          submittedToProvider: true,
          providerTaskId: null,
          statusUnknownAt: new Date(),
          ...getUnknownSubmissionCapacityAudit(new Date()),
          errorCode: 'APIMART_IMG2_SUBMIT_RECOVERY_UNKNOWN',
          error:
            'APIMart img2 submit state is unknown after worker recovery. Confirm before retrying to avoid duplicate charges.',
          workerOwner: null,
          workerLeaseUntil: null,
        },
      });
      if (updated) {
        await recordFinalUsage(
          {
            ...job,
            status: 'status_unknown',
            submittedToProvider: true,
          },
          {
            status: 'status_unknown',
            result: null,
            providerTaskId: null,
            startedAt: providerStartedAt,
          },
        );
        logger.warn('[ImageGeneration] APIMart img2 stale submit marked status_unknown', {
          ...getSafeJobLog(
            {
              ...job,
              status: 'status_unknown',
              submittedToProvider: true,
            },
            {
              workerId,
              providerStartedAt,
              errorCode: 'APIMART_IMG2_SUBMIT_RECOVERY_UNKNOWN',
              submittedToProvider: true,
              finalStatus: 'status_unknown',
            },
          ),
        });
      }
      return null;
    }

    const permit = await store.acquireProviderPermit({
      resourceKey: job.resourceKey || DEFAULT_RESOURCE_KEY,
      ownerId: workerId,
      internalTaskId: job.internalTaskId,
      providerTaskId: job.providerTaskId || undefined,
      leaseMs: providerLeaseMs,
    });
    if (!permit) {
      logger.info('[ImageGeneration] APIMart img2 provider permit unavailable', {
        ...getSafeJobLog(job, {
          workerId,
          currentConcurrency: await readCurrentConcurrency(job.resourceKey || DEFAULT_RESOURCE_KEY),
          finalStatus: 'waiting',
        }),
      });
      await store.releaseJobClaim({ internalTaskId: job.internalTaskId, workerId });
      return null;
    }

    const timing = createAPIMartImageTiming({
      taskId: job.internalTaskId,
      model: job.model,
      log: (message) => logger.info(message),
    });
    const stopHeartbeat = startLeaseHeartbeat(job, permit, workerId);
    const providerStartedAt = job.providerStartedAt ? new Date(job.providerStartedAt) : new Date();
    let latestProviderTaskId = job.providerTaskId || permit.providerTaskId || null;
    let shouldReleaseProviderPermit = true;
    let providerPermitLeaseMsOnExit = providerLeaseMs;
    let cleanupAfterTerminal = null;

    async function keepProviderPermit(leaseMs, providerTaskId = latestProviderTaskId) {
      shouldReleaseProviderPermit = false;
      providerPermitLeaseMsOnExit = Math.max(providerLeaseMs, leaseMs || providerLeaseMs);
      if (providerTaskId) {
        latestProviderTaskId = providerTaskId;
      }
    }

    async function heartbeatProviderPermitNow(leaseMs = providerLeaseMs) {
      if (typeof store.heartbeatProviderPermit !== 'function') {
        return null;
      }
      return store.heartbeatProviderPermit({
        leaseId: permit.leaseId,
        ownerId: workerId,
        internalTaskId: job.internalTaskId,
        providerTaskId: latestProviderTaskId || undefined,
        leaseMs,
      });
    }

    try {
      const currentConcurrency = await readCurrentConcurrency(
        job.resourceKey || DEFAULT_RESOURCE_KEY,
      );
      logger.info('[ImageGeneration] APIMart img2 provider permit acquired', {
        ...getSafeJobLog(job, {
          workerId,
          permitOwner: workerId,
          providerStartedAt,
          currentConcurrency,
          finalStatus: 'submitting',
        }),
      });

      const providerCallbacks = {
        onProviderStatusChanged: async ({ providerTaskId, providerStatus } = {}) => {
          if (providerTaskId) {
            latestProviderTaskId = providerTaskId;
          }
          await store.updateJob({
            internalTaskId: job.internalTaskId,
            workerId,
            updates: {
              status: 'polling',
              submittedToProvider: true,
              providerTaskId: providerTaskId || job.providerTaskId || null,
              providerStatus: providerStatus || 'IN_PROGRESS',
              nextPollAt: null,
            },
          });
          await heartbeatProviderPermitNow();
        },
        onProviderPoll: async ({ providerTaskId, providerStatus } = {}) => {
          if (providerTaskId) {
            latestProviderTaskId = providerTaskId;
          }
          const current = await store.getJob(job.internalTaskId);
          await store.updateJob({
            internalTaskId: job.internalTaskId,
            workerId,
            updates: {
              status: 'polling',
              submittedToProvider: true,
              providerTaskId: providerTaskId || job.providerTaskId || null,
              providerStatus: providerStatus || 'IN_PROGRESS',
              pollCount: Number(current?.pollCount || 0) + 1,
              lastPolledAt: new Date(),
              nextPollAt: null,
            },
          });
          await heartbeatProviderPermitNow();
        },
      };

      let result;
      if (job.status === 'waiting') {
        const usageContext =
          typeof admitUsage === 'function' ? await admitUsage(job) : job.usageContext;
        job.usageContext = usageContext;
        const submitting = await store.updateJob({
          internalTaskId: job.internalTaskId,
          workerId,
          updates: { status: 'submitting', providerStartedAt, usageContext },
        });
        if (!submitting) return null;
        const providerPayload =
          typeof resolveJobPayload === 'function'
            ? await timing.measure(
                'reference_prepare',
                () => resolveJobPayload({ ...job, timing }),
                {
                  imageCount:
                    job.payload?.imageInputRefs?.length || job.payload?.imageInputs?.length || 0,
                },
              )
            : job.payload;
        result = await provider.generate({
          ...providerPayload,
          internalTaskId: job.internalTaskId,
          requestId: job.requestId,
          businessType: job.businessType,
          taskType: job.taskType,
          model: job.model,
          modelKey: job.modelKey,
          ...providerCallbacks,
          onProviderTaskSubmitted: async ({ providerTaskId, providerStatus } = {}) => {
            if (providerTaskId) {
              latestProviderTaskId = providerTaskId;
            }
            const providerAcceptedAt = new Date();
            const updated = await store.updateJob({
              internalTaskId: job.internalTaskId,
              workerId,
              updates: {
                status: 'polling',
                submittedToProvider: true,
                providerTaskId: providerTaskId || null,
                providerStatus: providerStatus || 'IN_PROGRESS',
                providerAcceptedAt,
                nextPollAt: null,
              },
            });
            if (!updated) {
              logger.warn('[ImageGeneration] APIMart img2 provider accepted after stale lease', {
                ...getSafeJobLog(job, {
                  workerId,
                  permitOwner: workerId,
                  providerStartedAt,
                  providerAcceptedAt,
                  providerTaskId,
                  submittedToProvider: true,
                  finalStatus: 'polling',
                  lateResponse: true,
                }),
              });
              return;
            }
            await heartbeatProviderPermitNow();
            await recordSubmittedUsageOnce(updated, providerTaskId || null);
            logger.info('[ImageGeneration] APIMart img2 provider accepted', {
              ...getSafeJobLog(updated, {
                workerId,
                permitOwner: workerId,
                providerStartedAt,
                providerAcceptedAt,
                providerTaskId,
                currentConcurrency: await readCurrentConcurrency(
                  job.resourceKey || DEFAULT_RESOURCE_KEY,
                ),
                submittedToProvider: true,
                finalStatus: 'polling',
              }),
            });
          },
        });
      } else {
        if (!provider || typeof provider.resume !== 'function') {
          const error = new Error('APIMart img2 provider resume is not available');
          error.code = 'APIMART_IMG2_RESUME_UNAVAILABLE';
          error.statusCode = 504;
          error.providerTaskId = job.providerTaskId;
          throw error;
        }
        await store.updateJob({
          internalTaskId: job.internalTaskId,
          workerId,
          updates: {
            status: 'polling',
            submittedToProvider: true,
            providerTaskId: job.providerTaskId,
            providerStatus: job.providerStatus || 'IN_PROGRESS',
            nextPollAt: null,
          },
        });
        if (job.nextPollAt && job.lastPolledAt) {
          timing.record('recovery_wait', 'resumed', Date.now() - toTime(job.lastPolledAt), {
            scheduledDelayMs: toTime(job.nextPollAt) - toTime(job.lastPolledAt),
          });
        }
        result = await provider.resume({
          ...job.payload,
          internalTaskId: job.internalTaskId,
          requestId: job.requestId,
          businessType: job.businessType,
          taskType: job.taskType,
          model: job.model,
          modelKey: job.modelKey,
          providerTaskId: job.providerTaskId,
          ...providerCallbacks,
        });
      }

      const latest = await store.getJob(job.internalTaskId);
      const providerTaskId = result?.taskId || latest?.providerTaskId || job.providerTaskId || null;
      if (providerTaskId) {
        latestProviderTaskId = providerTaskId;
      }
      if (!hasValidImageResult(result)) {
        const error = new Error('APIMart img2 completed without a valid image');
        error.code = 'APIMART_IMG2_NO_VALID_IMAGE';
        error.providerErrorCode =
          result?.errorCode || result?.code || 'APIMART_IMG2_NO_VALID_IMAGE';
        error.providerStatus = result?.status || latest?.providerStatus || 'completed';
        error.providerTaskId = providerTaskId;
        throw error;
      }
      const providerFinishedAt = new Date();
      const updated = await store.updateJob({
        internalTaskId: job.internalTaskId,
        workerId,
        updates: {
          status: 'succeeded',
          usageRecorded: false,
          usageDelivery: pendingUsage(
            latest || job,
            imageUsageInput(
              { ...job, providerFinishedAt },
              { status: 'succeeded', result, providerTaskId, startedAt: providerStartedAt },
            ),
          ),
          submittedToProvider: true,
          providerTaskId,
          providerStatus: result?.status || latest?.providerStatus || 'succeeded',
          providerFinishedAt,
          result,
          workerOwner: null,
          workerLeaseUntil: null,
        },
      });
      if (!updated) {
        logger.warn('[ImageGeneration] APIMart img2 success ignored after stale lease', {
          ...getSafeJobLog(
            {
              ...job,
              providerTaskId,
              submittedToProvider: true,
              status: 'succeeded',
            },
            {
              workerId,
              permitOwner: workerId,
              providerStartedAt,
              providerFinishedAt,
              providerTaskId,
              submittedToProvider: true,
              finalStatus: 'succeeded',
              lateResponse: true,
            },
          ),
        });
        return null;
      }

      cleanupAfterTerminal = updated;
      await recordFinalUsage(updated, {
        status: 'succeeded',
        result,
        providerTaskId,
        startedAt: providerStartedAt,
      });
      logger.info('[ImageGeneration] APIMart img2 internal job succeeded', {
        ...getSafeJobLog(updated, {
          workerId,
          permitOwner: workerId,
          providerStartedAt,
          providerFinishedAt,
          providerTaskId,
          currentConcurrency: await readCurrentConcurrency(job.resourceKey || DEFAULT_RESOURCE_KEY),
          submittedToProvider: true,
          finalStatus: 'succeeded',
        }),
      });
      return result;
    } catch (error) {
      const latest = await store.getJob(job.internalTaskId);
      const providerTaskId =
        error?.providerTaskId || latest?.providerTaskId || job.providerTaskId || null;
      if (providerTaskId) {
        latestProviderTaskId = providerTaskId;
      }
      const providerStatus =
        error?.providerStatus || latest?.providerStatus || (providerTaskId ? 'IN_PROGRESS' : null);
      const providerErrorCode = getProviderErrorCode(error);
      const providerErrorCategory = getProviderErrorCategory(error);
      const acceptanceUnknown =
        error?.code === 'IMAGE_GENERATION_TIMEOUT' ||
        error?.code === 'APIMART_IMAGE_SUBMIT_TIMEOUT';
      const submittedToProvider = Boolean(
        latest?.submittedToProvider || providerTaskId || acceptanceUnknown,
      );
      const terminalProviderFailure = isTerminalProviderFailure({
        ...error,
        providerStatus,
        providerErrorCode,
      });
      const shouldKeepPolling =
        providerTaskId &&
        submittedToProvider &&
        !terminalProviderFailure &&
        isProviderStillProcessing({ ...error, providerStatus }) &&
        !hasExceededFinalObservation(latest || job);
      const isUnknownAfterSubmit =
        !terminalProviderFailure &&
        !shouldKeepPolling &&
        (submittedToProvider ||
          error?.code === 'IMAGE_GENERATION_TIMEOUT' ||
          error?.code === 'APIMART_IMAGE_SUBMIT_TIMEOUT');
      let finalStatus = 'status_unknown';
      if (shouldKeepPolling) {
        finalStatus = 'polling';
      } else if (terminalProviderFailure || !isUnknownAfterSubmit) {
        finalStatus = 'failed';
      }
      logger.warn('[ImageGeneration] APIMart img2 internal job finished without success', {
        ...getSafeJobLog(
          {
            ...job,
            providerTaskId,
            providerStatus,
            providerErrorCode,
            providerErrorCategory,
            submittedToProvider,
            status: finalStatus,
          },
          {
            workerId,
            permitOwner: workerId,
            providerStartedAt,
            providerTaskId,
            currentConcurrency: await readCurrentConcurrency(
              job.resourceKey || DEFAULT_RESOURCE_KEY,
            ),
            httpStatus: error?.statusCode || null,
            errorCode: error?.code || error?.statusCode || 'APIMART_IMG2_JOB_FAILED',
            providerStatus,
            providerErrorCode,
            providerErrorCategory,
            submittedToProvider,
            finalStatus,
          },
        ),
      });
      const now = new Date();
      const nextPollDelayMs = shouldKeepPolling ? DEFAULT_RETRY_POLL_DELAY_MS : null;
      if (shouldKeepPolling) {
        await keepProviderPermit(
          (nextPollDelayMs || providerLeaseMs) + providerLeaseMs,
          providerTaskId,
        );
      } else if (finalStatus === 'status_unknown' && submittedToProvider && providerTaskId) {
        await keepProviderPermit(DEFAULT_FINAL_OBSERVATION_MS, providerTaskId);
      }
      const updated = await store.updateJob({
        internalTaskId: job.internalTaskId,
        workerId,
        updates: {
          status: finalStatus,
          ...(!shouldKeepPolling && (submittedToProvider || finalStatus === 'status_unknown')
            ? {
                usageRecorded: false,
                usageDelivery: pendingUsage(
                  latest || job,
                  imageUsageInput(
                    { ...job, providerFinishedAt: now },
                    {
                      status: finalStatus,
                      result: null,
                      providerTaskId,
                      startedAt: providerStartedAt,
                    },
                  ),
                ),
              }
            : {}),
          submittedToProvider,
          providerTaskId,
          providerStatus,
          providerErrorCode: providerErrorCode || undefined,
          providerErrorCategory: providerErrorCategory || undefined,
          lastPolledAt: shouldKeepPolling ? now : latest?.lastPolledAt,
          nextPollAt: shouldKeepPolling ? new Date(now.getTime() + nextPollDelayMs) : null,
          providerFinishedAt: finalStatus === 'failed' ? now : undefined,
          statusUnknownAt: finalStatus === 'status_unknown' ? now : undefined,
          ...(finalStatus === 'status_unknown' && !providerTaskId
            ? getUnknownSubmissionCapacityAudit(now)
            : {}),
          errorCode: error?.code || error?.statusCode || 'APIMART_IMG2_JOB_FAILED',
          error: error?.safeMessage || error?.message || 'APIMart img2 job failed',
          workerOwner: null,
          workerLeaseUntil: null,
        },
      });
      if (updated && shouldKeepPolling) {
        timing.record('recovery_wait', 'scheduled', nextPollDelayMs);
      }
      if (
        updated &&
        (finalStatus === 'status_unknown' || (finalStatus === 'failed' && submittedToProvider))
      ) {
        await recordFinalUsage(updated, {
          status: finalStatus,
          result: null,
          providerTaskId,
          startedAt: providerStartedAt,
        });
      }
      if (updated && finalStatus === 'failed') {
        cleanupAfterTerminal = updated;
      }
      return null;
    } finally {
      stopHeartbeat();
      if (shouldReleaseProviderPermit) {
        await store.releaseProviderPermit({
          leaseId: permit.leaseId,
          ownerId: workerId,
          internalTaskId: job.internalTaskId,
        });
      } else {
        await heartbeatProviderPermitNow(providerPermitLeaseMsOnExit);
      }
      if (cleanupAfterTerminal) {
        await safelyCleanupJobPayload(cleanupAfterTerminal);
      }
    }
  }

  return {
    runOnce,
  };
}

function createMongoAPIMartImg2JobStore({
  db,
  maxConcurrency = 1,
  now = () => new Date(),
  rolloutModes,
} = {}) {
  if (!db) {
    throw new Error('APIMart img2 Mongo job store requires db methods');
  }

  function normalizeProviderPermit(permit) {
    if (!permit) {
      return null;
    }
    const rawLeaseId = permit.leaseId || permit._id;
    const leaseId =
      typeof rawLeaseId === 'string' ? rawLeaseId : rawLeaseId?.toString?.() || rawLeaseId;
    return { ...permit, leaseId };
  }

  async function acquireMongoJobLeaseByPriority({ workerId, leaseMs }) {
    for (const statuses of [['submitted', 'polling'], ['submitting'], ['waiting']]) {
      const job = await db.acquireImageGenerationJobLease({
        models: WORKER_MODELS,
        workerId,
        leaseMs,
        statuses,
        rolloutModes,
        now: now(),
      });
      if (job) {
        return job;
      }
    }
    return null;
  }

  return {
    async getJob(internalTaskId) {
      return db.getImageGenerationJob({ internalTaskId, includeSensitive: true });
    },
    async claimNextWaitingJob({ workerId, leaseMs }) {
      return acquireMongoJobLeaseByPriority({ workerId, leaseMs });
    },
    async releaseJobClaim({ internalTaskId, workerId }) {
      return db.updateImageGenerationJobWithLease({
        internalTaskId,
        workerId,
        statuses: JOB_STATUSES,
        updates: {},
        releaseLease: true,
        now: now(),
      });
    },
    async heartbeatJobClaim({ internalTaskId, workerId, leaseMs }) {
      return db.updateImageGenerationJobWithLease({
        internalTaskId,
        workerId,
        statuses: JOB_STATUSES,
        allowExpiredLease: true,
        updates: { workerLeaseUntil: new Date(now().getTime() + leaseMs) },
        now: now(),
      });
    },
    async updateJob({ internalTaskId, workerId, updates }) {
      return db.updateImageGenerationJobWithLease({
        internalTaskId,
        workerId,
        statuses: JOB_STATUSES,
        allowExpiredLease: true,
        updates,
        now: now(),
      });
    },
    async updateUsageDelivery({ internalTaskId, revision, state }) {
      return db.updateImageGenerationJobUsageDelivery({ internalTaskId, revision, state });
    },
    async acquireProviderPermit({ resourceKey, ownerId, internalTaskId, providerTaskId, leaseMs }) {
      const countActiveProviderTasks = async () => {
        if (typeof db.countActiveImageGenerationProviderTasks !== 'function') {
          return 0;
        }
        return db.countActiveImageGenerationProviderTasks({
          models: WORKER_MODELS,
          resourceKey,
          excludeInternalTaskId: internalTaskId,
        });
      };

      const releaseOwnedPermit = async (permit) => {
        if (!permit?.leaseId) {
          return;
        }
        await db.releaseImageProviderConcurrencyLease({
          leaseId: permit.leaseId,
          ownerId,
          internalTaskId,
        });
      };

      if (typeof db.countActiveImageGenerationProviderTasks === 'function') {
        const activeProviderTasks = await countActiveProviderTasks();
        if (activeProviderTasks >= maxConcurrency) {
          return null;
        }
      }

      const permit = normalizeProviderPermit(
        await db.acquireImageProviderConcurrencyLease({
          resourceKey,
          ownerId,
          internalTaskId,
          providerTaskId,
          maxConcurrency,
          leaseMs,
          now: now(),
        }),
      );

      if (!permit) {
        return null;
      }

      try {
        const reservations = await db.listActiveImageProviderConcurrencyLeases({
          resourceKey,
          now: now(),
        });
        const reservedTaskIds = [...new Set(reservations.map((entry) => entry.internalTaskId))];
        const unmatchedActiveTasks = await db.countActiveImageGenerationProviderTasks({
          models: WORKER_MODELS,
          resourceKey,
          excludeInternalTaskIds: reservedTaskIds,
        });
        if (
          !reservedTaskIds.includes(internalTaskId) ||
          reservedTaskIds.length + unmatchedActiveTasks > maxConcurrency
        ) {
          await releaseOwnedPermit(permit);
          return null;
        }
      } catch (error) {
        await releaseOwnedPermit(permit);
        throw error;
      }

      return permit;
    },
    async heartbeatProviderPermit({ leaseId, ownerId, internalTaskId, providerTaskId, leaseMs }) {
      return normalizeProviderPermit(
        await db.heartbeatImageProviderConcurrencyLease({
          leaseId,
          ownerId,
          internalTaskId,
          providerTaskId,
          leaseMs,
          now: now(),
        }),
      );
    },
    async releaseProviderPermit({ leaseId, ownerId, internalTaskId }) {
      return db.releaseImageProviderConcurrencyLease({ leaseId, ownerId, internalTaskId });
    },
    async getCurrentConcurrency(resourceKey) {
      return db.countActiveImageProviderConcurrencyLeases({ resourceKey, now: now() });
    },
  };
}

function createAPIMartImg2ProviderAdapter({ generateAPIMartImage, resumeAPIMartImage }) {
  if (typeof generateAPIMartImage !== 'function') {
    throw new Error('APIMart img2 provider adapter requires generateAPIMartImage');
  }
  return {
    generate(request) {
      return generateAPIMartImage(request);
    },
    resume(request) {
      if (typeof resumeAPIMartImage !== 'function') {
        const error = new Error('APIMart img2 provider adapter requires resumeAPIMartImage');
        error.code = 'APIMART_IMG2_RESUME_UNAVAILABLE';
        error.statusCode = 504;
        throw error;
      }
      return resumeAPIMartImage(request);
    },
  };
}

module.exports = {
  DEFAULT_PROVIDER_LEASE_MS,
  DEFAULT_RESOURCE_KEY,
  CLAIMABLE_JOB_STATUSES,
  JOB_STATUSES,
  createAPIMartImg2JobWorker,
  createAPIMartImg2ProviderAdapter,
  createInMemoryAPIMartImg2JobStore,
  createMongoAPIMartImg2JobStore,
};
