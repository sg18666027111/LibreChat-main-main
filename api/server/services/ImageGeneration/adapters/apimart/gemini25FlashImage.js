const { getModelTimeoutMs, pollTask, submitImageTask } = require('./common');

const MODEL = 'gemini-2.5-flash-image-preview';

function buildPayload({ prompt, imageInputs = [], size, imageSize, aspectRatio }) {
  const payload = {
    model: MODEL,
    prompt,
    n: 1,
    size: aspectRatio || size || imageSize || 'auto',
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
