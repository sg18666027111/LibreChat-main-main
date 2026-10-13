const {
  getImageGenerationTextModels,
  getImageGenerationEditModels,
  MODEL_REGISTRY,
  resolveImageGenerationModel,
} = require('./models');

describe('fal Flare choices', () => {
  test.each([
    ['fal_gpt_image_2_5_flare_text', 'text-to-image', 'text-to-image'],
    ['fal_gpt_image_2_5_flare_edit', 'single-image-edit', 'edit'],
    ['fal_gpt_image_2_5_flare_edit', 'multi-reference', 'edit'],
  ])('resolves %s for %s with one output', (modelKey, taskType, endpoint) => {
    expect(resolveImageGenerationModel({ modelKey, taskType })).toMatchObject({
      provider: 'fal',
      model: `openai/gpt-image-2.5/flare/${endpoint}`,
      supportedCounts: [1],
      asyncOnly: true,
    });
  });

  test('exposes distinct text and edit choices without changing defaults', () => {
    expect(getImageGenerationTextModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'fal_gpt_image_2_5_flare_text', supportedCounts: [1] }),
      ]),
    );
    expect(getImageGenerationEditModels({ includeAsyncOnly: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'fal_gpt_image_2_5_flare_edit',
          label: 'GPT Image 2.5 Flare（FAL）',
        }),
      ]),
    );
    expect(resolveImageGenerationModel({}).modelKey).toBe('apimart_gpt_image_2');
  });
});

describe('optional Sunburst editing model', () => {
  test('resolves its own key for both edit capabilities without replacing the default', () => {
    for (const taskType of ['single-image-edit', 'multi-reference']) {
      expect(
        resolveImageGenerationModel({ modelKey: 'apimart_gpt_image_2_5_sunburst', taskType }),
      ).toMatchObject({ provider: 'apimart', model: 'gpt-image-2.5-sunburst' });
    }
    expect(resolveImageGenerationModel({})).toMatchObject({
      modelKey: 'apimart_gpt_image_2',
      model: 'gpt-image-2',
    });
    expect(getImageGenerationEditModels().map((m) => m.value)).toContain(
      'apimart_gpt_image_2_5_sunburst',
    );
  });

  test('does not expose Sunburst in text generation', () => {
    expect(() =>
      resolveImageGenerationModel({
        modelKey: 'apimart_gpt_image_2_5_sunburst',
        taskType: 'text-to-image',
      }),
    ).toThrow();
    expect(getImageGenerationTextModels().map((m) => m.value)).not.toContain(
      'apimart_gpt_image_2_5_sunburst',
    );
  });
});

describe('retired image models cannot start new generations', () => {
  test.each([
    ['apimart_gemini_3_1_flash', 'gemini-3.1-flash-image-preview'],
    ['apimart_gemini_2_5_flash', 'gemini-2.5-flash-image-preview'],
    ['fal_grok_imagine_image_edit', 'xai/grok-imagine-image/edit'],
    ['fal_nano_banana_pro', 'fal-ai/nano-banana-pro'],
  ])('rejects both the old key and provider ID for %s', (modelKey, model) => {
    for (const selection of [{ modelKey }, { model }]) {
      expect(() => resolveImageGenerationModel(selection)).toThrow();
    }
    expect(
      getImageGenerationEditModels({ includeAsyncOnly: true }).map((entry) => entry.modelKey),
    ).not.toContain(modelKey);
  });

  test('does not silently charge the default model for an unknown explicit model ID', () => {
    expect(() => resolveImageGenerationModel({ model: 'retired-model-id' })).toThrow();
    expect(resolveImageGenerationModel({})).toMatchObject({ modelKey: 'apimart_gpt_image_2' });
  });
});

describe('GPT Image 2 scoped text cutover boundary', () => {
  test('keeps the global registry and image-edit resolution on APIMart', () => {
    expect(MODEL_REGISTRY.apimart_gpt_image_2_text).toMatchObject({
      provider: 'apimart',
      model: 'gpt-image-2',
      capabilities: ['text-to-image'],
    });
    expect(
      resolveImageGenerationModel({
        modelKey: 'apimart_gpt_image_2',
        taskType: 'single-image-edit',
      }),
    ).toMatchObject({
      provider: 'apimart',
      model: 'gpt-image-2',
    });
    expect(MODEL_REGISTRY.fal_gpt_image_2_edit).toMatchObject({
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
    });
  });
});

describe('ImageGeneration Seedream model registry', () => {
  const modelKey = 'ark_seedream_5_0_t2i';
  const providerModelId = 'doubao-seedream-5-0-pro-260628';

  test('registers Seedream 5.0 Pro with the Pro provider model id and supported capabilities', () => {
    const config = MODEL_REGISTRY[modelKey];

    expect(config).toMatchObject({
      label: '火山方舟 Seedream 5.0 Pro',
      provider: 'ark',
      model: providerModelId,
    });
    expect(config.capabilities).toEqual(
      expect.arrayContaining(['text-to-image', 'single-image-edit', 'multi-reference']),
    );
  });

  test('resolves Seedream 5.0 Pro for text, single-image, and multi-reference generation', () => {
    for (const taskType of ['text-to-image', 'single-image-edit', 'multi-reference']) {
      expect(resolveImageGenerationModel({ modelKey, taskType })).toMatchObject({
        modelKey,
        provider: 'ark',
        model: providerModelId,
      });
    }
  });

  test('does not keep the old Seedream 5.0 provider model id in new model configuration', () => {
    const oldProviderModelId = ['doubao', 'seedream', '5', '0', '260128'].join('-');
    expect(JSON.stringify(MODEL_REGISTRY)).not.toContain(oldProviderModelId);
  });
});

describe('optional Flare text model', () => {
  test('resolves Flare for text generation while retaining existing defaults and editing choices', () => {
    expect(
      resolveImageGenerationModel({
        modelKey: 'apimart_gpt_image_2_5_flare',
        taskType: 'text-to-image',
      }),
    ).toMatchObject({ provider: 'apimart', model: 'gpt-image-2.5-flare' });
    expect(getImageGenerationTextModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'apimart_gpt_image_2_5_flare',
          label: 'GPT Image 2.5 Flare',
        }),
      ]),
    );
    expect(
      getImageGenerationEditModels().some((x) => x.value === 'apimart_gpt_image_2_5_flare'),
    ).toBe(false);
    expect(() =>
      resolveImageGenerationModel({
        modelKey: 'apimart_gpt_image_2_5_flare',
        taskType: 'single-image-edit',
      }),
    ).toThrow();
    expect(resolveImageGenerationModel({})).toMatchObject({ modelKey: 'apimart_gpt_image_2' });
  });
});
