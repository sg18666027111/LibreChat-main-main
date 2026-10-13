const seedream = require('./seedream');

const adapters = {
  [seedream.MODEL]: seedream,
};

const ARK_IMAGE_MODELS = Object.keys(adapters);

function getAdapter(model) {
  const adapter = adapters[model];
  if (!adapter) {
    const error = new Error(`不支持的火山方舟图像模型：${model}`);
    error.statusCode = 400;
    error.code = 'ARK_MODEL_UNSUPPORTED';
    throw error;
  }

  return adapter;
}

async function generateArkImage(request) {
  const adapter = getAdapter(request.model);
  return adapter.generateImage(request);
}

module.exports = {
  ARK_IMAGE_MODELS,
  generateArkImage,
  getAdapter,
};
