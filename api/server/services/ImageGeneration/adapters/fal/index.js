const openaiGptImage2Edit = require('./openaiGptImage2Edit');
const grokImagineImageEdit = require('./grokImagineImageEdit');
const nanoBananaPro = require('./nanoBananaPro');
const { createFalImageEgressAdapter } = require('./imageEgressFalAdapter');

const adapters = {
  [openaiGptImage2Edit.MODEL]: openaiGptImage2Edit,
  [grokImagineImageEdit.MODEL]: grokImagineImageEdit,
  [nanoBananaPro.MODEL]: nanoBananaPro,
};

const FAL_IMAGE_MODELS = Object.keys(adapters);

function getAdapter(model) {
  const adapter = adapters[model];
  if (!adapter) {
    const error = new Error(`不支持的 fal 图像模型：${model}`);
    error.statusCode = 400;
    error.code = 'FAL_MODEL_UNSUPPORTED';
    throw error;
  }

  return adapter;
}

async function generateFalImage(request) {
  const adapter = getAdapter(request.model);
  return adapter.generateImage(request);
}

module.exports = {
  FAL_IMAGE_MODELS,
  createFalImageEgressAdapter,
  generateFalImage,
  getAdapter,
};
