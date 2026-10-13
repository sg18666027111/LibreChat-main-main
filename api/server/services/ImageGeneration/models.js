const DEFAULT_MODEL_KEY = 'apimart_gpt_image_2';

const LEGACY_MODE_MAP = {
  high_quality: 'apimart_gpt_image_2',
  backup: 'fal_gpt_image_2_edit',
};

const MODEL_REGISTRY = {
  apimart_gpt_image_2_text: {
    label: 'GPT Image 2',
    provider: 'apimart',
    model: 'gpt-image-2',
    capabilities: ['text-to-image'],
    description: '适合高质量商品图、营销海报、创意视觉、文字排版',
  },
  apimart_gpt_image_2: {
    label: 'GPT Image 2（APIMart）',
    provider: 'apimart',
    model: 'gpt-image-2',
    capabilities: ['single-image-edit', 'multi-reference'],
  },
  apimart_gpt_image_2_5_flare: {
    label: 'GPT Image 2.5 Flare',
    provider: 'apimart',
    model: 'gpt-image-2.5-flare',
    capabilities: ['text-to-image'],
    description: '文生图模型，按生成数量和尺寸计费',
  },
  apimart_gpt_image_2_5_sunburst: {
    label: 'GPT Image 2.5 Sunburst',
    provider: 'apimart',
    model: 'gpt-image-2.5-sunburst',
    capabilities: ['single-image-edit', 'multi-reference'],
    description: '编辑模型，费用较高',
  },
  fal_gpt_image_2_edit: {
    label: 'GPT Image 2 Edit（FAL）',
    provider: 'fal',
    model: 'openai/gpt-image-2/edit',
    capabilities: ['single-image-edit', 'multi-reference'],
  },
  fal_gpt_image_2_5_flare_text: {
    label: 'GPT Image 2.5 Flare（FAL）',
    provider: 'fal',
    model: 'openai/gpt-image-2.5/flare/text-to-image',
    capabilities: ['text-to-image'],
    supportedCounts: [1],
    asyncOnly: true,
    description: '每次生成 1 张，支持批量任务',
  },
  fal_gpt_image_2_5_flare_edit: {
    label: 'GPT Image 2.5 Flare（FAL）',
    provider: 'fal',
    model: 'openai/gpt-image-2.5/flare/edit',
    capabilities: ['single-image-edit', 'multi-reference'],
    supportedCounts: [1],
    asyncOnly: true,
  },
  ark_seedream_5_0_t2i: {
    label: '火山方舟 Seedream 5.0 Pro',
    provider: 'ark',
    model: 'doubao-seedream-5-0-pro-260628',
    capabilities: ['text-to-image', 'single-image-edit', 'multi-reference'],
    description: '火山方舟 Seedream 5.0 Pro，支持文生图、图生图和多图参考生成',
  },
};

function getImageGenerationEditModels({ includeAsyncOnly = false } = {}) {
  return Object.entries(MODEL_REGISTRY)
    .filter(([, config]) => includeAsyncOnly || !config.asyncOnly)
    .filter(([, config]) =>
      config.capabilities.some((capability) =>
        ['single-image-edit', 'multi-reference'].includes(capability),
      ),
    )
    .sort(([, a], [, b]) => Number(b.provider === 'fal') - Number(a.provider === 'fal'))
    .map(([value, config]) => ({
      value,
      modelKey: value,
      label: config.label,
      name: config.label,
      provider: config.provider,
      model: config.model,
      capabilities: config.capabilities,
      description: config.description,
      asyncOnly: Boolean(config.asyncOnly),
      supportedCounts: config.supportedCounts,
    }));
}

function getImageGenerationTextModels() {
  return Object.entries(MODEL_REGISTRY)
    .filter(([, config]) => config.capabilities.includes('text-to-image'))
    .map(([value, config]) => ({
      value,
      modelKey: value,
      label: config.label,
      name: config.label,
      provider: config.provider,
      model: config.model,
      capabilities: config.capabilities,
      description: config.description,
      supportedCounts: config.supportedCounts,
      asyncOnly: Boolean(config.asyncOnly),
    }));
}

function resolveModelKeyFromModel(model) {
  if (!model) {
    return null;
  }

  const entry = Object.entries(MODEL_REGISTRY).find(([, config]) => config.model === model);
  return entry?.[0] || null;
}

function resolveImageGenerationModel({ modelKey, model, mode, taskType }) {
  const normalizedModelKey =
    modelKey ||
    LEGACY_MODE_MAP[mode] ||
    (model ? resolveModelKeyFromModel(model) : DEFAULT_MODEL_KEY);
  const config = MODEL_REGISTRY[normalizedModelKey];

  if (!config) {
    const error = new Error(`不支持的生图模型：${normalizedModelKey || model}`);
    error.statusCode = 400;
    error.code = 'IMAGE_MODEL_UNSUPPORTED';
    throw error;
  }

  if (taskType && !config.capabilities.includes(taskType)) {
    const error = new Error(`${config.label}暂不支持当前任务类型。`);
    error.statusCode = 400;
    error.code = 'IMAGE_MODEL_CAPABILITY_UNSUPPORTED';
    throw error;
  }

  return {
    modelKey: normalizedModelKey,
    label: config.label,
    provider: config.provider,
    model: config.model,
    capabilities: config.capabilities,
    asyncOnly: Boolean(config.asyncOnly),
    supportedCounts: config.supportedCounts,
  };
}

module.exports = {
  DEFAULT_MODEL_KEY,
  LEGACY_MODE_MAP,
  MODEL_REGISTRY,
  getImageGenerationEditModels,
  getImageGenerationTextModels,
  resolveImageGenerationModel,
  resolveModelKeyFromModel,
};
