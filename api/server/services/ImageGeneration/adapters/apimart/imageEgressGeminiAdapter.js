const common = require('./common');
const gemini31FlashImage = require('./gemini31FlashImage');
const gemini25FlashImage = require('./gemini25FlashImage');

const modelAdapters = {
  [gemini31FlashImage.MODEL]: gemini31FlashImage,
  [gemini25FlashImage.MODEL]: gemini25FlashImage,
};

function createAPIMartGeminiImageEgressAdapter({ model }) {
  const modelAdapter = modelAdapters[model];
  if (!modelAdapter) {
    const error = new Error(`不支持的 APIMart Gemini 图像模型：${model}`);
    error.code = 'APIMART_GEMINI_MODEL_UNSUPPORTED';
    error.statusCode = 400;
    throw error;
  }

  return {
    async submit({ request, signal }) {
      let payload;
      try {
        payload = modelAdapter.buildPayload(request);
      } catch (error) {
        error.submitOutcome = 'definitely_not_submitted';
        throw error;
      }
      let submitted;
      try {
        submitted = await common.submitImageTask(payload, {
          model,
          modelKey: request.modelKey || null,
          batchId: request.batchId || null,
          itemId: request.itemId || null,
          taskType: request.taskType || null,
          promptLength: typeof request.prompt === 'string' ? request.prompt.length : null,
          signal,
        });
      } catch (error) {
        if (!error?.statusCode && error?.code !== 'APIMART_IMAGE_SUBMIT_TIMEOUT') {
          error.code = 'APIMART_SUBMIT_TRANSPORT_ERROR';
        }
        let submitOutcome = 'unknown';
        const statusCode = Number(error?.statusCode);
        const isExplicitClientRejection =
          error.providerResponseParsed &&
          statusCode >= 400 &&
          statusCode < 500 &&
          ![408, 409, 425, 429].includes(statusCode);
        if (error.code === 'APIMART_CONFIG_MISSING') {
          submitOutcome = 'definitely_not_submitted';
        } else if (isExplicitClientRejection) {
          submitOutcome = 'rejected';
        }
        error.submitOutcome = submitOutcome;
        throw error;
      }
      return {
        providerTaskId: submitted.taskId || null,
        providerMetadata: {
          responseKeys: submitted.responseKeys || [],
          ...(submitted.cost == null ? {} : { cost: submitted.cost }),
        },
        outputUrls: submitted.resultUrl ? [submitted.resultUrl] : [],
      };
    },

    status({ providerTaskId, signal }) {
      return common.readAPIMartTaskStatus({ taskId: providerTaskId, signal });
    },
  };
}

module.exports = { createAPIMartGeminiImageEgressAdapter };
