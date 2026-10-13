const common = require('./common');
const openaiGptImage2Edit = require('./openaiGptImage2Edit');
const grokImagineImageEdit = require('./grokImagineImageEdit');
const nanoBananaPro = require('./nanoBananaPro');
const flare = require('./openaiGptImage25Flare');

const modelAdapters = {
  [flare.TEXT_MODEL]: { buildPayload: flare.buildTextPayload },
  [flare.EDIT_MODEL]: { buildPayload: flare.buildEditPayload },
  [openaiGptImage2Edit.TEXT_MODEL]: { buildPayload: openaiGptImage2Edit.buildTextPayload },
  [openaiGptImage2Edit.MODEL]: openaiGptImage2Edit,
  [grokImagineImageEdit.MODEL]: grokImagineImageEdit,
  [nanoBananaPro.MODEL]: nanoBananaPro,
};

function createFalImageEgressAdapter({ model }) {
  const modelAdapter = modelAdapters[model];
  if (!modelAdapter) {
    const error = new Error(`不支持的 fal 图像模型：${model}`);
    error.statusCode = 400;
    error.code = 'FAL_MODEL_UNSUPPORTED';
    throw error;
  }

  return {
    ...(model === openaiGptImage2Edit.MODEL || model === flare.EDIT_MODEL
      ? {
          async prepare({ request, signal }) {
            modelAdapter.buildPayload(request);
            const imageInputs = request.imageInputs || [];
            if (imageInputs.reduce((bytes, value) => bytes + value.length, 0) <= 32 * 1024) {
              return request;
            }
            const { uploadFalImages } = require('@librechat/api');
            const { apiKey } = common.getFalConfig();
            return {
              ...request,
              imageInputs: await uploadFalImages({ imageInputs, apiKey, signal }),
            };
          },
        }
      : {}),
    async submit({ request, signal, onDiagnostic }) {
      let payload;
      try {
        payload = modelAdapter.buildPayload(request);
      } catch (error) {
        error.submitOutcome = 'definitely_not_submitted';
        throw error;
      }
      return common.submitFalQueueTask({
        model,
        payload,
        signal,
        ...(onDiagnostic ? { onDiagnostic } : {}),
      });
    },

    async status({ providerTaskId, providerMetadata = {}, signal }) {
      return common.readFalQueueStatus({
        model,
        providerTaskId,
        statusUrl: providerMetadata.statusUrl,
        signal,
      });
    },

    async result({ providerTaskId, providerMetadata = {}, signal }) {
      return common.readFalQueueResult({
        model,
        providerTaskId,
        responseUrl: providerMetadata.responseUrl,
        signal,
      });
    },
  };
}

module.exports = { createFalImageEgressAdapter };
