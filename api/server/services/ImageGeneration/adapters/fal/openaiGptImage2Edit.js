const { pollFalResult, submitFalTask } = require('./common');

const MODEL = 'openai/gpt-image-2/edit';
const TEXT_MODEL = 'openai/gpt-image-2';
const QUALITY_BY_OUTPUT_QUALITY = Object.freeze({
  standard: 'low',
  hd: 'medium',
  ultra: 'high',
});

const SQUARE_ALIASES = new Set(['1:1', '1x1', 'square', 'square_hd', '1024x1024']);

function parseImageSize(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function getFalImageSize({ aspectRatio, size, imageSize }) {
  const normalizedAspectRatio =
    typeof aspectRatio === 'string' ? aspectRatio.trim().toLowerCase() : '';
  const requestedSize = size || imageSize;
  const normalizedRequestedSize =
    typeof requestedSize === 'string' ? requestedSize.trim().toLowerCase() : '';

  const explicitDimensions = parseImageSize(requestedSize);
  if (explicitDimensions) {
    if (SQUARE_ALIASES.has(normalizedRequestedSize)) {
      return 'square_hd';
    }
    return explicitDimensions;
  }

  if (SQUARE_ALIASES.has(normalizedAspectRatio) || SQUARE_ALIASES.has(normalizedRequestedSize)) {
    return 'square_hd';
  }

  return requestedSize || process.env.FAL_IMAGE_SIZE || 'auto';
}

function buildPayload({ prompt, imageInputs = [], aspectRatio, size, imageSize }) {
  if (!imageInputs.length) {
    const error = new Error('FAL 改图需要至少 1 张输入图。');
    error.statusCode = 400;
    error.code = 'FAL_BAD_REQUEST';
    throw error;
  }

  return {
    prompt,
    image_urls: imageInputs,
    quality: process.env.FAL_IMAGE_QUALITY || 'medium',
    image_size: getFalImageSize({ aspectRatio, size, imageSize }),
  };
}

function buildTextPayload({ prompt, aspectRatio, size, imageSize, outputQuality, count = 1 }) {
  if (count !== 1) {
    const error = new Error('GPT Image 2 文生图当前仅支持生成 1 张。');
    error.statusCode = 400;
    error.code = 'IMAGE_MODEL_COUNT_UNSUPPORTED';
    throw error;
  }

  return {
    prompt,
    image_size: getFalImageSize({ aspectRatio, size, imageSize }),
    quality: QUALITY_BY_OUTPUT_QUALITY[outputQuality] || QUALITY_BY_OUTPUT_QUALITY.hd,
    num_images: 1,
    output_format: 'png',
  };
}

async function generateImage(request) {
  const payload = buildPayload(request);
  const submitted = await submitFalTask({ model: MODEL, payload, signal: request.signal });
  const completed = await pollFalResult({
    model: MODEL,
    submitResponse: submitted,
    signal: request.signal,
  });

  return {
    ...completed,
    model: MODEL,
    provider: 'fal',
    taskId: completed.taskId || submitted.request_id || submitted.requestId || submitted.id || null,
  };
}

module.exports = {
  MODEL,
  TEXT_MODEL,
  buildPayload,
  buildTextPayload,
  getFalImageSize,
  generateImage,
};
