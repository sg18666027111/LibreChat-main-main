const { logger } = require('@librechat/data-schemas');

const SILICONFLOW_IMAGE_URL = 'https://api.siliconflow.cn/v1/images/generations';
const TEXT_TO_IMAGE_MODEL = 'Qwen/Qwen-Image';
const IMAGE_TO_IMAGE_MODEL = 'Qwen/Qwen-Image-Edit-2509';

function normalizeBase64(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  return value.startsWith('data:') ? value : `data:image/png;base64,${value}`;
}

function normalizeImage(item) {
  if (typeof item === 'string') {
    if (item.startsWith('http')) {
      return { url: item, b64_json: null };
    }

    return { url: null, b64_json: normalizeBase64(item) };
  }

  if (!item || typeof item !== 'object') {
    return null;
  }

  const b64 = item.b64_json ?? item.base64 ?? item.image ?? null;
  return {
    url: item.url ?? null,
    b64_json: normalizeBase64(b64),
  };
}

function collectImages(responseJson) {
  if (Array.isArray(responseJson?.data)) {
    return responseJson.data.map(normalizeImage).filter((image) => image?.url || image?.b64_json);
  }

  if (Array.isArray(responseJson?.images)) {
    return responseJson.images.map(normalizeImage).filter((image) => image?.url || image?.b64_json);
  }

  return [];
}

function getImageResponseSource(responseJson) {
  if (Array.isArray(responseJson?.data) && responseJson.data.length) {
    const first = responseJson.data[0];
    if (typeof first === 'string') {
      return first.startsWith('http') ? 'data[0].url' : 'data[0].base64';
    }

    if (first?.url) {
      return 'data[0].url';
    }

    if (first?.b64_json || first?.base64 || first?.image) {
      return 'data[0].base64';
    }

    return 'data[0]';
  }

  if (Array.isArray(responseJson?.images) && responseJson.images.length) {
    const first = responseJson.images[0];
    if (typeof first === 'string') {
      return first.startsWith('http') ? 'images[0].url' : 'images[0].base64';
    }

    if (first?.url) {
      return 'images[0].url';
    }

    if (first?.b64_json || first?.base64 || first?.image) {
      return 'images[0].base64';
    }

    return 'images[0]';
  }

  return 'unknown';
}

async function generateTextToImage({ prompt, negativePrompt, size, count }) {
  const apiKey = process.env.SILICONFLOW_API_KEY;

  if (!apiKey) {
    const error = new Error('SILICONFLOW_API_KEY is not configured');
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(SILICONFLOW_IMAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TEXT_TO_IMAGE_MODEL,
      prompt,
      negative_prompt: negativePrompt,
      n: count,
      size,
    }),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    logger.error('[ImageGeneration] Failed to parse SiliconFlow response', error);
  }

  if (!response.ok) {
    const message = json?.error?.message || json?.message || text || 'SiliconFlow image generation failed';
    const error = new Error(message);
    error.statusCode = response.status;
    throw error;
  }

  const images = collectImages(json);
  if (!images.length) {
    const error = new Error('SiliconFlow returned no image URL or base64 image data');
    error.statusCode = 502;
    throw error;
  }

  return {
    images,
    rawKeys: json ? Object.keys(json) : [],
    responseSource: getImageResponseSource(json),
  };
}

async function generateImageToImage({ image, prompt, negativePrompt, size, count, timeoutMs }) {
  const apiKey = process.env.SILICONFLOW_API_KEY;

  if (!apiKey) {
    const error = new Error('SILICONFLOW_API_KEY is not configured');
    error.statusCode = 500;
    error.code = 'SILICONFLOW_API_KEY_MISSING';
    throw error;
  }

  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetch(SILICONFLOW_IMAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: IMAGE_TO_IMAGE_MODEL,
        image,
        prompt,
        negative_prompt: negativePrompt,
        n: count,
        size,
      }),
      signal: controller?.signal,
    });
  } catch (error) {
    if (controller?.signal.aborted) {
      const timeoutError = new Error('SiliconFlow image edit timed out');
      timeoutError.statusCode = 504;
      timeoutError.code = 'IMAGE_GENERATION_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    logger.error('[ImageGeneration] Failed to parse SiliconFlow image edit response', error);
  }

  if (!response.ok) {
    const message = json?.error?.message || json?.message || text || 'SiliconFlow image edit failed';
    const error = new Error(message);
    error.statusCode = response.status;
    if (response.status === 401 || response.status === 403) {
      error.code = 'SILICONFLOW_AUTH_FAILED';
    }
    throw error;
  }

  const images = collectImages(json);
  if (!images.length) {
    const error = new Error('SiliconFlow returned no image URL or base64 image data');
    error.statusCode = 502;
    throw error;
  }

  return {
    images,
    rawKeys: json ? Object.keys(json) : [],
    responseSource: getImageResponseSource(json),
  };
}

module.exports = {
  TEXT_TO_IMAGE_MODEL,
  IMAGE_TO_IMAGE_MODEL,
  generateTextToImage,
  generateImageToImage,
};
