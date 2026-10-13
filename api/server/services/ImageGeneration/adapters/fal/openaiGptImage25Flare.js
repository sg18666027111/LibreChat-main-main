const { getFalImageSize } = require('./openaiGptImage2Edit');

const TEXT_MODEL = 'openai/gpt-image-2.5/flare/text-to-image';
const EDIT_MODEL = 'openai/gpt-image-2.5/flare/edit';

function isFlareModel(model) {
  return model === TEXT_MODEL || model === EDIT_MODEL;
}

function buildTextPayload({ prompt, aspectRatio, size, imageSize, count = 1 }) {
  if (count !== 1) {
    const error = new Error('GPT Image 2.5 Flare（FAL）当前仅支持生成 1 张。');
    error.statusCode = 400;
    error.code = 'IMAGE_MODEL_COUNT_UNSUPPORTED';
    throw error;
  }
  return {
    prompt,
    image_size: getFalImageSize({ aspectRatio, size, imageSize }),
    quality: 'medium',
    num_images: 1,
    output_format: 'png',
  };
}

function buildEditPayload(request) {
  const payload = buildTextPayload(request);
  const images = request.imageInputs || [];
  if (!images.length || images.length > 16) {
    const error = new Error('FAL Flare 改图需要 1 至 16 张输入图。');
    error.statusCode = 400;
    error.code = 'FAL_BAD_REQUEST';
    throw error;
  }
  return { ...payload, image_urls: images };
}

module.exports = { TEXT_MODEL, EDIT_MODEL, isFlareModel, buildTextPayload, buildEditPayload };
