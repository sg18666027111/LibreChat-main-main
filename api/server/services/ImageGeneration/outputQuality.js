const OUTPUT_QUALITY_LEVELS = ['standard', 'hd', 'ultra'];
const { isFlareModel } = require('./adapters/fal/openaiGptImage25Flare');
const DEFAULT_OUTPUT_QUALITY = 'hd';

const OUTPUT_QUALITY_OPTIONS = [
  { value: 'standard', label: '标准', description: '速度更快' },
  { value: 'hd', label: '高清', description: '更清晰，推荐' },
  { value: 'ultra', label: '超清', description: '更清晰，但生成更慢' },
];

const STANDARD_SIZE_BY_ASPECT_RATIO = {
  '1:1': '1024x1024',
  '3:4': '768x1024',
  '4:5': '832x1040',
  '16:9': '1344x768',
  '9:16': '768x1344',
};

const HD_SIZE_BY_ASPECT_RATIO = {
  '1:1': '1280x1280',
  '3:4': '960x1280',
  '4:5': '1024x1280',
  '16:9': '1600x900',
  '9:16': '900x1600',
};

const ULTRA_SIZE_BY_ASPECT_RATIO = {
  '1:1': '2048x2048',
  '3:4': '1536x2048',
  '4:5': '1600x2000',
  '16:9': '2048x1152',
  '9:16': '1152x2048',
};

const SEEDREAM_STANDARD_SIZE_BY_ASPECT_RATIO = {
  '1:1': '1024x1024',
  '3:4': '960x1280',
  '4:5': '1024x1280',
  '16:9': '1280x720',
  '9:16': '720x1280',
};

const SEEDREAM_HD_SIZE_BY_ASPECT_RATIO = {
  '1:1': '1280x1280',
  '3:4': '1200x1600',
  '4:5': '1280x1600',
  '16:9': '1600x900',
  '9:16': '900x1600',
};

const SIZE_MAPS_BY_QUALITY = {
  standard: STANDARD_SIZE_BY_ASPECT_RATIO,
  hd: HD_SIZE_BY_ASPECT_RATIO,
  ultra: ULTRA_SIZE_BY_ASPECT_RATIO,
};

const FAL_GPT_IMAGE_2_TEXT_SIZE_MAPS_BY_QUALITY = {
  standard: STANDARD_SIZE_BY_ASPECT_RATIO,
  hd: {
    ...HD_SIZE_BY_ASPECT_RATIO,
    '16:9': '1536x864',
    '9:16': '864x1536',
  },
  ultra: ULTRA_SIZE_BY_ASPECT_RATIO,
};

const SEEDREAM_SIZE_MAPS_BY_QUALITY = {
  standard: SEEDREAM_STANDARD_SIZE_BY_ASPECT_RATIO,
  hd: SEEDREAM_HD_SIZE_BY_ASPECT_RATIO,
  ultra: ULTRA_SIZE_BY_ASPECT_RATIO,
};

const RESOLUTION_BY_QUALITY = {
  standard: '1K',
  hd: '2K',
  ultra: '4K',
};

function normalizeOutputQuality(value) {
  return OUTPUT_QUALITY_LEVELS.includes(value) ? value : DEFAULT_OUTPUT_QUALITY;
}

function parseSize(size) {
  const match = /^(\d+)x(\d+)$/i.exec(size || '');
  if (!match) {
    return { width: null, height: null };
  }

  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function getSizeForAspectRatio(sizeMap, aspectRatio, fallbackSize) {
  return sizeMap[aspectRatio] || fallbackSize || sizeMap['1:1'];
}

function isSeedreamModel({ provider, model }) {
  return provider === 'ark' && model === 'doubao-seedream-5-0-pro-260628';
}

function isAPIMartGPTImage2({ provider, model }) {
  return provider === 'apimart' && model === 'gpt-image-2';
}

function isFalGPTImage2Text({ provider, model }) {
  return provider === 'fal' && model === 'openai/gpt-image-2';
}

function isAPIMartGPTImage25({ provider, model }) {
  return (
    provider === 'apimart' && ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'].includes(model)
  );
}

function supportsExplicitSize({ provider, model }) {
  if (provider === 'siliconflow') {
    return true;
  }
  if (isSeedreamModel({ provider, model })) {
    return true;
  }
  if (isAPIMartGPTImage2({ provider, model }) || isAPIMartGPTImage25({ provider, model })) {
    return true;
  }
  if (
    provider === 'fal' &&
    (model === 'openai/gpt-image-2' || model === 'openai/gpt-image-2/edit' || isFlareModel(model))
  ) {
    return true;
  }
  return false;
}

function resolveSingleImageOutputQuality({
  outputQuality,
  aspectRatio = '1:1',
  provider,
  model,
  fallbackSize,
}) {
  const requestedOutputQuality = normalizeOutputQuality(outputQuality);

  if (!supportsExplicitSize({ provider, model })) {
    const size =
      fallbackSize ||
      STANDARD_SIZE_BY_ASPECT_RATIO[aspectRatio] ||
      STANDARD_SIZE_BY_ASPECT_RATIO['1:1'];
    const { width, height } = parseSize(size);
    return {
      requestedOutputQuality,
      effectiveOutputQuality: 'standard',
      size,
      imageSize: size,
      width,
      height,
      resolution: null,
      downgraded: requestedOutputQuality !== 'standard',
    };
  }

  let sizeMaps = SIZE_MAPS_BY_QUALITY;
  if (isSeedreamModel({ provider, model })) {
    sizeMaps = SEEDREAM_SIZE_MAPS_BY_QUALITY;
  } else if (
    isFalGPTImage2Text({ provider, model }) ||
    isAPIMartGPTImage25({ provider, model }) ||
    (provider === 'fal' && isFlareModel(model))
  ) {
    sizeMaps = FAL_GPT_IMAGE_2_TEXT_SIZE_MAPS_BY_QUALITY;
  }
  const size = getSizeForAspectRatio(
    sizeMaps[requestedOutputQuality] || sizeMaps[DEFAULT_OUTPUT_QUALITY],
    aspectRatio,
    fallbackSize,
  );
  const { width, height } = parseSize(size);

  return {
    requestedOutputQuality,
    effectiveOutputQuality: requestedOutputQuality,
    size,
    imageSize: size,
    width,
    height,
    resolution: isAPIMartGPTImage2({ provider, model })
      ? RESOLUTION_BY_QUALITY[requestedOutputQuality]
      : null,
    downgraded: false,
  };
}

module.exports = {
  DEFAULT_OUTPUT_QUALITY,
  OUTPUT_QUALITY_LEVELS,
  OUTPUT_QUALITY_OPTIONS,
  normalizeOutputQuality,
  resolveSingleImageOutputQuality,
};
