const { uploadAPIMartImages } = require('@librechat/api');
const {
  collectResultURLs,
  getAPIMartConfig,
  getModelTimeoutMs,
  getSafeAPIMartError,
  pollTask,
  submitImageTask,
} = require('./common');

function createGPTImage25Adapter(MODEL, label) {
  function buildPayload({ prompt, imageInputs = [], size, imageSize, count = 1 }) {
    const requestedSize = size || imageSize || '1024x1024';
    const match = /^(\d+)x(\d+)$/.exec(requestedSize);
    const width = Number(match?.[1]);
    const height = Number(match?.[2]);
    if (
      !match ||
      !width ||
      !height ||
      width % 16 ||
      height % 16 ||
      Math.max(width, height) > 3840 ||
      Math.max(width, height) / Math.min(width, height) > 3 ||
      width * height < 655360 ||
      width * height > 8294400
    ) {
      throw Object.assign(new Error(`当前图片尺寸不受 ${label} 支持。`), {
        code: 'APIMART_IMAGE_INVALID_SIZE',
        statusCode: 400,
        submittedToProvider: false,
      });
    }
    // Explicit pixels determine resolution. Keep quality at the evaluated medium setting.
    return {
      model: MODEL,
      prompt,
      n: count,
      size: requestedSize,
      quality: 'medium',
      ...(imageInputs.length ? { image_urls: imageInputs } : {}),
    };
  }

  function getContext(request) {
    return {
      provider: 'apimart',
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
    };
  }

  async function resumeImageTask(request) {
    const providerTaskId = request.providerTaskId || request.taskId;
    if (!providerTaskId) {
      throw Object.assign(new Error('APIMart providerTaskId is required to resume polling'), {
        statusCode: 400,
      });
    }
    const timeoutMs = getModelTimeoutMs(MODEL, request.taskType);
    const context = { ...getContext(request), providerTaskId, timeoutMs };
    try {
      const completed = await pollTask({
        taskId: providerTaskId,
        timeoutMs,
        model: MODEL,
        taskType: request.taskType,
        context,
        signal: request.signal,
      });
      return {
        taskId: providerTaskId,
        ...completed,
        images: collectResultURLs(completed.json).map((url) => ({ url })),
        model: MODEL,
        provider: 'apimart',
      };
    } catch (error) {
      error.providerTaskId = providerTaskId;
      throw getSafeAPIMartError(error, context);
    }
  }

  async function generateImage(request) {
    // Validate before uploading inputs or submitting a billable generation.
    const payload = buildPayload(request);
    if (request.imageInputs?.length) {
      payload.image_urls = await uploadAPIMartImages({
        imageInputs: request.imageInputs,
        ...getAPIMartConfig(),
        signal: request.signal,
      });
    }
    const context = getContext(request);
    const submitted = await submitImageTask(payload, context);
    if (submitted.resultUrl) {
      return {
        ...submitted,
        images: collectResultURLs(submitted.json).map((url) => ({ url })),
        model: MODEL,
        provider: 'apimart',
        payload,
      };
    }
    if (!submitted.taskId) {
      const error = Object.assign(new Error('APIMart did not return task_id'), {
        responseBody: submitted.json,
      });
      throw getSafeAPIMartError(error, context);
    }
    try {
      const completed = await resumeImageTask({ ...request, providerTaskId: submitted.taskId });
      return { ...submitted, ...completed, payload };
    } catch (error) {
      error.submitResponseKeys = submitted.responseKeys;
      throw error;
    }
  }

  return { MODEL, buildPayload, generateImage, resumeImageTask };
}

module.exports = { createGPTImage25Adapter };
