const {
  DEFAULT_OUTPUT_QUALITY,
  OUTPUT_QUALITY_OPTIONS,
  normalizeOutputQuality,
  resolveSingleImageOutputQuality,
} = require('./outputQuality');

describe('single image output quality mapping', () => {
  test.each([
    ['standard', '1:1', '1024x1024'],
    ['hd', '1:1', '1280x1280'],
    ['hd', '16:9', '1536x864'],
    ['hd', '9:16', '864x1536'],
    ['ultra', '1:1', '2048x2048'],
  ])('keeps Sunburst %s %s at a supported explicit size', (outputQuality, aspectRatio, size) => {
    expect(
      resolveSingleImageOutputQuality({
        outputQuality,
        aspectRatio,
        provider: 'apimart',
        model: 'gpt-image-2.5-sunburst',
      }),
    ).toMatchObject({
      size,
      imageSize: size,
      effectiveOutputQuality: outputQuality,
      downgraded: false,
    });
  });

  it('defaults to hd for omitted or invalid values', () => {
    expect(DEFAULT_OUTPUT_QUALITY).toBe('hd');
    expect(normalizeOutputQuality(undefined)).toBe('hd');
    expect(normalizeOutputQuality('fast')).toBe('hd');
  });

  it('keeps frontend-facing option copy stable', () => {
    expect(OUTPUT_QUALITY_OPTIONS).toEqual([
      { value: 'standard', label: '标准', description: '速度更快' },
      { value: 'hd', label: '高清', description: '更清晰，推荐' },
      { value: 'ultra', label: '超清', description: '更清晰，但生成更慢' },
    ]);
  });

  test.each([
    ['standard', '1024x1280'],
    ['hd', '1280x1600'],
    ['ultra', '1600x2000'],
  ])('maps Seedream 4:5 %s to a provider-safe size', (outputQuality, expectedSize) => {
    expect(
      resolveSingleImageOutputQuality({
        outputQuality,
        aspectRatio: '4:5',
        provider: 'ark',
        model: 'doubao-seedream-5-0-pro-260628',
        fallbackSize: '1024x1280',
      }),
    ).toMatchObject({
      requestedOutputQuality: outputQuality,
      effectiveOutputQuality: outputQuality,
      size: expectedSize,
      imageSize: expectedSize,
      downgraded: false,
    });
  });

  it('maps APIMart GPT Image 2 ultra to size and native resolution', () => {
    expect(
      resolveSingleImageOutputQuality({
        outputQuality: 'ultra',
        aspectRatio: '16:9',
        provider: 'apimart',
        model: 'gpt-image-2',
        fallbackSize: '1344x768',
      }),
    ).toMatchObject({
      size: '2048x1152',
      imageSize: '2048x1152',
      width: 2048,
      height: 1152,
      resolution: '4K',
      effectiveOutputQuality: 'ultra',
    });
  });

  it('maps Fal GPT Image 2 Edit hd to explicit dimensions', () => {
    expect(
      resolveSingleImageOutputQuality({
        outputQuality: 'hd',
        aspectRatio: '1:1',
        provider: 'fal',
        model: 'openai/gpt-image-2/edit',
        fallbackSize: '1024x1024',
      }),
    ).toMatchObject({
      size: '1280x1280',
      width: 1280,
      height: 1280,
      effectiveOutputQuality: 'hd',
    });
  });

  it('maps Fal GPT Image 2 text ultra to explicit dimensions', () => {
    expect(
      resolveSingleImageOutputQuality({
        outputQuality: 'ultra',
        aspectRatio: '16:9',
        provider: 'fal',
        model: 'openai/gpt-image-2',
        fallbackSize: '1344x768',
      }),
    ).toMatchObject({
      size: '2048x1152',
      width: 2048,
      height: 1152,
      effectiveOutputQuality: 'ultra',
      downgraded: false,
    });
  });

  test.each([
    ['standard', '1:1', '1024x1024'],
    ['standard', '3:4', '768x1024'],
    ['standard', '4:5', '832x1040'],
    ['standard', '16:9', '1344x768'],
    ['standard', '9:16', '768x1344'],
    ['hd', '1:1', '1280x1280'],
    ['hd', '3:4', '960x1280'],
    ['hd', '4:5', '1024x1280'],
    ['hd', '16:9', '1536x864'],
    ['hd', '9:16', '864x1536'],
    ['ultra', '1:1', '2048x2048'],
    ['ultra', '3:4', '1536x2048'],
    ['ultra', '4:5', '1600x2000'],
    ['ultra', '16:9', '2048x1152'],
    ['ultra', '9:16', '1152x2048'],
  ])('maps Fal GPT Image 2 text %s %s to schema-safe %s', (outputQuality, aspectRatio, size) => {
    expect(
      resolveSingleImageOutputQuality({
        outputQuality,
        aspectRatio,
        provider: 'fal',
        model: 'openai/gpt-image-2',
        fallbackSize: '1024x1024',
      }),
    ).toMatchObject({ size, imageSize: size });
  });

  it('keeps the existing APIMart GPT Image 2 hd landscape size unchanged', () => {
    expect(
      resolveSingleImageOutputQuality({
        outputQuality: 'hd',
        aspectRatio: '16:9',
        provider: 'apimart',
        model: 'gpt-image-2',
        fallbackSize: '1344x768',
      }),
    ).toMatchObject({ size: '1600x900', imageSize: '1600x900' });
  });

  it('gracefully downgrades unsupported providers to the fallback size', () => {
    expect(
      resolveSingleImageOutputQuality({
        outputQuality: 'ultra',
        aspectRatio: '4:5',
        provider: 'apimart',
        model: 'gemini-3.1-flash-image-preview',
        fallbackSize: '832x1040',
      }),
    ).toMatchObject({
      requestedOutputQuality: 'ultra',
      effectiveOutputQuality: 'standard',
      size: '832x1040',
      imageSize: '832x1040',
      downgraded: true,
    });
  });
});

test('Flare text quality presets produce supported exact pixels', () => {
  expect(
    resolveSingleImageOutputQuality({
      provider: 'apimart',
      model: 'gpt-image-2.5-flare',
      outputQuality: 'hd',
      aspectRatio: '16:9',
    }),
  ).toMatchObject({ size: '1536x864', resolution: null, effectiveOutputQuality: 'hd' });
});
