const { logger } = require('@librechat/data-schemas');
const { parseAPIMartTaskFailure, sanitizeAPIMartErrorMessage } = require('@librechat/api');

const DEFAULT_BASE_URL = 'https://api.apimart.ai/v1';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 90000;
const SUBMIT_TIMEOUT_MS = 90000;
const MAX_TASK_TIMEOUT_MS = 12 * 60 * 1000;
const POLLING_PROGRESS_LOG_INTERVAL_MS = 30000;
const MODEL_TIMEOUT_MS = {
  'gpt-image-2': 300000,
  'gpt-image-2.5-sunburst': 300000,
  'gpt-image-2.5-flare': 300000,
  'gemini-3.1-flash-image-preview': 90000,
  'gemini-2.5-flash-image-preview': 90000,
};
const TASK_TIMEOUT_MS = {
  'single-image-edit': 300000,
  'multi-reference': 600000,
};
const GPT_IMAGE_2_MODEL = 'gpt-image-2';
const GPT_IMAGE_2_TIMEOUT_MESSAGE =
  '供应商仍在处理本次任务，系统将继续检查原任务。请勿重复提交，以免产生重复费用。';
const GPT_IMAGE_2_NO_IMAGE_MESSAGE =
  'APIMart GPT Image 2 未返回有效图片结果，可能是提示词过长、内容过复杂或上游返回异常。建议简化提示词或切换 Seedream 5.0 Pro。';

function getPositiveIntegerEnv(name, fallback = null) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function getEnvTimeoutMs() {
  return (
    getPositiveIntegerEnv('APIMART_IMAGE_TIMEOUT_MS') ??
    getPositiveIntegerEnv('IMAGE_GENERATION_TIMEOUT_MS')
  );
}

function getSubmitTimeoutMs() {
  return Math.min(
    getPositiveIntegerEnv('APIMART_IMAGE_SUBMIT_TIMEOUT_MS', SUBMIT_TIMEOUT_MS),
    MAX_TASK_TIMEOUT_MS,
  );
}

function getModelTimeoutMs(model, taskType) {
  const envTimeoutMs = getEnvTimeoutMs();
  if (envTimeoutMs) {
    return Math.min(envTimeoutMs, MAX_TASK_TIMEOUT_MS);
  }

  if (taskType && TASK_TIMEOUT_MS[taskType]) {
    return TASK_TIMEOUT_MS[taskType];
  }

  return MODEL_TIMEOUT_MS[model] ?? POLL_TIMEOUT_MS;
}

function getAPIMartConfig() {
  const apiKey = process.env.APIMART_API_KEY;
  const baseURL = (process.env.APIMART_IMAGE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');

  if (!apiKey) {
    const error = new Error('APIMART_API_KEY is not configured');
    error.statusCode = 500;
    error.code = 'APIMART_CONFIG_MISSING';
    throw error;
  }

  return { apiKey, baseURL };
}

function maskKey(value) {
  if (!value) {
    return null;
  }

  return `${value.slice(0, 6)}***${value.slice(-4)}`;
}

function createAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError('APIMart request aborted locally');
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError('APIMart polling aborted locally'));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    const abortHandler = () => {
      clearTimeout(timeout);
      reject(createAbortError('APIMart polling aborted locally'));
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
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

function getResponseKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

function getArrayLength(value) {
  return Array.isArray(value) ? value.length : null;
}

function getImageInputCount(payload) {
  return Array.isArray(payload?.image_urls) ? payload.image_urls.length : 0;
}

function sanitizeErrorMessage(message) {
  return sanitizeAPIMartErrorMessage(message, process.env.APIMART_API_KEY);
}

function getSafeAPIMartLogContext(context = {}, extra = {}) {
  const responseBody = context.responseBody || extra.responseBody || null;
  const result = context.result || extra.result || null;
  const providerTaskId =
    context.providerTaskId || context.taskId || extra.providerTaskId || extra.taskId || null;

  return {
    provider: 'apimart',
    model: context.model || extra.model || null,
    modelKey: context.modelKey || extra.modelKey || null,
    taskType: context.taskType || extra.taskType || null,
    batchId: context.batchId || extra.batchId || null,
    itemId: context.itemId || extra.itemId || null,
    promptLength: context.promptLength ?? extra.promptLength ?? null,
    timeoutMs: context.timeoutMs ?? extra.timeoutMs ?? null,
    elapsedMs: context.elapsedMs ?? extra.elapsedMs ?? null,
    providerTaskIdMasked: maskTaskId(providerTaskId),
    providerStatus:
      context.providerStatus ||
      extra.providerStatus ||
      getStatus(responseBody) ||
      getStatus(result) ||
      null,
    errorCode: context.errorCode || extra.errorCode || null,
    statusCode: context.statusCode || extra.statusCode || null,
    responseKeys: getResponseKeys(responseBody),
    resultKeys: getResponseKeys(result),
    finalImageCount:
      extra.finalImageCount ??
      context.finalImageCount ??
      getArrayLength(result?.images) ??
      getArrayLength(responseBody?.images) ??
      null,
  };
}

function getLogContext(payload = {}, context = {}) {
  return {
    ...getSafeAPIMartLogContext(context),
    provider: 'apimart',
    model: payload.model || context.model || null,
    taskType: context.taskType || null,
    imageInputCount: getImageInputCount(payload),
    requestedCount: payload.n ?? null,
    size: payload.size || null,
    resolution: payload.resolution || null,
  };
}

async function postJSON(path, payload, options = {}) {
  const { apiKey, baseURL } = getAPIMartConfig();
  const response = await fetch(`${baseURL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  return parseAPIMartResponse(response);
}

async function getJSON(path, options = {}) {
  const { apiKey, baseURL } = getAPIMartConfig();
  const response = await fetch(`${baseURL}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: options.signal,
  });

  return parseAPIMartResponse(response);
}

