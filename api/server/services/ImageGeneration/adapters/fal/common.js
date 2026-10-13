const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_POLL_INTERVAL_MS = 3000;

function getFalConfig() {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    const error = new Error('FAL_KEY is not configured');
    error.statusCode = 500;
    error.code = 'FAL_KEY_MISSING';
    throw error;
  }

  return { apiKey };
}

function getNumberEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getFalTimeoutMs() {
  return getNumberEnv('FAL_IMAGE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}

function getFalPollIntervalMs() {
  return getNumberEnv('FAL_IMAGE_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('fal request aborted locally');
    error.name = 'AbortError';
    throw error;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('fal polling aborted locally');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    const timeout = setTimeout(resolve, ms);
    const abortHandler = () => {
      clearTimeout(timeout);
      const error = new Error('fal polling aborted locally');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
}

function normalizeFalErrorCode(statusCode, fallback = 'FAL_UNKNOWN') {
  if (statusCode === 400) {
    return 'FAL_BAD_REQUEST';
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'FAL_HTTP_401';
  }
  if (statusCode === 404) {
    return 'FAL_HTTP_404';
  }
  return statusCode ? `FAL_HTTP_${statusCode}` : fallback;
}

function sanitizeFalMessage(message) {
  if (typeof message !== 'string') {
    return null;
  }

  return (
    message
      .replace(/data:image\/[^\s"')]+/gi, '[image-data]')
      .replace(/https?:\/\/\S+/gi, '[url]')
      .replace(/[A-Za-z0-9_-]{20,}:[A-Za-z0-9_-]{20,}/g, '[fal-key]')
      .slice(0, 200) || null
  );
}

function getFalErrorSummary(json) {
  if (!json || typeof json !== 'object') {
    return null;
  }

  const candidates = [
    json.message,
    json.detail,
    json.error,
    json.error?.message,
    json.error?.detail,
    Array.isArray(json.errors) ? json.errors[0]?.message || json.errors[0]?.detail : null,
  ];
  const summary = candidates.find((value) => typeof value === 'string' && value.trim());
  return sanitizeFalMessage(summary);
}

function sanitizeFalDiagnosticToken(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const token = value.trim().slice(0, 128);
  return /^[A-Za-z0-9._:-]+$/.test(token) ? token : null;
}

function getFalTransportErrorCode(error) {
  return error?.code || error?.cause?.code || null;
}

function getFalResponseMetadata(response) {
  const readHeader = (name) => {
    try {
      return sanitizeFalDiagnosticToken(response?.headers?.get?.(name));
    } catch {
      return null;
    }
  };
  const metadata = {
    falRequestId: readHeader('x-fal-request-id'),
    falErrorType: readHeader('x-fal-error-type'),
    falRequestTimeoutType: readHeader('x-fal-request-timeout-type'),
  };
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value != null));
}

function reportFalDiagnostic(onDiagnostic, diagnostic) {
  if (typeof onDiagnostic !== 'function') {
    return;
  }
  try {
    onDiagnostic(diagnostic);
  } catch {
    // Diagnostics must never change the Provider request outcome.
  }
}

function createFalError(code, statusCode, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.errorName = options.errorName || null;
  error.safeMessage = options.safeMessage || sanitizeFalMessage(message);
  error.providerResponseParsed = Boolean(options.providerResponseParsed);
  if (options.phase) {
    error.phase = options.phase;
  }
  if (Number.isFinite(options.elapsedMs)) {
    error.elapsedMs = Math.max(0, Math.round(options.elapsedMs));
  }
  if (Number.isFinite(options.requestBodyBytes)) {
    error.requestBodyBytes = Math.max(0, Math.round(options.requestBodyBytes));
  }
  if (options.responseMetadata && Object.keys(options.responseMetadata).length > 0) {
    error.responseMetadata = options.responseMetadata;
  }
  const transportErrorCode = sanitizeFalDiagnosticToken(options.transportErrorCode);
  if (transportErrorCode) {
    error.transportErrorCode = transportErrorCode;
  }
  return error;
}

async function fetchFalJson(url, options = {}, diagnostics = {}) {
  const { apiKey } = getFalConfig();
  const startedAt = Date.now();
  reportFalDiagnostic(diagnostics.onDiagnostic, {
    phase: 'request_fetch',
    elapsedMs: 0,
    ...(Number.isFinite(diagnostics.requestBodyBytes)
      ? { requestBodyBytes: diagnostics.requestBodyBytes }
      : {}),
  });
  let response;

  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Key ${apiKey}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw createFalError('FAL_NETWORK_ERROR', 502, 'fal 请求失败，请稍后重试。', {
      errorName: error?.name || 'FetchError',
      safeMessage: sanitizeFalMessage(error?.message) || 'fal network request failed',
      phase: 'request_fetch',
      elapsedMs: Date.now() - startedAt,
      requestBodyBytes: diagnostics.requestBodyBytes,
      transportErrorCode: getFalTransportErrorCode(error),
    });
  }

  const responseMetadata = getFalResponseMetadata(response);
  const getProgressDiagnostic = (phase) => ({
    phase,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...(Number.isFinite(diagnostics.requestBodyBytes)
      ? { requestBodyBytes: diagnostics.requestBodyBytes }
      : {}),
    ...(Number.isFinite(response.status) ? { httpStatus: response.status } : {}),
    ...responseMetadata,
  });
  reportFalDiagnostic(diagnostics.onDiagnostic, getProgressDiagnostic('response_body'));
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw createFalError('FAL_RESPONSE_BODY_ERROR', response.status, 'fal 响应体读取失败。', {
      errorName: error?.name || 'ResponseBodyError',
      safeMessage: 'Fal response body could not be read',
      phase: 'response_body',
      elapsedMs: Date.now() - startedAt,
      requestBodyBytes: diagnostics.requestBodyBytes,
      responseMetadata,
      transportErrorCode: getFalTransportErrorCode(error),
    });
  }
  let json = null;
  reportFalDiagnostic(diagnostics.onDiagnostic, getProgressDiagnostic('response_parse'));

  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw createFalError('FAL_NON_JSON_RESPONSE', response.status, 'fal 返回了非 JSON 响应。', {
      phase: 'response_parse',
      elapsedMs: Date.now() - startedAt,
      requestBodyBytes: diagnostics.requestBodyBytes,
      responseMetadata,
    });
  }

  if (!response.ok) {
    const balanceFailure =
      response.status === 403
        ? require('@librechat/api').getFalBalanceFailure(response.status, json?.detail)
        : null;
    const safeMessage = balanceFailure?.message || getFalErrorSummary(json);
    throw createFalError(
      balanceFailure?.code || normalizeFalErrorCode(response.status),
      response.status,
      balanceFailure?.message || 'FAL 图像生成请求失败，请稍后重试。',
      {
        safeMessage,
        providerResponseParsed: true,
        phase: 'response_status',
        elapsedMs: Date.now() - startedAt,
        requestBodyBytes: diagnostics.requestBodyBytes,
        responseMetadata,
      },
    );
  }

  return json || {};
}

function collectResultURLs(value, result = []) {
  if (!value) {
    return result;
  }

  if (typeof value === 'string') {
    if (value.startsWith('http')) {
      result.push(value);
    }
    return result;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectResultURLs(item, result));
    return result;
  }

  if (typeof value === 'object') {
    if (value.url) {
      collectResultURLs(value.url, result);
    }
    if (value.image_url) {
      collectResultURLs(value.image_url, result);
    }

    ['image', 'images', 'data', 'result', 'results', 'output', 'outputs', 'artifacts'].forEach(
      (key) => collectResultURLs(value[key], result),
    );
  }

  return result;
}

