const { logger } = require('@librechat/data-schemas');

const MODEL = 'doubao-seedream-5-0-pro-260628';
const ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const DEFAULT_TIMEOUT_MS = 300000;
const BATCH_MAIN_IMAGE_SIZE = '1024x1024';
const SEEDREAM_SIZE_BY_ASPECT_RATIO = {
  '1:1': '1024x1024',
  '3:4': '960x1280',
  '4:5': '1024x1280',
  '4:3': '1280x960',
  '16:9': '1280x720',
  '9:16': '720x1280',
};
const LEGACY_SIZE_TO_ASPECT_RATIO = {
  '1024x1024': '1:1',
  '768x1024': '3:4',
  '832x1040': '4:5',
  '1344x768': '16:9',
  '768x1344': '9:16',
};

function getPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getTimeoutMs() {
  return getPositiveIntegerEnv('ARK_IMAGE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}

function getEnvironmentFlags() {
  return {
    hasARK_API_KEY: Boolean(process.env.ARK_API_KEY),
    hasARK_IMAGE_TIMEOUT_MS: Boolean(process.env.ARK_IMAGE_TIMEOUT_MS),
  };
}

function getArkApiKey() {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    const error = new Error('ARK_API_KEY is not configured');
    error.statusCode = 500;
    error.code = 'ARK_API_KEY_MISSING';
    throw error;
  }
  return apiKey;
}

function createAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError('Seedream request aborted locally');
  }
}

function getResponseKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

function getResponseShapeSummary(value) {
  return {
    responseKeys: getResponseKeys(value),
    dataCount: Array.isArray(value?.data) ? value.data.length : null,
    imagesCount: Array.isArray(value?.images) ? value.images.length : null,
    resultImagesCount: Array.isArray(value?.result?.images) ? value.result.images.length : null,
    outputCount: Array.isArray(value?.output) ? value.output.length : null,
    hasDataUrl: Boolean(value?.data?.some?.((item) => Boolean(item?.url))),
    hasDataB64Json: Boolean(value?.data?.some?.((item) => Boolean(item?.b64_json))),
    hasImagesUrl: Boolean(value?.images?.some?.((item) => Boolean(item?.url))),
    hasImagesB64Json: Boolean(value?.images?.some?.((item) => Boolean(item?.b64_json))),
    hasResultImagesUrl: Boolean(value?.result?.images?.some?.((item) => Boolean(item?.url))),
    hasOutputUrl: Boolean(value?.output?.some?.((item) => Boolean(item?.url))),
  };
}