async function parseAPIMartResponse(response) {
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message = json?.error?.message || json?.message || text || 'APIMart request failed';
    const error = new Error(message);
    error.statusCode = response.status;
    error.responseBody = json || text;
    error.providerResponseParsed = Boolean(json);
    throw error;
  }

  return json;
}

function findTaskId(json) {
  return (
    json?.task_id ??
    json?.taskId ??
    json?.id ??
    json?.data?.[0]?.task_id ??
    json?.data?.[0]?.taskId ??
    json?.data?.[0]?.id ??
    json?.data?.task_id ??
    json?.data?.taskId ??
    json?.data?.id ??
    null
  );
}

function isFailureStatus(status) {
  return ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(
    String(status).toLowerCase(),
  );
}

function isSuccessStatus(status) {
  return ['success', 'succeeded', 'completed', 'complete', 'done', 'finished'].includes(
    String(status).toLowerCase(),
  );
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
    if (value.output_url) {
      collectResultURLs(value.output_url, result);
    }

    ['data', 'images', 'result', 'results', 'output', 'outputs', 'artifacts'].forEach((key) => {
      collectResultURLs(value[key], result);
    });
  }

  return result;
}

function getStatus(json) {
  return (
    json?.status ??
    json?.state ??
    json?.data?.status ??
    json?.data?.state ??
    json?.result?.status ??
    json?.result?.state ??
    null
  );
}

function getCost(json) {
  return json?.cost ?? json?.data?.cost ?? json?.billing?.cost ?? null;
}

