const { pollFalResult, submitFalTask } = require('./common');

const MODEL = 'fal-ai/nano-banana-pro';

function buildPayload({ prompt, count = 1, aspectRatio = '1:1' }) {
  return {
    prompt,
    num_images: count,
    aspect_ratio: aspectRatio,
    resolution: '1K',
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
