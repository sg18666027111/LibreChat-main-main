const TRANSIENT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'RESULT_DOWNLOAD_TIMEOUT',
  'APIMART_STATUS_TRANSPORT_ERROR',
  'IMAGE_EGRESS_OPERATION_TIMEOUT',
]);
const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504]);
const TERMINAL_ERROR_CODES = new Set([
  'INVALID_RESULT_IMAGE',
  'RESULT_URL_REJECTED',
  'RESULT_DOWNLOAD_TOO_LARGE',
  'RESULT_URL_EXPIRED',
  'FAL_NO_IMAGE',
]);

const IMAGE_EGRESS_RETRY_POLICIES = Object.freeze({
  status_read: Object.freeze({
    operation: 'status_read',
    maxAttempts: 4,
    baseDelayMs: 500,
    maxDelayMs: 5000,
    jitterRatio: 0.2,
    turnBudgetMs: 30_000,
  }),
  result_read: Object.freeze({
    operation: 'result_read',
    maxAttempts: 4,
    baseDelayMs: 500,
    maxDelayMs: 5000,
    jitterRatio: 0.2,
    turnBudgetMs: 30_000,
  }),
  output_download: Object.freeze({
    operation: 'output_download',
    maxAttempts: 3,
    baseDelayMs: 750,
    maxDelayMs: 6000,
    jitterRatio: 0.2,
    turnBudgetMs: 45_000,
  }),
  input_read: Object.freeze({
    operation: 'input_read',
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 2000,
    jitterRatio: 0.2,
    turnBudgetMs: 20_000,
  }),
});

function getHTTPStatus(error) {
  return Number(error?.statusCode ?? error?.status ?? error?.response?.status) || null;
}

function isRetryableImageEgressError(error) {
  const code = String(error?.code || '').toUpperCase();
  if (TERMINAL_ERROR_CODES.has(code)) {
    return false;
  }
  const status = getHTTPStatus(error);
  if (status != null) {
    return TRANSIENT_HTTP_STATUSES.has(status);
  }
  return TRANSIENT_ERROR_CODES.has(code) || code.startsWith('ERR_TLS_');
}

function getJitteredDelay(delayMs, jitterRatio, random) {
  const sample = Math.min(1, Math.max(0, Number(random()) || 0));
  const factor = 1 + (sample * 2 - 1) * jitterRatio;
  return Math.max(0, Math.round(delayMs * factor));
}

function createTurnExhaustedError({ operation, attempts, elapsedMs, lastError }) {
  const error = new Error(`${operation} retry budget exhausted`);
  error.code = 'IMAGE_EGRESS_TURN_RETRY_EXHAUSTED';
  error.operation = operation;
  error.attempts = attempts;
  error.elapsedMs = elapsedMs;
  error.lastError = lastError;
  return error;
}

function createOperationTimeoutError(operation) {
  const error = new Error(`${operation} exceeded its worker-turn I/O budget`);
  error.code = 'IMAGE_EGRESS_OPERATION_TIMEOUT';
  error.operation = operation;
  return error;
}

function createAbortError(signal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error('Image egress operation was aborted');
  error.code = 'IMAGE_EGRESS_OPERATION_ABORTED';
  return error;
}

async function runBoundedOperation(operationFn, { operation, remainingBudgetMs, signal }) {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }

  const controller = new AbortController();
  let timeout;
  let abortHandler;
  const operationPromise = Promise.resolve().then(() =>
    operationFn({ signal: controller.signal, remainingBudgetMs }),
  );
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(
      () => {
        const error = createOperationTimeoutError(operation);
        controller.abort(error);
        reject(error);
      },
      Math.max(1, remainingBudgetMs),
    );
    timeout.unref?.();
  });
  const candidates = [operationPromise, timeoutPromise];
  if (signal) {
    candidates.push(
      new Promise((_, reject) => {
        abortHandler = () => {
          const error = createAbortError(signal);
          controller.abort(error);
          reject(error);
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }),
    );
  }

  try {
    return await Promise.race(candidates);
  } finally {
    clearTimeout(timeout);
    if (abortHandler) {
      signal.removeEventListener('abort', abortHandler);
    }
  }
}

async function runImageEgressTurnRetry(
  operationFn,
  {
    operation,
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    jitterRatio,
    turnBudgetMs,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    monotonicNow = () => performance.now(),
    random = Math.random,
    signal,
  },
) {
  const startedAt = monotonicNow();
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const elapsedBeforeAttempt = Math.max(0, monotonicNow() - startedAt);
      const remainingBudgetMs = turnBudgetMs - elapsedBeforeAttempt;
      if (remainingBudgetMs <= 0) {
        throw createOperationTimeoutError(operation);
      }
      const value = await runBoundedOperation(operationFn, {
        operation,
        remainingBudgetMs,
        signal,
      });
      return { value, attempts, elapsedMs: Math.max(0, monotonicNow() - startedAt) };
    } catch (error) {
      if (!isRetryableImageEgressError(error)) {
        throw error;
      }

      const elapsedMs = Math.max(0, monotonicNow() - startedAt);
      if (attempts >= maxAttempts) {
        throw createTurnExhaustedError({ operation, attempts, elapsedMs, lastError: error });
      }

      const exponentialDelay = Math.min(baseDelayMs * 2 ** (attempts - 1), maxDelayMs);
      const delayMs = getJitteredDelay(exponentialDelay, jitterRatio, random);
      if (elapsedMs + delayMs > turnBudgetMs) {
        throw createTurnExhaustedError({ operation, attempts, elapsedMs, lastError: error });
      }
      await sleep(delayMs);
    }
  }

  throw new Error(`${operation} retry loop ended unexpectedly`);
}

function getImageEgressNextAttemptAt({ now = new Date(), failedTurnCount, random = Math.random }) {
  const turn = Math.max(1, Math.floor(failedTurnCount || 1));
  const delayMs = Math.min(5000 * 2 ** (turn - 1), 60_000);
  return new Date(now.getTime() + getJitteredDelay(delayMs, 0.2, random));
}

module.exports = {
  IMAGE_EGRESS_RETRY_POLICIES,
  getImageEgressNextAttemptAt,
  isRetryableImageEgressError,
  runImageEgressTurnRetry,
};