function isGPTImage2(model) {
  return [GPT_IMAGE_2_MODEL, 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'].includes(model);
}

function getSafeAPIMartError(error, context = {}) {
  if (!error) {
    return error;
  }

  const message = String(error.safeMessage || error.message || '');
  const normalizedMessage = message.toLowerCase();
  const providerStatus =
    context.providerStatus || error.providerStatus || getStatus(error.responseBody) || null;
  if (isFailureStatus(providerStatus)) {
    error.providerStatus = providerStatus;
    error.safeMessage = sanitizeErrorMessage(message) || 'APIMart task failed';
    return error;
  }
  const normalizedStatus = String(providerStatus || '').toLowerCase();
  const isTimeout =
    error.code === 'IMAGE_GENERATION_TIMEOUT' ||
    error.code === 'APIMART_IMAGE_SUBMIT_TIMEOUT' ||
    normalizedMessage.includes('task timeout') ||
    normalizedMessage.includes('timed out') ||
    normalizedMessage.includes('timeout') ||
    normalizedStatus === 'in_progress';
  const isNoImage =
    normalizedMessage.includes('expected image') ||
    normalizedMessage.includes('no image') ||
    normalizedMessage.includes('returned no image') ||
    normalizedMessage.includes('did not return') ||
    normalizedMessage.includes('without image');

  if (isGPTImage2(context.model) && isTimeout) {
    if (
      error.code === 'APIMART_IMAGE_SUBMIT_TIMEOUT' &&
      !context.providerTaskId &&
      !error.providerTaskId
    ) {
      error.safeMessage =
        '提交响应超时，暂时无法确认供应商是否接收任务。请勿重复提交，请联系管理员核查。';
      error.providerCode = 'APIMART_GPT_IMAGE_2_TIMEOUT';
      error.providerStatus = providerStatus;
      return error;
    }
    error.safeMessage = GPT_IMAGE_2_TIMEOUT_MESSAGE;
    error.providerCode = 'APIMART_GPT_IMAGE_2_TIMEOUT';
    error.providerStatus = providerStatus || error.providerStatus || 'IN_PROGRESS';
    return error;
  }

  if (isGPTImage2(context.model) && isNoImage) {
    const label =
      {
        'gpt-image-2.5-sunburst': 'GPT Image 2.5 Sunburst',
        'gpt-image-2.5-flare': 'GPT Image 2.5 Flare',
      }[context.model] || 'GPT Image 2';
    error.safeMessage = GPT_IMAGE_2_NO_IMAGE_MESSAGE.replace('GPT Image 2', label);
    error.providerCode = 'APIMART_GPT_IMAGE_2_NO_IMAGE';
    return error;
  }

  error.safeMessage = sanitizeErrorMessage(error.safeMessage || error.message) || error.message;
  return error;
}

function getPollPaths(taskId) {
  return [`/tasks/${taskId}`];
}

async function readAPIMartTaskStatus({ taskId, signal }) {
  throwIfAborted(signal);
  let json;
  try {
    json = await getJSON(`/tasks/${taskId}`, { signal });
  } catch (error) {
    if (!error?.statusCode) {
      error.code = error?.cause?.code || error?.code || 'APIMART_STATUS_TRANSPORT_ERROR';
    }
    throw error;
  }
  const providerStatus = getStatus(json) || 'IN_PROGRESS';
  const outputUrls = collectResultURLs(json);
  const providerMetadata = {
    ...(getCost(json) == null ? {} : { cost: getCost(json) }),
  };

  if (isFailureStatus(providerStatus)) {
    const failure = parseAPIMartTaskFailure(json, process.env.APIMART_API_KEY);
    return {
      state: 'failed',
      providerStatus,
      outputUrls: [],
      errorCode: failure.code,
      message: failure.message,
      providerMetadata,
    };
  }
  if (outputUrls.length) {
    return {
      state: 'succeeded',
      providerStatus,
      outputUrls,
      providerMetadata,
    };
  }
  if (isSuccessStatus(providerStatus)) {
    return {
      state: 'failed',
      providerStatus,
      outputUrls: [],
      errorCode: 'APIMART_TASK_NO_IMAGE',
      message: 'APIMart task completed without an image.',
      providerMetadata,
    };
  }
  return {
    state: 'pending',
    providerStatus,
    outputUrls: [],
    providerMetadata,
  };
}

async function pollTask({
  taskId,
  timeoutMs = POLL_TIMEOUT_MS,
  intervalMs = POLL_INTERVAL_MS,
  model = null,
  taskType = null,
  context = {},
  signal,
}) {
  const startedAt = Date.now();
  let lastProgressLogAt = 0;
  const pollPaths = getPollPaths(taskId);
  let lastError = null;
  let pollCount = 0;
  let lastPersistedStatus = null;
  let lastPollSummary = {
    upstreamStatus: null,
    urlCount: 0,
    responseKeys: [],
    isCompleted: false,
    isFailed: false,
    isPending: true,
  };

  while (Date.now() - startedAt < timeoutMs) {
    for (const path of pollPaths) {
      pollCount += 1;
      try {
        throwIfAborted(signal);
        const json = await getJSON(path, { signal });
        const status = getStatus(json);
        const urls = collectResultURLs(json);
        const isCompleted = Boolean(urls.length) || isSuccessStatus(status);
        const isFailed = isFailureStatus(status);

        if (typeof context.onProviderPoll === 'function') {
          await context.onProviderPoll({
            providerTaskId: taskId,
            providerStatus: status || 'IN_PROGRESS',
          });
        }

        if (
          status &&
          status !== lastPersistedStatus &&
          typeof context.onProviderStatusChanged === 'function'
        ) {
          await context.onProviderStatusChanged({
            providerTaskId: taskId,
            providerStatus: status,
          });
          lastPersistedStatus = status;
        }

        lastPollSummary = {
          upstreamStatus: status,
          urlCount: urls.length,
          responseKeys: getResponseKeys(json),
          isCompleted,
          isFailed,
          isPending: !isCompleted && !isFailed,
        };

        if (urls.length) {
          logger.info('[ImageGeneration] polling completed', {
            ...getSafeAPIMartLogContext(context, {
              model,
              taskType,
              providerTaskId: taskId,
              timeoutMs,
              elapsedMs: Date.now() - startedAt,
              providerStatus: status,
              responseBody: json,
              finalImageCount: urls.length,
            }),
            model,
            taskType,
            taskIdMasked: maskTaskId(taskId),
            pollCount,
            elapsedMs: Date.now() - startedAt,
            timeoutMs,
            pollIntervalMs: intervalMs,
            upstreamStatus: status,
            urlCount: urls.length,
            responseKeys: getResponseKeys(json),
            isCompleted: true,
            isFailed: false,
            isPending: false,
          });
          return {
            json,
            status: status || 'success',
            resultUrl: urls[0],
            cost: getCost(json),
            pollPath: path,
          };
        }

        if (isFailureStatus(status)) {
          const failure = parseAPIMartTaskFailure(json, process.env.APIMART_API_KEY);
          logger.warn('[ImageGeneration] polling upstream failed', {
            ...getSafeAPIMartLogContext(context, {
              model,
              taskType,
              providerTaskId: taskId,
              timeoutMs,
              elapsedMs: Date.now() - startedAt,
              providerStatus: status,
              errorCode: failure.code,
              responseBody: json,
              finalImageCount: 0,
            }),
            model,
            taskType,
            taskIdMasked: maskTaskId(taskId),
            pollCount,
            elapsedMs: Date.now() - startedAt,
            timeoutMs,
            pollIntervalMs: intervalMs,
            upstreamStatus: status,
            urlCount: 0,
            responseKeys: getResponseKeys(json),
            errorCode: failure.code,
            errorMessage: failure.message,
            isCompleted: false,
            isFailed: true,
            isPending: false,
          });
          const error = new Error(failure.message);
          error.code = failure.code;
          error.providerErrorCode = error.code;
          error.isTerminalProviderFailure = true;
          error.responseBody = json;
          error.providerStatus = status;
          throw getSafeAPIMartError(error, { ...context, model, taskType, providerStatus: status });
        }

        if (isSuccessStatus(status) && !urls.length) {
          logger.warn('[ImageGeneration] polling completed without image url', {
            ...getSafeAPIMartLogContext(context, {
              model,
              taskType,
              providerTaskId: taskId,
              timeoutMs,
              elapsedMs: Date.now() - startedAt,
              providerStatus: status,
              responseBody: json,
              finalImageCount: 0,
            }),
            model,
            taskType,
            taskIdMasked: maskTaskId(taskId),
            pollCount,
            elapsedMs: Date.now() - startedAt,
            timeoutMs,
            pollIntervalMs: intervalMs,
            upstreamStatus: status,
            urlCount: 0,
            responseKeys: getResponseKeys(json),
            isCompleted: true,
            isFailed: false,
            isPending: false,
          });
          lastError = new Error('APIMart task completed but returned no image URL');
          lastError.responseBody = json;
          lastError.providerStatus = status;
        }
      } catch (error) {
        if (error.isTerminalProviderFailure) {
          throw error;
        }
        lastError = getSafeAPIMartError(error, { ...context, model, taskType });
      }
    }

    const elapsedMs = Date.now() - startedAt;
    if (
      elapsedMs - lastProgressLogAt >= POLLING_PROGRESS_LOG_INTERVAL_MS ||
      lastProgressLogAt === 0
    ) {
      logger.info('[ImageGeneration] polling in progress', {
        ...getSafeAPIMartLogContext(context, {
          model,
          taskType,
          providerTaskId: taskId,
          timeoutMs,
          elapsedMs,
          providerStatus: lastPollSummary.upstreamStatus,
          finalImageCount: lastPollSummary.urlCount,
        }),
        model,
        taskType,
        taskIdMasked: maskTaskId(taskId),
        pollCount,
        elapsedMs,
        timeoutMs,
        pollIntervalMs: intervalMs,
        upstreamStatus: lastPollSummary.upstreamStatus,
        urlCount: lastPollSummary.urlCount,
        responseKeys: lastPollSummary.responseKeys,
        isCompleted: lastPollSummary.isCompleted,
        isFailed: lastPollSummary.isFailed,
        isPending: lastPollSummary.isPending,
      });
      lastProgressLogAt = elapsedMs;
    }

    await sleep(intervalMs, signal);
  }

  logger.warn('[ImageGeneration] polling timeout', {
    ...getSafeAPIMartLogContext(context, {
      model,
      taskType,
      providerTaskId: taskId,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      providerStatus: lastPollSummary.upstreamStatus || 'IN_PROGRESS',
      errorCode: lastError?.providerCode || lastError?.code,
      finalImageCount: lastPollSummary.urlCount,
    }),
    model,
    taskType,
    taskIdMasked: maskTaskId(taskId),
    pollCount,
    elapsedMs: Date.now() - startedAt,
    timeoutMs,
    pollIntervalMs: intervalMs,
    upstreamStatus: lastPollSummary.upstreamStatus,
    urlCount: lastPollSummary.urlCount,
    responseKeys: lastPollSummary.responseKeys,
    isCompleted: lastPollSummary.isCompleted,
    isFailed: lastPollSummary.isFailed,
    isPending: lastPollSummary.isPending,
    lastError: sanitizeErrorMessage(lastError?.message),
  });

  const error = new Error('生成超时，不代表模型失败。请稍后重试或更换模型。');
  error.code = 'IMAGE_GENERATION_TIMEOUT';
  error.lastError = lastError?.message;
  error.timeoutMs = timeoutMs;
  error.durationMs = Date.now() - startedAt;
  error.providerStatus = lastPollSummary.upstreamStatus || 'IN_PROGRESS';
  throw getSafeAPIMartError(error, {
    ...context,
    model,
    taskType,
    providerStatus: error.providerStatus,
  });
}

async function submitImageTask(payload, context = {}) {
  const submitTimeoutMs = getSubmitTimeoutMs();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), submitTimeoutMs);
  const abortHandler = () => controller.abort();
  context.signal?.addEventListener('abort', abortHandler, { once: true });
  const logContext = getLogContext(payload, context);

  logger.info('[ImageGeneration] APIMart submit started', {
    ...logContext,
    submitTimeoutMs,
  });

  try {
    const json = await postJSON('/images/generations', payload, { signal: controller.signal });
    const taskId = findTaskId(json);
    const immediateURLs = collectResultURLs(json);
    const submitDurationMs = Date.now() - startedAt;

    logger.info('[ImageGeneration] APIMart submit completed', {
      ...logContext,
      submitTimeoutMs,
      submitDurationMs,
      hasTaskId: Boolean(taskId),
      taskIdMasked: maskTaskId(taskId),
      hasImmediateUrl: Boolean(immediateURLs.length),
      urlCount: immediateURLs.length,
      responseKeys: getResponseKeys(json),
    });

    if (taskId && typeof context.onProviderTaskSubmitted === 'function') {
      await context.onProviderTaskSubmitted({
        providerTaskId: taskId,
        providerStatus: getStatus(json) || 'IN_PROGRESS',
      });
    }

    return {
      json,
      taskId,
      resultUrl: immediateURLs[0] || null,
      cost: getCost(json),
      responseKeys: getResponseKeys(json),
    };
  } catch (error) {
    const isAbort = error?.name === 'AbortError';
    const submitDurationMs = Date.now() - startedAt;
    const safeError = getSafeAPIMartError(error, {
      ...context,
      model: payload.model || context.model,
    });

    logger.error('[ImageGeneration] APIMart submit failed', {
      ...logContext,
      submitTimeoutMs,
      submitDurationMs,
      errorName: error?.name || null,
      errorCode:
        safeError?.providerCode ||
        (isAbort ? 'APIMART_IMAGE_SUBMIT_TIMEOUT' : error?.code || error?.statusCode || null),
      statusCode: safeError?.statusCode || error?.statusCode || null,
      isAbort,
      errorMessage: sanitizeErrorMessage(safeError?.safeMessage || error?.message),
    });

    if (isAbort) {
      const timeoutError = new Error('APIMart image task submit timed out');
      timeoutError.code = 'APIMART_IMAGE_SUBMIT_TIMEOUT';
      timeoutError.statusCode = 504;
      timeoutError.timeoutMs = submitTimeoutMs;
      timeoutError.durationMs = submitDurationMs;
      throw getSafeAPIMartError(timeoutError, {
        ...context,
        model: payload.model || context.model,
      });
    }

    throw safeError;
  } finally {
    clearTimeout(timeout);
    context.signal?.removeEventListener('abort', abortHandler);
  }
}

module.exports = {
  GPT_IMAGE_2_NO_IMAGE_MESSAGE,
  GPT_IMAGE_2_TIMEOUT_MESSAGE,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  MODEL_TIMEOUT_MS,
  MAX_TASK_TIMEOUT_MS,
  SUBMIT_TIMEOUT_MS,
  TASK_TIMEOUT_MS,
  collectResultURLs,
  getAPIMartConfig,
  getEnvTimeoutMs,
  getModelTimeoutMs,
  getSafeAPIMartError,
  getSafeAPIMartLogContext,
  getSubmitTimeoutMs,
  maskKey,
  maskTaskId,
  pollTask,
  readAPIMartTaskStatus,
  submitImageTask,
};
