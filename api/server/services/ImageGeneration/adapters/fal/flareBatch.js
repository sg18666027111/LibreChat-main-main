const { setTimeout: delay } = require('node:timers/promises');
const { createFalImageEgressAdapter } = require('./imageEgressFalAdapter');
const { getFalTimeoutMs, getFalPollIntervalMs } = require('./common');

// Batch persistence owns the queue identity and usage; this waiter never records usage.
async function waitForFlareBatchResult({
  model,
  providerTaskId,
  providerMetadata,
  onProviderPoll,
}) {
  const adapter = createFalImageEgressAdapter({ model });
  const deadline = Date.now() + getFalTimeoutMs();
  const signal = AbortSignal.timeout(getFalTimeoutMs());
  try {
    while (Date.now() < deadline) {
      const status = await adapter.status({ providerTaskId, providerMetadata, signal });
      await onProviderPoll?.(status);
      if (status.state === 'failed') {
        throw Object.assign(new Error('FAL 图像生成失败，请稍后重试。'), {
          code: 'FAL_TASK_FAILED',
          providerStatus: status.providerStatus,
          retryMode: 'resubmit_provider',
        });
      }
      if (status.state === 'succeeded') {
        const result = await adapter.result({ providerTaskId, providerMetadata, signal });
        return { images: result.outputUrls.map((url) => ({ url })), taskId: providerTaskId };
      }
      await delay(getFalPollIntervalMs(), undefined, { signal });
    }
    throw new Error('FAL 任务仍在处理中，稍后将继续查询。');
  } catch (error) {
    const permanentReadFailure =
      error.code === 'FAL_NO_IMAGE' ||
      (error.providerResponseParsed &&
        error.statusCode >= 400 &&
        error.statusCode < 500 &&
        ![408, 409, 425, 429].includes(error.statusCode));
    if (permanentReadFailure) {
      // Show an actionable failure, retaining the paid task for explicit read-only retry.
      error.retryMode = 'resume_polling';
    } else if (error.code !== 'FAL_TASK_FAILED' && error.code !== 'BATCH_TASK_STATE_CONFLICT') {
      // A read failure or a local timeout cannot authorize another paid submission.
      error.code = 'FAL_BATCH_WAIT_INTERRUPTED';
      error.retryMode = 'resume_polling';
    }
    throw error;
  }
}

async function generateFlareBatchImage(request) {
  const adapter = createFalImageEgressAdapter({ model: request.model });
  const signal = AbortSignal.timeout(getFalTimeoutMs());
  let prepared = request;
  try {
    if (adapter.prepare) prepared = await adapter.prepare({ request, signal });
  } catch (error) {
    error.submitOutcome = 'definitely_not_submitted';
    throw error;
  }
  const submitted = await adapter.submit({ request: prepared, signal });
  await request.onProviderTaskSubmitted(submitted);
  if (submitted.outputUrls?.length) {
    return {
      images: submitted.outputUrls.map((url) => ({ url })),
      taskId: submitted.providerTaskId,
    };
  }
  return waitForFlareBatchResult({
    model: request.model,
    providerTaskId: submitted.providerTaskId,
    providerMetadata: submitted.providerMetadata,
    onProviderPoll: request.onProviderPoll,
  });
}

module.exports = { generateFlareBatchImage, waitForFlareBatchResult };
