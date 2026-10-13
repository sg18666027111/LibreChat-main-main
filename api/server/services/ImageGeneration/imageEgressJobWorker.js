const { logger } = require('@librechat/data-schemas');
const {
  IMAGE_EGRESS_RETRY_POLICIES,
  getImageEgressNextAttemptAt,
  runImageEgressTurnRetry,
} = require('./imageEgressRetry');

const IMAGE_EGRESS_WORKER_FAMILY = 'image-egress-v1';
const DEFAULT_JOB_LEASE_MS = 120_000;
const DEFAULT_SLOT_LEASE_MS = 120_000;
const DEFAULT_JOB_DEADLINE_MS = 30 * 60 * 1000;
const DEFAULT_POLL_DELAY_MS = 3000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 90_000;
const DEFAULT_INPUT_PREPARE_TIMEOUT_MS = 180_000;
const DEFAULT_OUTPUT_STORAGE_TIMEOUT_MS = 90_000;
const OPERATION_DEADLINE_MS = Object.freeze({
  input_read: 5 * 60 * 1000,
  status_read: 15 * 60 * 1000,
  result_read: 3 * 60 * 1000,
  output_download: 5 * 60 * 1000,
});
const CLAIMABLE_STATUSES = [
  'waiting',
  'submitting',
  'polling',
  'succeeded',
  'failed',
  'status_unknown',
];
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'status_unknown']);
const SUBMIT_DIAGNOSTIC_PHASES = new Set([
  'request_fetch',
  'response_body',
  'response_parse',
  'response_status',
  'provider_submit',
]);
const FAL_IMAGE_EGRESS_ALLOWSET = Object.freeze([
  Object.freeze({ provider: 'fal', model: 'openai/gpt-image-2' }),
  Object.freeze({ provider: 'fal', model: 'openai/gpt-image-2/edit' }),
  Object.freeze({ provider: 'fal', model: 'openai/gpt-image-2.5/flare/text-to-image' }),
  Object.freeze({ provider: 'fal', model: 'openai/gpt-image-2.5/flare/edit' }),
  Object.freeze({ provider: 'fal', model: 'xai/grok-imagine-image/edit' }),
  Object.freeze({ provider: 'fal', model: 'fal-ai/nano-banana-pro' }),
]);
const APIMART_GEMINI_IMAGE_EGRESS_ALLOWSET = Object.freeze([
  Object.freeze({ provider: 'apimart', model: 'gemini-3.1-flash-image-preview' }),
  Object.freeze({ provider: 'apimart', model: 'gemini-2.5-flash-image-preview' }),
]);
const IMAGE_EGRESS_PROVIDER_MODEL_ALLOWSET = Object.freeze([
  ...FAL_IMAGE_EGRESS_ALLOWSET,
  ...APIMART_GEMINI_IMAGE_EGRESS_ALLOWSET,
]);

function getErrorCode(error, fallback = 'IMAGE_EGRESS_JOB_FAILED') {
  return error?.lastError?.code || error?.code || error?.statusCode || fallback;
}

function createLeaseLostError() {
  const error = new Error('image-egress-v1 worker lease ownership was lost');
  error.code = 'IMAGE_EGRESS_LEASE_LOST';
  return error;
}

function isExplicitSubmitFailure(error) {
  return error?.submitOutcome === 'rejected' || error?.submitOutcome === 'definitely_not_submitted';
}

function getSafeErrorMessage(error) {
  return error?.safeMessage || error?.message || 'Image generation failed';
}

function getLastError(error) {
  return error?.lastError || error;
}

function getSafeDiagnosticToken(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const token = value.trim().slice(0, 128);
  return /^[A-Za-z0-9._:-]+$/.test(token) ? token : null;
}

function getSafeSubmitErrorCode(error) {
  const code = getErrorCode(error);
  return (
    getSafeDiagnosticToken(typeof code === 'number' ? String(code) : code) ||
    'IMAGE_EGRESS_SUBMIT_ERROR'
  );
}

function getSafeDiagnosticNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? Math.round(number) : null;
}

function getSubmitInputSummary(job, request) {
  const refs = Array.isArray(job.payload?.imageInputRefs) ? job.payload.imageInputRefs : [];
  const resolvedInputs = Array.isArray(request?.imageInputs) ? request.imageInputs : [];
  return {
    inputImageCount: refs.length || resolvedInputs.length,
    inputBytes: refs.reduce((total, ref) => total + (getSafeDiagnosticNumber(ref?.bytes) || 0), 0),
  };
}

function getSafeSubmitProgress(snapshot) {
  if (!snapshot || !SUBMIT_DIAGNOSTIC_PHASES.has(snapshot.phase)) {
    return null;
  }
  const progress = {
    phase: snapshot.phase,
    elapsedMs: getSafeDiagnosticNumber(snapshot.elapsedMs) ?? 0,
  };
  const optional = {
    requestBodyBytes: getSafeDiagnosticNumber(snapshot.requestBodyBytes),
    httpStatus: getSafeDiagnosticNumber(snapshot.httpStatus, { min: 100, max: 599 }),
    falRequestId: getSafeDiagnosticToken(snapshot.falRequestId),
    falErrorType: getSafeDiagnosticToken(snapshot.falErrorType),
    falRequestTimeoutType: getSafeDiagnosticToken(snapshot.falRequestTimeoutType),
  };
  Object.entries(optional).forEach(([key, value]) => {
    if (value != null) {
      progress[key] = value;
    }
  });
  return progress;
}