function getOutputCount(json) {
  return collectResultURLs(json).length;
}

function normalizeStatus(statusJson) {
  const status = statusJson?.status || statusJson?.state || statusJson?.queue_status;
  return typeof status === 'string' ? status.toUpperCase() : null;
}

function getFalQueueURLs({ model, providerTaskId, statusUrl, responseUrl }) {
  return {
    statusUrl: statusUrl || `https://queue.fal.run/${model}/requests/${providerTaskId}/status`,
    responseUrl: responseUrl || `https://queue.fal.run/${model}/requests/${providerTaskId}`,
  };
}

async function submitFalQueueTask({ model, payload, signal, onDiagnostic }) {
  let submitted;
  try {
    submitted = await submitFalTask({ model, payload, signal, onDiagnostic });
  } catch (error) {
    let submitOutcome = 'unknown';
    const statusCode = Number(error?.statusCode);
    const isExplicitClientRejection =
      error.providerResponseParsed &&
      statusCode >= 400 &&
      statusCode < 500 &&
      ![408, 409, 425, 429].includes(statusCode);
    if (error.code === 'FAL_KEY_MISSING') {
      submitOutcome = 'definitely_not_submitted';
    } else if (isExplicitClientRejection) {
      submitOutcome = 'rejected';
    }
    error.submitOutcome = submitOutcome;
    throw error;
  }
  const outputUrls = collectResultURLs(submitted);
  const providerTaskId = submitted.request_id || submitted.requestId || submitted.id;

  if (!providerTaskId && !outputUrls.length) {
    const error = new Error('fal 未返回任务 ID。');
    error.code = 'FAL_MISSING_REQUEST_ID';
    error.statusCode = 502;
    error.submitOutcome = 'unknown';
    throw error;
  }

  const providerMetadata = providerTaskId
    ? getFalQueueURLs({
        model,
        providerTaskId,
        statusUrl: submitted.status_url,
        responseUrl: submitted.response_url,
      })
    : {};

  return { providerTaskId: providerTaskId || null, providerMetadata, outputUrls };
}

