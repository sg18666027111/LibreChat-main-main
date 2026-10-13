const sharp = require('sharp');
const {
  downloadProviderResult,
} = require('~/server/services/ImageGeneration/providerResultDownload');

const MIME_TYPE_BY_FORMAT = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function createImageOutputError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 502;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function parseDataUri(value) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value || '');
  if (!match) {
    return null;
  }
  return Buffer.from(match[2].replace(/\s/g, ''), 'base64');
}

async function fetchImageBuffer(url, { fetchImpl, isRemoteUrlAllowed }) {
  if (typeof isRemoteUrlAllowed === 'function' && !isRemoteUrlAllowed(url)) {
    throw createImageOutputError('生成图片来源不被允许。', 'IMAGE_OUTPUT_SOURCE_NOT_ALLOWED');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw createImageOutputError(
        `生成图片下载失败（HTTP ${response.status}）。`,
        'IMAGE_OUTPUT_FETCH_FAILED',
      );
    }
    return { buffer: Buffer.from(await response.arrayBuffer()) };
  } catch (error) {
    if (error?.code === 'IMAGE_OUTPUT_FETCH_FAILED') {
      throw error;
    }
    throw createImageOutputError('生成图片下载失败。', 'IMAGE_OUTPUT_FETCH_FAILED', error);
  } finally {
    clearTimeout(timeout);
  }
}

async function getImageBuffer(image, options) {
  if (Buffer.isBuffer(image)) {
    return { buffer: image };
  }
  if (Buffer.isBuffer(image?.buffer)) {
    return { buffer: image.buffer };
  }

  const dataUri =
    (typeof image === 'string' && image.startsWith('data:') && image) ||
    (typeof image?.b64_json === 'string' && image.b64_json) ||
    null;
  if (dataUri) {
    const buffer = parseDataUri(dataUri);
    if (buffer?.length) {
      return { buffer };
    }
    throw createImageOutputError('生成图片 Base64 数据无效。', 'IMAGE_OUTPUT_INVALID');
  }

  const url =
    (typeof image === 'string' && /^https?:\/\//i.test(image) && image) ||
    image?.url ||
    image?.imageUrl ||
    image?.image_url ||
    image?.resultUrl ||
    null;
  if (url) {
    if (
      options.sourceContext?.sourceType === 'provider_result' &&
      options.sourceContext?.provider === 'apimart'
    ) {
      const result = await downloadProviderResult({
        url,
        provider: options.sourceContext.provider,
      });
      return {
        buffer: result.buffer,
        sourceHostname: result.hostname,
        redirectHostnames: result.redirectHostnames,
      };
    }
    return fetchImageBuffer(url, options);
  }

  throw createImageOutputError('生成结果中没有可读取的图片。', 'IMAGE_OUTPUT_MISSING');
}

async function normalizeGeneratedImageOutput({
  image,
  targetWidth,
  targetHeight,
  fetchImpl = global.fetch,
  isRemoteUrlAllowed,
  sourceContext,
  onProgress,
}) {
  if (
    !Number.isInteger(targetWidth) ||
    targetWidth <= 0 ||
    !Number.isInteger(targetHeight) ||
    targetHeight <= 0
  ) {
    throw new TypeError('targetWidth and targetHeight must be positive integers');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }

  await onProgress?.('download_started');
  const source = await getImageBuffer(image, { fetchImpl, isRemoteUrlAllowed, sourceContext });
  await onProgress?.('download_completed');
  const { buffer } = source;
  await onProgress?.('normalization_started');
  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (error) {
    throw createImageOutputError('生成图片损坏或格式不受支持。', 'IMAGE_OUTPUT_INVALID', error);
  }

  const originalWidth = Number(metadata.width);
  const originalHeight = Number(metadata.height);
  const mimeType = MIME_TYPE_BY_FORMAT[metadata.format];
  if (!Number.isFinite(originalWidth) || !Number.isFinite(originalHeight) || !mimeType) {
    throw createImageOutputError('无法识别生成图片的真实尺寸或格式。', 'IMAGE_OUTPUT_INVALID');
  }

  if (originalWidth === targetWidth && originalHeight === targetHeight && !metadata.orientation) {
    await onProgress?.('normalization_completed');
    return {
      buffer,
      width: originalWidth,
      height: originalHeight,
      mimeType,
      normalized: false,
      originalWidth,
      originalHeight,
      sourceHostname: source.sourceHostname || null,
      redirectHostnames: source.redirectHostnames || [],
    };
  }

  let normalizedOutput;
  try {
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize(targetWidth, targetHeight, {
        fit: 'cover',
        position: sharp.strategy.attention,
      })
      .toBuffer({ resolveWithObject: true });
    const outputMimeType = MIME_TYPE_BY_FORMAT[info.format];
    if (!outputMimeType) {
      throw new Error(`Unsupported output format: ${info.format}`);
    }
    normalizedOutput = {
      buffer: data,
      width: info.width,
      height: info.height,
      mimeType: outputMimeType,
      normalized: true,
      originalWidth,
      originalHeight,
      sourceHostname: source.sourceHostname || null,
      redirectHostnames: source.redirectHostnames || [],
    };
  } catch (error) {
    throw createImageOutputError('生成图片标准化失败。', 'IMAGE_OUTPUT_NORMALIZE_FAILED', error);
  }
  await onProgress?.('normalization_completed');
  return normalizedOutput;
}

async function normalizeGeneratedImageResult({
  result,
  targetWidth,
  targetHeight,
  fetchImpl = global.fetch,
  isRemoteUrlAllowed,
  sourceContext,
}) {
  let sourceImages = [];
  if (Array.isArray(result?.images) && result.images.length) {
    sourceImages = result.images;
  } else if (result?.resultUrl) {
    sourceImages = [{ url: result.resultUrl }];
  }

  const images = await Promise.all(
    sourceImages.map(async (sourceImage) => {
      const output = await normalizeGeneratedImageOutput({
        image: sourceImage,
        targetWidth,
        targetHeight,
        fetchImpl,
        isRemoteUrlAllowed,
        sourceContext,
      });
      return {
        buffer: output.buffer,
        url: null,
        b64_json: null,
        width: output.width,
        height: output.height,
        originalWidth: output.originalWidth,
        originalHeight: output.originalHeight,
        normalized: output.normalized,
        contentType: output.mimeType,
        originalUrl: sourceImage?.url || result?.resultUrl || null,
        sourceHostname: output.sourceHostname,
        redirectHostnames: output.redirectHostnames,
      };
    }),
  );

  return { ...result, images };
}

module.exports = {
  MIME_TYPE_BY_FORMAT,
  normalizeGeneratedImageOutput,
  normalizeGeneratedImageResult,
};
