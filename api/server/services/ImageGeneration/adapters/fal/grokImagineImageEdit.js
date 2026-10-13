const { pollFalResult, submitFalTask } = require('./common');

const MODEL = 'xai/grok-imagine-image/edit';

function buildPayload({ prompt, imageInputs = [], aspectRatio, isBatchMainImage = false }) {
  if (!imageInputs.length) {
    const error = new Error('Grok 单图改图需要至少 1 张输入图。');
    error.statusCode = 400;
    error.code = 'FAL_BAD_REQUEST';
    throw error;
  }

  return {
    prompt,
    image_urls: imageInputs,
    num_images: 1,
    aspect_ratio: isBatchMainImage
      ? aspectRatio || process.env.FAL_GROK_ASPECT_RATIO || '1:1'
      : process.env.FAL_GROK_ASPECT_RATIO || aspectRatio || '1:1',
    resolution: process.env.FAL_GROK_RESOLUTION || '1k',
    output_format: process.env.FAL_GROK_OUTPUT_FORMAT || 'jpeg',
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
  buildPayload,
  generateImage,
};
