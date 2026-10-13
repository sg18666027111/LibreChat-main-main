const gptImage25Flare = require('./gptImage25Flare');
const gptImage2 = require('./gptImage2');
const gptImage25Sunburst = require('./gptImage25Sunburst');
const gemini31FlashImage = require('./gemini31FlashImage');
const gemini25FlashImage = require('./gemini25FlashImage');
const { createAPIMartGeminiImageEgressAdapter } = require('./imageEgressGeminiAdapter');

const adapters = {
  [gptImage25Flare.MODEL]: gptImage25Flare,
  [gptImage2.MODEL]: gptImage2,
  [gptImage25Sunburst.MODEL]: gptImage25Sunburst,
  [gemini31FlashImage.MODEL]: gemini31FlashImage,
  [gemini25FlashImage.MODEL]: gemini25FlashImage,
};

const APIMART_IMAGE_MODELS = Object.keys(adapters);

function getAdapter(model) {
  const adapter = adapters[model];
  if (!adapter) {
    const error = new Error(`不支持的 APIMart 图像模型：${model}`);
    error.statusCode = 400;
    throw error;
  }

  return adapter;
}

async function generateAPIMartImage(request) {
  const adapter = getAdapter(request.model);
  return adapter.generateImage(request);
}

async function resumeAPIMartImage(request) {
  const adapter = getAdapter(request.model);
  if (typeof adapter.resumeImageTask !== 'function') {
    const error = new Error(`APIMart 图像模型不支持恢复轮询：${request.model}`);
    error.statusCode = 400;
    throw error;
  }
  return adapter.resumeImageTask(request);
}

module.exports = {
  APIMART_IMAGE_MODELS,
  createAPIMartGeminiImageEgressAdapter,
  generateAPIMartImage,
  getAdapter,
  resumeAPIMartImage,
};