function getSubmitDiagnostic(job, request, error, elapsedMs, progress = null) {
  const cause = getLastError(error) || {};
  const responseMetadata = cause.responseMetadata || {};
  const phase = SUBMIT_DIAGNOSTIC_PHASES.has(cause.phase)
    ? cause.phase
    : progress?.phase || 'provider_submit';
  const diagnostic = {
    phase,
    elapsedMs:
      getSafeDiagnosticNumber(cause.elapsedMs) ??
      getSafeDiagnosticNumber(error?.elapsedMs) ??
      getSafeDiagnosticNumber(elapsedMs) ??
      getSafeDiagnosticNumber(progress?.elapsedMs) ??
      0,
    ...getSubmitInputSummary(job, request),
  };
  const optional = {
    requestBodyBytes:
      getSafeDiagnosticNumber(cause.requestBodyBytes) ?? progress?.requestBodyBytes ?? null,
    httpStatus:
      phase === 'request_fetch'
        ? null
        : (progress?.httpStatus ??
          getSafeDiagnosticNumber(cause.statusCode, { min: 100, max: 599 })),
    errorName: getSafeDiagnosticToken(cause.errorName || cause.name),
    transportErrorCode: getSafeDiagnosticToken(cause.transportErrorCode),
    falRequestId:
      getSafeDiagnosticToken(responseMetadata.falRequestId) ?? progress?.falRequestId ?? null,
    falErrorType:
      getSafeDiagnosticToken(responseMetadata.falErrorType) ?? progress?.falErrorType ?? null,
    falRequestTimeoutType:
      getSafeDiagnosticToken(responseMetadata.falRequestTimeoutType) ??
      progress?.falRequestTimeoutType ??
      null,
  };
  Object.entries(optional).forEach(([key, value]) => {
    if (value != null) {
      diagnostic[key] = value;
    }
  });
  return diagnostic;
}

function logUnknownSubmit(job, lastOperationErrorCode, submitDiagnostic) {
  const event = {
    event: 'image_egress_provider_submit_unknown',
    internalTaskId: getSafeDiagnosticToken(job.internalTaskId),
    requestId: getSafeDiagnosticToken(job.requestId),
    provider: getSafeDiagnosticToken(job.provider),
    model: job.model,
    operation: 'provider_submit',
    status: 'status_unknown',
    errorCode: 'IMAGE_EGRESS_SUBMIT_RESULT_UNKNOWN',
    lastOperationErrorCode,
    submitDiagnostic,
  };
  logger.warn(JSON.stringify(event), event);
}

function getAdapter(adapters, job) {
  const key = `${job.provider}:${job.model}`;
  const adapter = typeof adapters?.get === 'function' ? adapters.get(key) : adapters?.[key];
  if (!adapter) {
    const error = new Error(`No image egress adapter for ${key}`);
    error.code = 'IMAGE_EGRESS_ADAPTER_UNAVAILABLE';
    throw error;
  }
  return adapter;
}

function withoutPendingOutputUrl(metadata = {}) {
  const next = { ...metadata };
  delete next.pendingOutputUrl;
  return next;
}

function getDeadlineAt(job, operation, current) {
  const jobDeadline = job.jobDeadlineAt
    ? new Date(job.jobDeadlineAt)
    : new Date(current.getTime() + DEFAULT_JOB_DEADLINE_MS);
  const persistedOperationDeadline =
    job.currentOperation === operation && job.deadlineAt ? new Date(job.deadlineAt) : null;
  const anchor =
    operation === 'status_read' && job.providerAcceptedAt
      ? new Date(job.providerAcceptedAt)
      : current;
  const candidate =
    persistedOperationDeadline ||
    new Date(anchor.getTime() + (OPERATION_DEADLINE_MS[operation] || DEFAULT_JOB_DEADLINE_MS));
  return candidate < jobDeadline ? candidate : jobDeadline;
}