function sanitizeMessage(message) {
  if (typeof message !== 'string') {
    return null;
  }
  return (
    message
      .replace(/https?:\/\/\S+/gi, '[url]')
      .replace(/data:image\/[^\s"')]+/gi, '[image-data]')
      .slice(0, 240) || null
  );
}

function createArkError(code, statusCode, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.errorName = options.errorName || null;
  error.safeMessage = options.safeMessage || sanitizeMessage(message);
  return error;
}

function normalizeArkErrorCode(statusCode, fallback = 'ARK_UNKNOWN') {
  if (statusCode === 400) {
    return 'ARK_BAD_REQUEST';
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'ARK_HTTP_401';
  }
  if (statusCode === 404) {
    return 'ARK_HTTP_404';
  }
  return statusCode ? `ARK_HTTP_${statusCode}` : fallback;
}

function getErrorSummary(json, text) {
  const candidates = [
    json?.error?.message,
    json?.error?.code,
    json?.message,
    json?.msg,
    text,
  ];
  const summary = candidates.find((value) => typeof value === 'string' && value.trim());
  return sanitizeMessage(summary);
}

function getProviderRequestId(response, json, safeMessage) {
  const headerRequestId =
    response?.headers?.get('x-request-id') ||
    response?.headers?.get('x-tt-logid') ||
    response?.headers?.get('x-tt-trace-id') ||
    response?.headers?.get('request-id') ||
    null;
  if (headerRequestId) {
    return sanitizeMessage(headerRequestId);
  }

  const jsonRequestId = json?.request_id || json?.requestId || json?.id || null;
  if (jsonRequestId) {
    return sanitizeMessage(String(jsonRequestId));
  }

  const match = typeof safeMessage === 'string' ? safeMessage.match(/Request id:\s*([A-Za-z0-9_-]+)/i) : null;
  return match?.[1] || null;
}

function getSafeClientMessage({ statusCode, providerErrorCode, safeMessage }) {
  const normalizedMessage = String(safeMessage || '').toLowerCase();
  const normalizedCode = String(providerErrorCode || '').toLowerCase();

  if (statusCode === 400 || normalizedMessage.includes('not valid') || normalizedMessage.includes('invalid')) {
    return 'Seedream 5.0 Pro 调用失败：参数不合法，请检查图片比例或尺寸。';
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'Seedream 5.0 Pro 调用失败：鉴权失败。';
  }
  if (statusCode === 404 || normalizedMessage.includes('model') || normalizedCode.includes('model')) {
    return 'Seedream 5.0 Pro 调用失败：模型不可用或模型 ID 错误。';
  }
  if (statusCode === 408 || statusCode === 504 || normalizedMessage.includes('timeout')) {
    return 'Seedream 5.0 Pro 调用超时，请稍后重试。';
  }
  if (
    statusCode === 402 ||
    statusCode === 429 ||
    normalizedMessage.includes('quota') ||
    normalizedMessage.includes('balance') ||
    normalizedMessage.includes('insufficient') ||
    normalizedMessage.includes('rate limit')
  ) {
    return 'Seedream 5.0 Pro 调用失败：余额不足或限流。';
  }
  if (
    normalizedMessage.includes('content') ||
    normalizedMessage.includes('safety') ||
    normalizedMessage.includes('audit') ||
    normalizedMessage.includes('risk')
  ) {
    return 'Seedream 5.0 Pro 调用失败：内容审核未通过。';
  }

  return 'Seedream 5.0 Pro 调用失败，请稍后重试。';
}

function collectImages(responseJson) {
  if (!responseJson || typeof responseJson !== 'object') {
    return [];
  }

  const data = Array.isArray(responseJson.data) ? responseJson.data : [];
  const images = Array.isArray(responseJson.images) ? responseJson.images : [];
  const resultImages = Array.isArray(responseJson.result?.images) ? responseJson.result.images : [];
  const output = Array.isArray(responseJson.output) ? responseJson.output : [];
  const candidates = [...data, ...images, ...resultImages, ...output];

  return candidates
    .map((item) => {
      if (typeof item === 'string') {
        return item.startsWith('http') || item.startsWith('data:image/')
          ? { url: item, b64_json: null }
          : { url: null, b64_json: item };
      }
      if (!item || typeof item !== 'object') {
        return null;
      }
      const url = item.url || item.image_url || item.imageUrl || null;
      const b64Json = item.b64_json || item.b64Json || item.base64 || null;
      return url || b64Json
        ? {
            url: url || null,
            b64_json: b64Json,
            revised_prompt: item.revised_prompt || null,
            width: Number.isFinite(Number(item.width)) ? Number(item.width) : null,
            height: Number.isFinite(Number(item.height)) ? Number(item.height) : null,
          }
        : null;
    })
    .filter(Boolean);
}

function getImageInputs(imageInputs) {
  return Array.isArray(imageInputs) ? imageInputs.filter(Boolean) : [];
}

function assertSupportedTask(taskType, imageInputs) {
  if (!taskType || taskType === 'text-to-image') {
    return;
  }

  if (taskType === 'single-image-edit') {
    if (!imageInputs.length) {
      throw createArkError('ARK_IMAGE_REQUIRED', 400, '火山方舟单图改图需要上传 1 张图片。', {
        safeMessage: 'image input required',
      });
    }
    return;
  }

  if (taskType === 'multi-reference') {
    if (!imageInputs.length) {
      throw createArkError('ARK_IMAGE_REQUIRED', 400, '火山方舟多图参考生成需要至少上传 1 张图片。', {
        safeMessage: 'image input required',
      });
    }
    return;
  }

  throw createArkError('ARK_TASK_UNSUPPORTED', 400, '火山方舟 Seedream 5.0 Pro 暂不支持当前任务类型。', {
    safeMessage: 'task type unsupported',
  });
}

function getRequestSize({
  size,
  imageSize,
  width,
  height,
  aspectRatio,
  outputQuality,
  isBatchMainImage = false,
}) {
  if (isBatchMainImage) {
    return BATCH_MAIN_IMAGE_SIZE;
  }
  if (outputQuality) {
    if (Number.isFinite(Number(width)) && Number.isFinite(Number(height))) {
      return `${Number(width)}x${Number(height)}`;
    }
    if (size || imageSize) {
      return size || imageSize;
    }
  }
  const resolvedAspectRatio = aspectRatio || LEGACY_SIZE_TO_ASPECT_RATIO[size || imageSize];
  if (SEEDREAM_SIZE_BY_ASPECT_RATIO[resolvedAspectRatio]) {
    return SEEDREAM_SIZE_BY_ASPECT_RATIO[resolvedAspectRatio];
  }
  if (Number.isFinite(Number(width)) && Number.isFinite(Number(height))) {
    return `${Number(width)}x${Number(height)}`;
  }
  return size || imageSize || '2K';
}

async function requestSingleImage({
  prompt,
  imageInputs = [],
  taskType = 'text-to-image',
  size,
  imageSize,
  width,
  height,
  aspectRatio,
  count = 1,
  outputQuality,
  isBatchMainImage = false,
  signal,
}) {
  const startedAt = Date.now();
  throwIfAborted(signal);
  let apiKey;
  try {
    apiKey = getArkApiKey();
  } catch (error) {
    logger.warn('[Seedream] configuration error', {
      provider: 'ark',
      model: MODEL,
      taskType,
      statusCode: error?.statusCode || 500,
      errorCode: error?.code || 'ARK_CONFIGURATION_ERROR',
      errorName: error?.errorName || error?.name || null,
      safeMessage: sanitizeMessage(error?.safeMessage || error?.message),
      durationMs: Date.now() - startedAt,
      elapsedMs: Date.now() - startedAt,
      isTimeout: false,
      ...getEnvironmentFlags(),
      responseKeys: [],
      urlCount: 0,
    });
    throw error;
  }
  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortHandler = () => controller.abort();
  signal?.addEventListener('abort', abortHandler, { once: true });
  const normalizedImageInputs = getImageInputs(imageInputs);
  assertSupportedTask(taskType, normalizedImageInputs);
  const responseFormat = 'url';
  const outputFormat = null;
  const payload = {
    model: MODEL,
    prompt,
    response_format: responseFormat,
    size: getRequestSize({
      size,
      imageSize,
      width,
      height,
      aspectRatio,
      outputQuality,
      isBatchMainImage,
    }),
    stream: false,
    watermark: false,
  };
  if (normalizedImageInputs.length === 1) {
    payload.image = normalizedImageInputs[0];
  } else if (normalizedImageInputs.length > 1) {
    payload.image = normalizedImageInputs;
  }
  logger.info('[Seedream] request sent', {
    provider: 'ark',
    providerAdapter: 'seedream',
    model: MODEL,
    endpoint: ENDPOINT,
    taskType,
    promptLength: typeof prompt === 'string' ? prompt.length : 0,
    outputCount: Math.max(1, Math.min(Number(count) || 1, 4)),
    outputQuality: outputQuality || null,
    aspectRatio: aspectRatio || null,
    timeoutMs,
    size: payload.size,
    imageSize: imageSize || null,
    responseFormat,
    outputFormat,
    requestedSize: size || imageSize || null,
    requestedWidth: Number.isFinite(Number(width)) ? Number(width) : null,
    requestedHeight: Number.isFinite(Number(height)) ? Number(height) : null,
    isBatchMainImage,
    inputImageCount: normalizedImageInputs.length,
    hasImageInput: Boolean(normalizedImageInputs.length),
  });

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      logger.warn('[Seedream] request failed', {
        provider: 'ark',
        providerAdapter: 'seedream',
        model: MODEL,
        endpoint: ENDPOINT,
        taskType,
        promptLength: typeof prompt === 'string' ? prompt.length : 0,
        outputCount: Math.max(1, Math.min(Number(count) || 1, 4)),
        aspectRatio: aspectRatio || null,
        size: payload.size,
        imageSize: imageSize || null,
        responseFormat,
        outputFormat,
        statusCode: 504,
        errorCode: 'ARK_TIMEOUT',
        errorName: error?.name || 'AbortError',
        safeMessage: 'request timed out',
        durationMs: Date.now() - startedAt,
        elapsedMs: Date.now() - startedAt,
        isTimeout: true,
        ...getEnvironmentFlags(),
        responseKeys: [],
        urlCount: 0,
      });
      throw createArkError('ARK_TIMEOUT', 504, '火山方舟生图请求超时，请稍后重试。', {
        errorName: error?.name || 'AbortError',
        safeMessage: 'Seedream 5.0 Pro 调用超时，请稍后重试。',
      });
    }
    logger.warn('[Seedream] request failed', {
      provider: 'ark',
      providerAdapter: 'seedream',
      model: MODEL,
      endpoint: ENDPOINT,
      taskType,
      promptLength: typeof prompt === 'string' ? prompt.length : 0,
      outputCount: Math.max(1, Math.min(Number(count) || 1, 4)),
      aspectRatio: aspectRatio || null,
      size: payload.size,
      imageSize: imageSize || null,
      responseFormat,
      outputFormat,
      statusCode: 502,
      errorCode: 'ARK_NETWORK_ERROR',
      errorName: error?.name || 'FetchError',
      safeMessage: sanitizeMessage(error?.message),
      durationMs: Date.now() - startedAt,
      elapsedMs: Date.now() - startedAt,
      isTimeout: false,
      ...getEnvironmentFlags(),
      responseKeys: [],
      urlCount: 0,
    });
    throw createArkError('ARK_NETWORK_ERROR', 502, '火山方舟生图请求失败，请稍后重试。', {
      errorName: error?.name || 'FetchError',
      safeMessage: 'Seedream 5.0 Pro 调用失败，请稍后重试。',
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortHandler);
  }

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    logger.warn('[Seedream] non-json response', {
      provider: 'ark',
      providerAdapter: 'seedream',
      model: MODEL,
      endpoint: ENDPOINT,
      taskType,
      promptLength: typeof prompt === 'string' ? prompt.length : 0,
      outputCount: Math.max(1, Math.min(Number(count) || 1, 4)),
      aspectRatio: aspectRatio || null,
      size: payload.size,
      imageSize: imageSize || null,
      responseFormat,
      outputFormat,
      statusCode: response.status,
      errorCode: 'ARK_NON_JSON_RESPONSE',
      errorName: null,
      safeMessage: sanitizeMessage(response.headers.get('content-type') || 'non-json response'),
      durationMs: Date.now() - startedAt,
      elapsedMs: Date.now() - startedAt,
      isTimeout: false,
      ...getEnvironmentFlags(),
      responseKeys: [],
      urlCount: 0,
      providerRequestId: getProviderRequestId(response, null, null),
      contentType: response.headers.get('content-type') || null,
    });
    throw createArkError('ARK_NON_JSON_RESPONSE', response.status, '火山方舟返回了非 JSON 响应。');
  }

  const responseShape = getResponseShapeSummary(json);
  const responseKeys = responseShape.responseKeys;
  if (!response.ok) {
    const safeMessage = getErrorSummary(json, text);
    const providerErrorCode = json?.error?.code || json?.code || null;
    const providerRequestId = getProviderRequestId(response, json, safeMessage);
    logger.warn('[Seedream] error if failed', {
      provider: 'ark',
      providerAdapter: 'seedream',
      model: MODEL,
      endpoint: ENDPOINT,
      taskType,
      promptLength: typeof prompt === 'string' ? prompt.length : 0,
      outputCount: Math.max(1, Math.min(Number(count) || 1, 4)),
      aspectRatio: aspectRatio || null,
      size: payload.size,
      imageSize: imageSize || null,
      responseFormat,
      outputFormat,
      statusCode: response.status,
      errorCode: normalizeArkErrorCode(response.status),
      providerErrorCode,
      providerErrorMessage: safeMessage,
      providerRequestId,
      errorName: providerErrorCode,
      safeMessage,
      durationMs: Date.now() - startedAt,
      elapsedMs: Date.now() - startedAt,
      isTimeout: false,
      ...getEnvironmentFlags(),
      responseShape,
      urlCount: 0,
      inputImageCount: normalizedImageInputs.length,
    });
    throw createArkError(
      normalizeArkErrorCode(response.status),
      response.status,
      '火山方舟生图失败，请稍后重试。',
      {
        errorName: providerErrorCode,
        safeMessage: getSafeClientMessage({
          statusCode: response.status,
          providerErrorCode,
          safeMessage,
        }),
      },
    );
  }

  const images = collectImages(json);
  const providerRequestId = getProviderRequestId(response, json, null);
  logger.info('[Seedream] response received', {
    provider: 'ark',
    providerAdapter: 'seedream',
    model: MODEL,
    endpoint: ENDPOINT,
    taskType,
    promptLength: typeof prompt === 'string' ? prompt.length : 0,
    outputCount: Math.max(1, Math.min(Number(count) || 1, 4)),
    aspectRatio: aspectRatio || null,
    size: payload.size,
    imageSize: imageSize || null,
    responseFormat,
    outputFormat,
    statusCode: response.status,
    providerRequestId,
    responseShape,
    urlCount: images.length,
    b64JsonCount: images.filter((image) => Boolean(image.b64_json)).length,
    durationMs: Date.now() - startedAt,
    elapsedMs: Date.now() - startedAt,
    inputImageCount: normalizedImageInputs.length,
  });

  if (!images.length) {
    logger.warn('[Seedream] no image returned', {
      provider: 'ark',
      providerAdapter: 'seedream',
      model: MODEL,
      endpoint: ENDPOINT,
      taskType,
      promptLength: typeof prompt === 'string' ? prompt.length : 0,
      outputCount: Math.max(1, Math.min(Number(count) || 1, 4)),
      aspectRatio: aspectRatio || null,
      size: payload.size,
      imageSize: imageSize || null,
      responseFormat,
      outputFormat,
      statusCode: 502,
      errorCode: 'ARK_NO_IMAGE',
      errorName: null,
      safeMessage: 'no image url returned',
      durationMs: Date.now() - startedAt,
      elapsedMs: Date.now() - startedAt,
      isTimeout: false,
      ...getEnvironmentFlags(),
      responseShape,
      urlCount: 0,
    });
    throw createArkError('ARK_NO_IMAGE', 502, '火山方舟未返回可用图片。', {
      safeMessage: 'no image url returned',
    });
  }

  return images;
}

async function generateImage(request) {
  const isSingleImageEdit = request?.taskType === 'single-image-edit';
  const count = isSingleImageEdit ? 1 : Math.max(1, Math.min(Number(request.count) || 1, 4));
  const images = [];

  for (let index = 0; index < count; index += 1) {
    const singleImages = await requestSingleImage(request);
    images.push(singleImages[0]);
  }

  return {
    images,
    model: MODEL,
    provider: 'ark',
    status: 'success',
  };
}

module.exports = {
  ENDPOINT,
  MODEL,
  collectImages,
  generateImage,
  getEnvironmentFlags,
};