async function readFalQueueStatus({ model, providerTaskId, statusUrl, signal }) {
  throwIfAborted(signal);
  const urls = getFalQueueURLs({ model, providerTaskId, statusUrl });
  const statusJson = await fetchFalJson(urls.statusUrl, { method: 'GET', signal });
  const providerStatus = normalizeStatus(statusJson) || 'IN_PROGRESS';
  let state = 'pending';

  if (['COMPLETED', 'SUCCESS', 'SUCCEEDED'].includes(providerStatus)) {
    state = 'succeeded';
  } else if (['FAILED', 'ERROR', 'CANCELED', 'CANCELLED'].includes(providerStatus)) {
    state = 'failed';
  }

  const providerMetadata = {};
  if (Number.isFinite(statusJson.queue_position)) {
    providerMetadata.queuePosition = statusJson.queue_position;
  }

  return { state, providerStatus, providerMetadata };
}

async function readFalQueueResult({ model, providerTaskId, responseUrl, signal }) {
  throwIfAborted(signal);
  const urls = getFalQueueURLs({ model, providerTaskId, responseUrl });
  const json = await fetchFalJson(urls.responseUrl, { method: 'GET', signal });
  const outputUrls = collectResultURLs(json);

  if (!outputUrls.length) {
    const error = new Error('fal 任务完成但未返回图片。');
    error.code = 'FAL_NO_IMAGE';
    error.statusCode = 502;
    throw error;
  }

  return { outputUrls, providerMetadata: {} };
}

async function pollFalResult({ model, submitResponse, signal }) {
  throwIfAborted(signal);
  const immediateURLs = collectResultURLs(submitResponse);
  if (immediateURLs.length) {
    return { json: submitResponse, resultUrl: immediateURLs[0], status: 'success' };
  }

  const requestId = submitResponse.request_id || submitResponse.requestId || submitResponse.id;
  if (!requestId) {
    const error = new Error('fal 未返回任务 ID。');
    error.code = 'FAL_MISSING_REQUEST_ID';
    error.statusCode = 502;
    throw error;
  }

  const statusUrl =
    submitResponse.status_url || `https://queue.fal.run/${model}/requests/${requestId}/status`;
  const responseUrl =
    submitResponse.response_url || `https://queue.fal.run/${model}/requests/${requestId}`;
  const startedAt = Date.now();
  const timeoutMs = getFalTimeoutMs();
  const intervalMs = getFalPollIntervalMs();

  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    const statusJson = await fetchFalJson(statusUrl, { method: 'GET', signal });
    const status = normalizeStatus(statusJson);

    if (status === 'COMPLETED' || status === 'SUCCESS' || status === 'SUCCEEDED') {
      const json = await fetchFalJson(responseUrl, { method: 'GET', signal });
      const urls = collectResultURLs(json);
      if (!urls.length) {
        const error = new Error('fal 任务完成但未返回图片。');
        error.code = 'FAL_NO_IMAGE';
        error.statusCode = 502;
        throw error;
      }
      return { json, resultUrl: urls[0], status: 'success', taskId: requestId };
    }

    if (
      status === 'FAILED' ||
      status === 'ERROR' ||
      status === 'CANCELED' ||
      status === 'CANCELLED'
    ) {
      throw createFalError('FAL_TASK_FAILED', 502, 'FAL 图像生成失败，请稍后重试。');
    }

    await sleep(intervalMs, signal);
  }

  const error = new Error('fal 生成超时，请稍后重试。');
  error.code = 'FAL_TIMEOUT';
  error.statusCode = 504;
  error.timeoutMs = timeoutMs;
  throw error;
}

async function submitFalTask({ model, payload, signal, onDiagnostic }) {
  const body = JSON.stringify(payload);
  return fetchFalJson(
    `https://queue.fal.run/${model}`,
    {
      method: 'POST',
      body,
      signal,
    },
    { requestBodyBytes: Buffer.byteLength(body, 'utf8'), onDiagnostic },
  );
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  collectResultURLs,
  getFalConfig,
  getFalPollIntervalMs,
  getFalTimeoutMs,
  getOutputCount,
  normalizeFalErrorCode,
  pollFalResult,
  readFalQueueResult,
  readFalQueueStatus,
  submitFalQueueTask,
  submitFalTask,
};