function createImageEgressJobWorker({
  workerId,
  jobStore,
  slotStore,
  adapters,
  inputStorage,
  outputStorage,
  recordUsage,
  prepareUsage,
  admitUsage,
  rolloutModes = [],
  getRolloutModes,
  shouldStop = () => false,
  allowset = IMAGE_EGRESS_PROVIDER_MODEL_ALLOWSET,
  maxConcurrency = 1,
  jobLeaseMs = DEFAULT_JOB_LEASE_MS,
  slotLeaseMs = DEFAULT_SLOT_LEASE_MS,
  now = () => new Date(),
  monotonicNow,
  sleep,
  random = Math.random,
  retryPolicies = IMAGE_EGRESS_RETRY_POLICIES,
  heartbeatIntervalMs = Math.max(1000, Math.floor(Math.min(jobLeaseMs, slotLeaseMs) / 3)),
  submitTimeoutMs = DEFAULT_SUBMIT_TIMEOUT_MS,
  outputStorageTimeoutMs = DEFAULT_OUTPUT_STORAGE_TIMEOUT_MS,
} = {}) {
  if (!workerId || !jobStore || !slotStore) {
    throw new Error('image-egress-v1 worker requires workerId, jobStore, and slotStore');
  }

  let activeTurn = null;

  async function updateJob(job, updates) {
    activeTurn?.assertOwnership();
    const updated = await jobStore.updateJob({
      internalTaskId: job.internalTaskId,
      workerId,
      updates,
    });
    if (!updated) {
      throw createLeaseLostError();
    }
    activeTurn?.assertOwnership();
    return updated;
  }

  function terminalUsageInput(job) {
    const statusUnknown = job.status === 'status_unknown';
    const succeeded = job.status === 'succeeded';
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
      subMode: job.payload?.subMode,
      businessType: job.businessType,
      status: job.status,
      imageCount: succeeded ? 1 : 0,
      providerTaskId: job.providerTaskId,
      ...(statusUnknown ? { costCny: 0 } : {}),
      billingConfirmed: succeeded,
      metadata: statusUnknown
        ? { auditOnly: true, submitOutcome: 'unknown' }
        : { auditOnly: false, submitOutcome: job.submittedToProvider ? 'accepted' : 'rejected' },
    };
  }

  function pendingTerminalUsage(job) {
    const revision = job.usageDelivery?.revision ?? 1;
    const envelope =
      typeof prepareUsage === 'function'
        ? prepareUsage({ ...terminalUsageInput(job), usageContext: job.usageContext, revision })
        : null;
    return { state: 'pending', revision, ...(envelope ? { envelope } : {}) };
  }

  async function recordTerminalUsage(job) {
    if (
      job.usageRecorded ||
      job.usageDelivery?.state === 'durable' ||
      typeof recordUsage !== 'function'
    )
      return job;
    if (!job.usageDelivery)
      job = await updateJob(job, {
        usageDelivery: pendingTerminalUsage(job),
        usageRecorded: false,
      });
    const usage = await recordUsage({
      ...terminalUsageInput(job),
      usageContext: job.usageContext,
      envelope: job.usageDelivery.envelope,
    });
    if (usage?.durableAccepted !== true && usage?.ledgerPersisted !== true) {
      const error = new Error('Image egress usage audit was not durably accepted');
      error.code = 'IMAGE_EGRESS_USAGE_PERSIST_FAILED';
      throw error;
    }
    const acknowledged = await jobStore.updateUsageDelivery({
      internalTaskId: job.internalTaskId,
      revision: job.usageDelivery.revision,
      state: usage.ledgerPersisted === true ? 'persisted' : 'durable',
    });
    const latest = acknowledged || (await jobStore.getJob(job.internalTaskId));
    if (!latest) throw createLeaseLostError();
    return latest;
  }

  async function finishTerminal(job) {
    let latest = await recordTerminalUsage(job);
    if (typeof inputStorage?.cleanup === 'function') {
      try {
        await inputStorage.cleanup({
          userId: latest.userId,
          tenantId: latest.tenantId,
          refs: latest.payload?.imageInputRefs || [],
          payload: latest.payload,
        });
      } catch (error) {
        const failedTurnCount = Number(latest.failedTurnCount || 0) + 1;
        await updateJob(latest, {
          failedTurnCount,
          lastOperationErrorCode: getErrorCode(error, 'IMAGE_EGRESS_INPUT_CLEANUP_NOT_DURABLE'),
          lastOperationAt: now(),
          nextAttemptAt: getImageEgressNextAttemptAt({
            now: now(),
            failedTurnCount,
            random,
          }),
        });
        return latest;
      }
    }
    latest = await updateJob(latest, {
      workerEligible: false,
      providerMetadata: withoutPendingOutputUrl(latest.providerMetadata),
    });
    return latest;
  }

  async function markTerminal(
    job,
    { status, errorCode, error, result, providerStatus, lastOperationErrorCode, submitDiagnostic },
  ) {
    const current = now();
    const terminal = await updateJob(job, {
      usageRecorded: false,
      usageDelivery: pendingTerminalUsage({ ...job, status, result }),
      status,
      result,
      providerStatus: providerStatus || job.providerStatus,
      errorCode,
      error,
      completedAt: current,
      providerFinishedAt: current,
      nextAttemptAt: null,
      deadlineAt: null,
      ...(lastOperationErrorCode ? { lastOperationErrorCode, lastOperationAt: current } : {}),
      providerMetadata: {
        ...withoutPendingOutputUrl(job.providerMetadata),
        ...(submitDiagnostic ? { submitDiagnostic } : {}),
      },
    });
    return finishTerminal(terminal);
  }

  async function persistTurnExhaustion(job, operation, error) {
    const current = now();
    const deadlineAt = getDeadlineAt(job, operation, current);
    const deadlineExpired =
      current >= deadlineAt || (job.jobDeadlineAt && current >= job.jobDeadlineAt);
    if (deadlineExpired) {
      const outputFailure = operation === 'output_download';
      return markTerminal(job, {
        status: 'failed',
        errorCode: outputFailure ? 'IMAGE_OUTPUT_FETCH_FAILED' : 'IMAGE_GENERATION_TIMEOUT',
        error: outputFailure
          ? 'Provider output could not be downloaded before its recovery deadline.'
          : 'Image generation recovery deadline exceeded.',
      });
    }
    const failedTurnCount = Number(job.failedTurnCount || 0) + 1;
    return updateJob(job, {
      status: 'polling',
      currentOperation: operation,
      operationAttemptCount: Number(job.operationAttemptCount || 0) + Number(error?.attempts || 1),
      operationTransientFailureCount:
        Number(job.operationTransientFailureCount || 0) + Number(error?.attempts || 1),
      failedTurnCount,
      lastOperationErrorCode: getErrorCode(error),
      lastOperationAt: current,
      deadlineAt,
      nextAttemptAt: getImageEgressNextAttemptAt({
        current,
        now: current,
        failedTurnCount,
        random,
      }),
    });
  }

  async function runRetriedOperation(job, operation, operationFn, policyOverride) {
    const current = now();
    const deadlineAt = getDeadlineAt(job, operation, current);
    if (current >= deadlineAt || (job.jobDeadlineAt && current >= new Date(job.jobDeadlineAt))) {
      return { deadlineExpired: true, deadlineAt };
    }
    try {
      const retryPolicy = policyOverride || retryPolicies[operation];
      const remainingOperationMs = deadlineAt.getTime() - current.getTime();
      const remainingJobMs = job.jobDeadlineAt
        ? new Date(job.jobDeadlineAt).getTime() - current.getTime()
        : Number.POSITIVE_INFINITY;
      const outcome = await runImageEgressTurnRetry(
        async ({ signal }) => {
          activeTurn?.assertOwnership();
          const value = await operationFn(signal);
          activeTurn?.assertOwnership();
          return value;
        },
        {
          ...retryPolicy,
          operation,
          turnBudgetMs: Math.max(
            1,
            Math.min(retryPolicy.turnBudgetMs, remainingOperationMs, remainingJobMs),
          ),
          sleep,
          monotonicNow,
          random,
          signal: activeTurn?.signal,
        },
      );
      return { ...outcome, deadlineAt };
    } catch (error) {
      if (error?.code === 'IMAGE_EGRESS_TURN_RETRY_EXHAUSTED') {
        await persistTurnExhaustion({ ...job, deadlineAt }, operation, error);
        return { scheduled: true };
      }
      if (error?.code === 'IMAGE_EGRESS_LEASE_LOST') {
        throw error;
      }
      return { terminalError: error, deadlineAt };
    }
  }

  async function prepareOperation(job, operation) {
    const current = now();
    const deadlineAt = getDeadlineAt(job, operation, current);
    if (
      job.currentOperation === operation &&
      job.deadlineAt &&
      new Date(job.deadlineAt).getTime() === deadlineAt.getTime()
    ) {
      return job;
    }
    return updateJob(job, { currentOperation: operation, deadlineAt });
  }

  async function terminalizeOperationError(job, operation, error) {
    return markTerminal(job, {
      status: 'failed',
      errorCode: getErrorCode(error),
      error:
        operation === 'output_download'
          ? 'Provider output could not be downloaded.'
          : getSafeErrorMessage(error),
    });
  }

  async function processWaiting(job, adapter) {
    const current = now();
    const jobDeadlineAt =
      job.jobDeadlineAt || new Date(current.getTime() + DEFAULT_JOB_DEADLINE_MS);
    const prepared = await updateJob(job, {
      currentOperation: 'input_read',
      jobDeadlineAt,
      deadlineAt: getDeadlineAt({ ...job, jobDeadlineAt }, 'input_read', current),
    });
    let input = await runRetriedOperation(prepared, 'input_read', (signal) =>
      inputStorage.resolve({
        userId: prepared.userId,
        tenantId: prepared.tenantId,
        refs: prepared.payload?.imageInputRefs || [],
        payload: prepared.payload,
        signal,
      }),
    );
    if (input.value && typeof adapter.prepare === 'function') {
      const request = input.value;
      const resolutionAttempts = input.attempts;
      const preparedInput = await runRetriedOperation(
        prepared,
        'input_read',
        (signal) => adapter.prepare({ request, signal }),
        {
          ...retryPolicies.input_read,
          maxAttempts: 1,
          turnBudgetMs: DEFAULT_INPUT_PREPARE_TIMEOUT_MS,
        },
      );
      input = {
        ...preparedInput,
        attempts: resolutionAttempts + (preparedInput.attempts || 0),
      };
    }
    if (input.scheduled || input.deadlineExpired) {
      if (input.deadlineExpired) {
        await markTerminal(prepared, {
          status: 'failed',
          errorCode: 'IMAGE_GENERATION_TIMEOUT',
          error: 'Input recovery deadline exceeded.',
        });
      }
      return null;
    }
    if (input.terminalError) {
      await terminalizeOperationError(prepared, 'input_read', input.terminalError);
      return null;
    }

    const usageContext =
      typeof admitUsage === 'function' ? await admitUsage(prepared) : prepared.usageContext;
    const submitStartedAt = now();
    const submitting = await updateJob(prepared, {
      usageContext,
      status: 'submitting',
      submittedToProvider: false,
      providerStartedAt: submitStartedAt,
      currentOperation: null,
      deadlineAt: null,
      operationAttemptCount: Number(prepared.operationAttemptCount || 0) + input.attempts,
      lastOperationAt: submitStartedAt,
      nextAttemptAt: null,
    });
    let submitted;
    let submitElapsedMs = 0;
    let submitProgress = null;
    try {
      await activeTurn?.renewOwnership();
      activeTurn?.assertOwnership();
      const submitOutcome = await runImageEgressTurnRetry(
        ({ signal }) =>
          adapter.submit({
            request: input.value,
            signal,
            onDiagnostic: (snapshot) => {
              submitProgress = getSafeSubmitProgress(snapshot);
            },
          }),
        {
          operation: 'provider_submit',
          maxAttempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
          turnBudgetMs: submitTimeoutMs,
          monotonicNow,
          signal: activeTurn?.signal,
        },
      );
      submitted = submitOutcome.value;
      submitElapsedMs = submitOutcome.elapsedMs;
      activeTurn?.assertOwnership();
    } catch (error) {
      if (error?.code === 'IMAGE_EGRESS_LEASE_LOST') {
        throw error;
      }
      if (isExplicitSubmitFailure(error)) {
        return markTerminal(submitting, {
          status: 'failed',
          errorCode: getErrorCode(error),
          error: getSafeErrorMessage(error),
        });
      }
      const submitDiagnostic = getSubmitDiagnostic(
        submitting,
        input.value,
        error,
        null,
        submitProgress,
      );
      const lastOperationErrorCode = getSafeSubmitErrorCode(error);
      logUnknownSubmit(submitting, lastOperationErrorCode, submitDiagnostic);
      return markTerminal(submitting, {
        status: 'status_unknown',
        errorCode: 'IMAGE_EGRESS_SUBMIT_RESULT_UNKNOWN',
        error: 'Provider submit result is unknown; automatic resubmit is disabled.',
        lastOperationErrorCode,
        submitDiagnostic,
      });
    }

    if (!submitted?.providerTaskId && !submitted?.outputUrls?.length) {
      const submitDiagnostic = getSubmitDiagnostic(
        submitting,
        input.value,
        null,
        submitElapsedMs,
        submitProgress,
      );
      logUnknownSubmit(submitting, 'FAL_MISSING_REQUEST_ID', submitDiagnostic);
      return markTerminal(submitting, {
        status: 'status_unknown',
        errorCode: 'IMAGE_EGRESS_SUBMIT_RESULT_UNKNOWN',
        error: 'Provider submit returned no durable task identity.',
        lastOperationErrorCode: 'FAL_MISSING_REQUEST_ID',
        submitDiagnostic,
      });
    }
    const pendingOutputUrl = submitted.outputUrls?.[0];
    const providerAcceptedAt = now();
    const nextOperation = pendingOutputUrl ? 'output_download' : 'status_read';
    return updateJob(submitting, {
      status: 'polling',
      submittedToProvider: true,
      providerTaskId: submitted.providerTaskId || null,
      providerAcceptedAt,
      providerMetadata: {
        ...(submitted.providerMetadata || {}),
        ...(pendingOutputUrl ? { pendingOutputUrl } : {}),
      },
      currentOperation: nextOperation,
      operationAttemptCount: 0,
      operationTransientFailureCount: 0,
      failedTurnCount: 0,
      lastOperationErrorCode: null,
      deadlineAt: getDeadlineAt(
        { ...submitting, providerAcceptedAt },
        nextOperation,
        providerAcceptedAt,
      ),
      nextAttemptAt: now(),
    });
  }

  async function processStatus(job, adapter) {
    const prepared = await prepareOperation(job, 'status_read');
    const outcome = await runRetriedOperation(prepared, 'status_read', (signal) =>
      adapter.status({
        providerTaskId: prepared.providerTaskId,
        providerMetadata: prepared.providerMetadata || {},
        signal,
      }),
    );
    if (outcome.scheduled) {
      return null;
    }
    if (outcome.terminalError) {
      return terminalizeOperationError(prepared, 'status_read', outcome.terminalError);
    }
    if (outcome.deadlineExpired) {
      return markTerminal(prepared, {
        status: 'failed',
        errorCode: 'IMAGE_GENERATION_TIMEOUT',
        error: 'Provider status recovery deadline exceeded.',
      });
    }
    const status = outcome.value;
    if (status.state === 'failed') {
      return markTerminal(prepared, {
        status: 'failed',
        errorCode: status.errorCode || 'FAL_TASK_FAILED',
        error: status.message || 'Provider reported a terminal failure.',
        providerStatus: status.providerStatus,
      });
    }
    const current = now();
    if (status.state === 'pending') {
      return updateJob(prepared, {
        status: 'polling',
        providerStatus: status.providerStatus,
        providerMetadata: {
          ...(prepared.providerMetadata || {}),
          ...(status.providerMetadata || {}),
        },
        operationAttemptCount: Number(prepared.operationAttemptCount || 0) + outcome.attempts,
        lastOperationAt: current,
        deadlineAt: outcome.deadlineAt,
        nextAttemptAt: new Date(current.getTime() + DEFAULT_POLL_DELAY_MS),
      });
    }
    const pendingOutputUrl = status.outputUrls?.[0];
    const nextOperation = pendingOutputUrl ? 'output_download' : 'result_read';
    return updateJob(prepared, {
      status: 'polling',
      providerStatus: status.providerStatus,
      providerMetadata: {
        ...(prepared.providerMetadata || {}),
        ...(status.providerMetadata || {}),
        ...(pendingOutputUrl ? { pendingOutputUrl } : {}),
      },
      currentOperation: nextOperation,
      operationAttemptCount: 0,
      operationTransientFailureCount: 0,
      failedTurnCount: 0,
      deadlineAt: getDeadlineAt(prepared, nextOperation, current),
      nextAttemptAt: current,
    });
  }

  async function processResult(job, adapter) {
    const prepared = await prepareOperation(job, 'result_read');
    const outcome = await runRetriedOperation(prepared, 'result_read', (signal) =>
      adapter.result({
        providerTaskId: prepared.providerTaskId,
        providerMetadata: prepared.providerMetadata || {},
        signal,
      }),
    );
    if (outcome.scheduled) {
      return null;
    }
    if (outcome.terminalError) {
      return terminalizeOperationError(prepared, 'result_read', outcome.terminalError);
    }
    if (outcome.deadlineExpired) {
      return markTerminal(prepared, {
        status: 'failed',
        errorCode: 'IMAGE_GENERATION_TIMEOUT',
        error: 'Provider result recovery deadline exceeded.',
      });
    }
    const pendingOutputUrl = outcome.value?.outputUrls?.[0];
    if (!pendingOutputUrl) {
      return markTerminal(prepared, {
        status: 'failed',
        errorCode: 'FAL_NO_IMAGE',
        error: 'Provider completed without an output image.',
      });
    }
    const current = now();
    return updateJob(prepared, {
      providerMetadata: {
        ...(prepared.providerMetadata || {}),
        ...(outcome.value.providerMetadata || {}),
        pendingOutputUrl,
      },
      currentOperation: 'output_download',
      operationAttemptCount: 0,
      operationTransientFailureCount: 0,
      failedTurnCount: 0,
      deadlineAt: getDeadlineAt(prepared, 'output_download', current),
      nextAttemptAt: current,
    });
  }

  async function processOutput(job) {
    const url = job.providerMetadata?.pendingOutputUrl;
    if (!url) {
      return markTerminal(job, {
        status: 'failed',
        errorCode: 'IMAGE_OUTPUT_FETCH_FAILED',
        error: 'Provider output URL is unavailable.',
      });
    }
    const prepared = await prepareOperation(job, 'output_download');
    const outcome = await runRetriedOperation(prepared, 'output_download', (signal) =>
      outputStorage.download({ url, provider: job.provider, signal }),
    );
    if (outcome.scheduled) {
      return null;
    }
    if (outcome.terminalError) {
      return terminalizeOperationError(prepared, 'output_download', outcome.terminalError);
    }
    if (outcome.deadlineExpired) {
      return markTerminal(prepared, {
        status: 'failed',
        errorCode: 'IMAGE_OUTPUT_FETCH_FAILED',
        error: 'Provider output could not be downloaded before its recovery deadline.',
      });
    }

    let stored;
    const storageStartedAt = now();
    if (job.jobDeadlineAt && storageStartedAt.getTime() >= new Date(job.jobDeadlineAt).getTime()) {
      return markTerminal(prepared, {
        status: 'failed',
        errorCode: 'IMAGE_GENERATION_TIMEOUT',
        error: 'Image generation job deadline exceeded before output storage.',
      });
    }
    const storagePending = await updateJob(prepared, {
      currentOperation: 'output_storage',
      deadlineAt: null,
      nextAttemptAt: null,
    });
    try {
      await activeTurn?.renewOwnership();
      activeTurn?.assertOwnership();
      const storageCallStartedAt = now();
      const remainingJobMs = storagePending.jobDeadlineAt
        ? new Date(storagePending.jobDeadlineAt).getTime() - storageCallStartedAt.getTime()
        : outputStorageTimeoutMs;
      if (remainingJobMs <= 0) {
        return markTerminal(storagePending, {
          status: 'failed',
          errorCode: 'IMAGE_GENERATION_TIMEOUT',
          error: 'Image generation job deadline exceeded before output storage.',
        });
      }
      const storageOutcome = await runImageEgressTurnRetry(
        async ({ signal }) => {
          const storedOutput = await outputStorage.store({
            job: storagePending,
            downloaded: outcome.value,
            signal,
          });
          if (signal.aborted) {
            if (storedOutput?.fileRef && typeof outputStorage.cleanupUncommitted === 'function') {
              await outputStorage.cleanupUncommitted({
                fileRef: storedOutput.fileRef,
                jobId: storagePending.internalTaskId,
              });
            }
            throw signal.reason || createLeaseLostError();
          }
          return storedOutput;
        },
        {
          operation: 'output_storage',
          maxAttempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
          turnBudgetMs: Math.min(outputStorageTimeoutMs, remainingJobMs),
          monotonicNow,
          signal: activeTurn?.signal,
        },
      );
      stored = storageOutcome.value;
      activeTurn?.assertOwnership();
      if (
        storagePending.jobDeadlineAt &&
        now().getTime() >= new Date(storagePending.jobDeadlineAt).getTime()
      ) {
        if (stored?.fileRef && typeof outputStorage.cleanupUncommitted === 'function') {
          await outputStorage.cleanupUncommitted({
            fileRef: stored.fileRef,
            jobId: storagePending.internalTaskId,
          });
        }
        return markTerminal(storagePending, {
          status: 'failed',
          errorCode: 'IMAGE_GENERATION_TIMEOUT',
          error: 'Image generation job deadline exceeded during output storage.',
        });
      }
    } catch (error) {
      if (error?.code === 'IMAGE_EGRESS_LEASE_LOST') {
        if (stored?.fileRef && typeof outputStorage.cleanupUncommitted === 'function') {
          await outputStorage.cleanupUncommitted({
            fileRef: stored.fileRef,
            jobId: storagePending.internalTaskId,
          });
        }
        throw error;
      }
      const storageUnknown = error?.code === 'IMAGE_EGRESS_TURN_RETRY_EXHAUSTED';
      return markTerminal(storagePending, {
        status: 'failed',
        errorCode: storageUnknown ? 'RESULT_STORAGE_STATUS_UNKNOWN' : 'RESULT_STORAGE_FAILED',
        error: storageUnknown
          ? 'Output storage completion could not be confirmed; automatic replay is disabled.'
          : getSafeErrorMessage(error),
      });
    }

    try {
      return await markTerminal(storagePending, {
        status: 'succeeded',
        result: {
          fileRef: stored.fileRef,
          sourceMetadata: outcome.value.sourceMetadata,
        },
      });
    } catch (error) {
      if (typeof outputStorage.cleanupUncommitted === 'function') {
        await outputStorage.cleanupUncommitted({
          fileRef: stored.fileRef,
          jobId: storagePending.internalTaskId,
        });
      }
      throw error;
    }
  }

  async function processJob(job) {
    if (TERMINAL_STATUSES.has(job.status)) {
      return finishTerminal(job);
    }
    if (job.status === 'submitting' && !job.providerTaskId) {
      return markTerminal(job, {
        status: 'status_unknown',
        errorCode: 'IMAGE_EGRESS_SUBMIT_RECOVERY_UNKNOWN',
        error: 'Recovered submit has no Provider task identity; automatic resubmit is disabled.',
      });
    }
    if (job.jobDeadlineAt && now() >= new Date(job.jobDeadlineAt)) {
      return markTerminal(job, {
        status: 'failed',
        errorCode: 'IMAGE_GENERATION_TIMEOUT',
        error: 'Image generation job deadline exceeded.',
      });
    }
    const adapter = getAdapter(adapters, job);
    if (
      job.status === 'waiting' ||
      (job.currentOperation === 'input_read' && !job.providerTaskId)
    ) {
      return processWaiting(job, adapter);
    }
    if (job.currentOperation === 'result_read') {
      return processResult(job, adapter);
    }
    if (job.currentOperation === 'output_download') {
      return processOutput(job);
    }
    if (job.currentOperation === 'output_storage') {
      return markTerminal(job, {
        status: 'failed',
        errorCode: 'RESULT_STORAGE_STATUS_UNKNOWN',
        error: 'Output storage completion could not be confirmed; automatic replay is disabled.',
      });
    }
    return processStatus(job, adapter);
  }

  let running = false;
  async function runOnce() {
    const activeRolloutModes =
      typeof getRolloutModes === 'function' ? getRolloutModes() : rolloutModes;
    if (running || shouldStop() || !activeRolloutModes.length) {
      return null;
    }
    running = true;
    let slot;
    let job;
    try {
      slot = await slotStore.acquireSlot({
        workerFamily: IMAGE_EGRESS_WORKER_FAMILY,
        ownerId: workerId,
        maxConcurrency,
        leaseMs: slotLeaseMs,
        now: now(),
      });
      if (!slot || shouldStop()) {
        return null;
      }
      job = await jobStore.claimNextJob({
        workerId,
        leaseMs: jobLeaseMs,
        statuses: CLAIMABLE_STATUSES,
        rolloutModes: activeRolloutModes,
        allowset,
        now: now(),
      });
      if (!job) {
        return null;
      }
      const controller = new AbortController();
      let fencedError = null;
      let heartbeatPromise = null;
      const fence = (error = createLeaseLostError()) => {
        fencedError ||= error?.code === 'IMAGE_EGRESS_LEASE_LOST' ? error : createLeaseLostError();
        controller.abort(fencedError);
      };
      const assertOwnership = () => {
        if (fencedError) {
          throw fencedError;
        }
      };
      const renewOwnership = async () => {
        if (heartbeatPromise) {
          await heartbeatPromise;
          assertOwnership();
          return;
        }
        heartbeatPromise = Promise.all([
          typeof jobStore.heartbeatJobClaim === 'function'
            ? jobStore.heartbeatJobClaim({
                internalTaskId: job.internalTaskId,
                workerId,
                leaseMs: jobLeaseMs,
                now: now(),
              })
            : true,
          typeof slotStore.heartbeatSlot === 'function'
            ? slotStore.heartbeatSlot({
                leaseId: slot.leaseId,
                ownerId: workerId,
                leaseMs: slotLeaseMs,
                now: now(),
              })
            : true,
        ])
          .then(([jobLease, slotLease]) => {
            if (!jobLease || !slotLease) {
              fence();
            }
          })
          .catch(fence)
          .finally(() => {
            heartbeatPromise = null;
          });
        await heartbeatPromise;
        assertOwnership();
      };
      activeTurn = { signal: controller.signal, assertOwnership, renewOwnership };
      const heartbeat = setInterval(() => {
        void renewOwnership().catch(() => {});
      }, heartbeatIntervalMs);
      heartbeat.unref?.();
      try {
        return await processJob(job);
      } finally {
        clearInterval(heartbeat);
        if (heartbeatPromise) {
          await heartbeatPromise.catch(() => {});
        }
        activeTurn = null;
      }
    } finally {
      try {
        // Failed releases leave leases to expire; neither may block the other
        // release or replace the processing result/error.
        if (job) {
          try {
            await jobStore.releaseJobClaim({ internalTaskId: job.internalTaskId, workerId });
          } catch (error) {
            logger.warn('[ImageGeneration] image-egress-v1 lease release failed', {
              resource: 'job',
              internalTaskId: getSafeDiagnosticToken(job.internalTaskId),
              workerId: getSafeDiagnosticToken(workerId),
              errorCode: getSafeDiagnosticToken(error?.code) || 'IMAGE_EGRESS_JOB_RELEASE_FAILED',
            });
          }
        }
        if (slot) {
          try {
            await slotStore.releaseSlot({ leaseId: slot.leaseId, ownerId: workerId, now: now() });
          } catch (error) {
            logger.warn('[ImageGeneration] image-egress-v1 lease release failed', {
              resource: 'slot',
              internalTaskId: getSafeDiagnosticToken(job?.internalTaskId),
              workerId: getSafeDiagnosticToken(workerId),
              errorCode: getSafeDiagnosticToken(error?.code) || 'IMAGE_EGRESS_SLOT_RELEASE_FAILED',
            });
          }
        }
      } finally {
        running = false;
      }
    }
  }

  return { runOnce };
}

