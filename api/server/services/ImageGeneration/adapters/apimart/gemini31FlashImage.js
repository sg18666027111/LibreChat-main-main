const { getModelTimeoutMs, pollTask, submitImageTask } = require('./common');

const MODEL = 'gemini-3.1-flash-image-preview';

function toGeminiSize(size) {
  const sizeMap = {
    '1024x1024': '1:1',
    '768x1024': '3:4',
    '832x1040': '4:5',
    '1344x768': '16:9',
    '768x1344': '9:16',
  };

  return sizeMap[size] || size || '1:1';
}

function buildPayload({ prompt, imageInputs = [], size, imageSize, aspectRatio }) {
  const payload = {
    model: MODEL,
    prompt,
    n: 1,
    size: aspectRatio || toGeminiSize(size || imageSize || '1024x1024'),
    resolution: '1K',
  };

  if (imageInputs.length) {
    payload.image_urls = imageInputs;
  }

  return payload;
}

async function generateImage(request) {
  const payload = buildPayload(request);
  const submitted = await submitImageTask(payload, {
    model: MODEL,
    modelKey: request.modelKey || null,
    batchId: request.batchId || null,
    itemId: request.itemId || null,
    taskType: request.taskType || null,
    promptLength: typeof request.prompt === 'string' ? request.prompt.length : null,
    onProviderTaskSubmitted: request.onProviderTaskSubmitted,
    onProviderStatusChanged: request.onProviderStatusChanged,
    onProviderPoll: request.onProviderPoll,
    signal: request.signal,
  });

  if (submitted.resultUrl) {
    return { ...submitted, model: MODEL, provider: 'apimart', payload };
  }

  if (!submitted.taskId) {
    const error = new Error('APIMart did not return task_id');
    error.responseBody = submitted.json;
    throw error;
  }

  try {
    const completed = await pollTask({
      taskId: submitted.taskId,
      timeoutMs: getModelTimeoutMs(MODEL),
      signal: request.signal,
    });
    return { ...submitted, ...completed, model: MODEL, provider: 'apimart', payload };
  } catch (error) {
    error.providerTaskId = submitted.taskId;
    error.submitResponseKeys = submitted.responseKeys;
    throw error;
  }
}

module.exports = {
  MODEL,
  buildPayload,
  generateImage,
};
