const { logger } = require('@librechat/data-schemas');
const { uploadAPIMartImages, createAPIMartImageTiming } = require('@librechat/api');
const {
  getAPIMartConfig,
  getModelTimeoutMs,
  getSafeAPIMartError,
  getSafeAPIMartLogContext,
  pollTask,
  submitImageTask,
} = require('./common');

const MODEL = 'gpt-image-2';

function buildPayload({ prompt, imageInputs = [], size, imageSize, count = 1, resolution }) {
  const requestedSize = size || imageSize || '1024x1024';
  const payload = {
    model: MODEL,
    prompt,
    n: count,
    size: requestedSize,
    resolution: resolution || '1K',
    official_fallback: false,
  };

  if (imageInputs.length) {
    payload.image_urls = imageInputs;
  }

  return payload;
}

async function generateImage(request) {
  const timing = createAPIMartImageTiming({
    taskId: request.internalTaskId,
    log: (message) => logger.info(message),
  });
  const imageInputs = request.imageInputs?.length
    ? await uploadAPIMartImages({
        imageInputs: request.imageInputs,
        timing,
        ...getAPIMartConfig(),
        signal: request.signal,
      })
    : [];
  const payload = buildPayload({ ...request, imageInputs });
  const context = {
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
  const submitted = await timing.measure('submit', () => submitImageTask(payload, context), {
    imageCount: imageInputs.length,
  });

  if (submitted.resultUrl) {
    logger.info('[ImageGeneration] APIMart GPT Image 2 final parsed', {
      ...getSafeAPIMartLogContext(context, {
        result: submitted.json,
        finalImageCount: 1,
      }),
      source: 'submit',
    });
    return { ...submitted, model: MODEL, provider: 'apimart', payload };
  }

  if (!submitted.taskId) {
    const error = new Error('APIMart did not return task_id');
    error.responseBody = submitted.json;
    throw getSafeAPIMartError(error, context);
  }

  try {
    const timeoutMs = getModelTimeoutMs(MODEL, request.taskType);
    const completed = await pollTask({
      taskId: submitted.taskId,
      timeoutMs,
      model: MODEL,
      taskType: request.taskType,
      context: {
        ...context,
        providerTaskId: submitted.taskId,
        timeoutMs,
      },
      signal: request.signal,
    });
    logger.info('[ImageGeneration] APIMart GPT Image 2 final parsed', {
      ...getSafeAPIMartLogContext(
        {
          ...context,
          providerTaskId: submitted.taskId,
          timeoutMs,
        },
        {
          result: completed.json,
          providerStatus: completed.status,
          finalImageCount: completed.resultUrl ? 1 : 0,
        },
      ),
      source: 'poll',
    });
    return { ...submitted, ...completed, model: MODEL, provider: 'apimart', payload };
  } catch (error) {
    error.providerTaskId = submitted.taskId;
    error.submitResponseKeys = submitted.responseKeys;
    throw getSafeAPIMartError(error, {
      ...context,
      providerTaskId: submitted.taskId,
      timeoutMs: getModelTimeoutMs(MODEL, request.taskType),
    });
  }
}

async function resumeImageTask(request) {
  const providerTaskId = request.providerTaskId || request.taskId;
  if (!providerTaskId) {
    const error = new Error('APIMart GPT Image 2 providerTaskId is required to resume polling');
    error.statusCode = 400;
    throw error;
  }

  const context = {
    provider: 'apimart',
    model: MODEL,
    modelKey: request.modelKey || null,
    batchId: request.batchId || null,
    itemId: request.itemId || null,
    taskType: request.taskType || null,
    promptLength: typeof request.prompt === 'string' ? request.prompt.length : null,
    providerTaskId,
    onProviderStatusChanged: request.onProviderStatusChanged,
    onProviderPoll: request.onProviderPoll,
    signal: request.signal,
  };

  try {
    const timeoutMs = getModelTimeoutMs(MODEL, request.taskType);
    const completed = await pollTask({
      taskId: providerTaskId,
      timeoutMs,
      model: MODEL,
      taskType: request.taskType,
      context: {
        ...context,
        timeoutMs,
      },
      signal: request.signal,
    });
    logger.info('[ImageGeneration] APIMart GPT Image 2 resumed final parsed', {
      ...getSafeAPIMartLogContext(
        {
          ...context,
          timeoutMs,
        },
        {
          result: completed.json,
          providerStatus: completed.status,
          finalImageCount: completed.resultUrl ? 1 : 0,
        },
      ),
      source: 'poll_resume',
    });
    return { taskId: providerTaskId, ...completed, model: MODEL, provider: 'apimart' };
  } catch (error) {
    error.providerTaskId = providerTaskId;
    throw getSafeAPIMartError(error, {
      ...context,
      timeoutMs: getModelTimeoutMs(MODEL, request.taskType),
    });
  }
}

module.exports = {
  MODEL,
  buildPayload,
  generateImage,
  resumeImageTask,
};