function createMongoImageEgressJobStore({ db, now = () => new Date() }) {
  return {
    updateUsageDelivery: (args) => db.updateImageGenerationJobUsageDelivery(args),
    claimNextJob({ workerId, leaseMs, statuses, rolloutModes, allowset }) {
      return db.acquireImageEgressJobLease({
        workerId,
        leaseMs,
        statuses,
        rolloutModes,
        allowset,
        now: now(),
      });
    },
    getJob(internalTaskId) {
      return db.getImageGenerationJob({ internalTaskId, includeSensitive: true });
    },
    updateJob({ internalTaskId, workerId, updates }) {
      return db.updateImageGenerationJobWithLease({
        internalTaskId,
        workerId,
        statuses: CLAIMABLE_STATUSES,
        updates,
        now: now(),
      });
    },
    heartbeatJobClaim({ internalTaskId, workerId, leaseMs }) {
      return db.updateImageGenerationJobWithLease({
        internalTaskId,
        workerId,
        statuses: CLAIMABLE_STATUSES,
        updates: { workerLeaseUntil: new Date(now().getTime() + leaseMs) },
        now: now(),
      });
    },
    releaseJobClaim({ internalTaskId, workerId }) {
      return db.updateImageGenerationJobWithLease({
        internalTaskId,
        workerId,
        statuses: CLAIMABLE_STATUSES,
        updates: {},
        releaseLease: true,
        now: now(),
      });
    },
  };
}

function createMongoImageEgressSlotStore({ db, now = () => new Date() }) {
  return {
    acquireSlot({ workerFamily, ownerId, maxConcurrency, leaseMs }) {
      return db.acquireImageEgressWorkerSlot({
        workerFamily,
        ownerId,
        maxConcurrency,
        leaseMs,
        now: now(),
      });
    },
    releaseSlot({ leaseId, ownerId }) {
      return db.releaseImageEgressWorkerSlot({ leaseId, ownerId, now: now() });
    },
    heartbeatSlot({ leaseId, ownerId, leaseMs }) {
      return db.heartbeatImageEgressWorkerSlot({
        leaseId,
        ownerId,
        leaseMs,
        now: now(),
      });
    },
  };
}

module.exports = {
  APIMART_GEMINI_IMAGE_EGRESS_ALLOWSET,
  CLAIMABLE_STATUSES,
  FAL_IMAGE_EGRESS_ALLOWSET,
  IMAGE_EGRESS_PROVIDER_MODEL_ALLOWSET,
  createImageEgressJobWorker,
  createMongoImageEgressJobStore,
  createMongoImageEgressSlotStore,
};
