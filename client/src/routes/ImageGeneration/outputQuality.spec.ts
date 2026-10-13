import {
  DEFAULT_OUTPUT_QUALITY,
  OUTPUT_QUALITY_OPTIONS,
  appendOutputQuality,
  buildTextToImagePayload,
  getTaskOutputQuality,
  normalizeOutputQuality,
  shouldAttachOutputQuality,
} from './outputQuality';

describe('single image output quality helpers', () => {
  it('defaults to hd', () => {
    expect(DEFAULT_OUTPUT_QUALITY).toBe('hd');
    expect(normalizeOutputQuality(undefined)).toBe('hd');
    expect(normalizeOutputQuality('unknown')).toBe('hd');
  });

  it('exposes the product copy for all three options', () => {
    expect(OUTPUT_QUALITY_OPTIONS).toEqual([
      { value: 'standard', label: '标准', description: '速度更快' },
      { value: 'hd', label: '高清', description: '更清晰，推荐' },
      { value: 'ultra', label: '超清', description: '更清晰，但生成更慢' },
    ]);
  });

  it.each(['standard', 'hd', 'ultra'] as const)(
    'adds %s outputQuality to text-to-image payloads',
    (outputQuality) => {
      expect(
        buildTextToImagePayload({
          platform: '通用',
          imageType: '通用营销图',
          modelKey: 'ark_seedream_5_0_t2i',
          model: 'doubao-seedream-5-0-pro-260628',
          prompt: '生成商品图',
          aspectRatio: '4:5',
          count: 1,
          outputQuality,
        }),
      ).toMatchObject({
        outputQuality,
        aspectRatio: '4:5',
        count: 1,
      });
    },
  );

  it('preserves a stable frontend task id in text-to-image payloads', () => {
    expect(
      buildTextToImagePayload({
        platform: '通用',
        imageType: '通用营销图',
        modelKey: 'apimart_gpt_image_2',
        model: 'gpt-image-2',
        frontendTaskId: 'frontend-task-1',
        prompt: '生成商品图',
        aspectRatio: '4:5',
        count: 1,
        outputQuality: 'hd',
      }),
    ).toMatchObject({
      frontendTaskId: 'frontend-task-1',
    });
  });

  it('adds outputQuality to image-to-image FormData', () => {
    const formData = new FormData();
    appendOutputQuality(formData, 'standard');

    expect(formData.get('outputQuality')).toBe('standard');
  });

  it.each([
    ['text-to-image', 'single', true],
    ['image-to-image', 'single', true],
    ['dual-product-replace', 'single', false],
    ['white-background', 'single', false],
    ['text-to-image', 'batch-packaging', false],
    ['image-to-image', 'batch-packaging', false],
  ] as const)('returns %s/%s output quality support as %s', (taskType, generationTab, expected) => {
    expect(shouldAttachOutputQuality({ taskType, generationTab })).toBe(expected);
    expect(getTaskOutputQuality({ taskType, generationTab, outputQuality: 'ultra' })).toBe(
      expected ? 'ultra' : undefined,
    );
  });

  it('does not add outputQuality to batch payload helpers unless explicitly appended', () => {
    const formData = new FormData();
    formData.append('mode', 't2i');
    formData.append('title', '商品标题');
    formData.append('templateIds', JSON.stringify(['white_box_1']));

    expect(formData.has('outputQuality')).toBe(false);
  });
});
