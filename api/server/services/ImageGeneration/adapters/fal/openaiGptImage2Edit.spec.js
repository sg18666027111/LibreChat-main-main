jest.mock('./common', () => ({
  pollFalResult: jest.fn(),
  submitFalTask: jest.fn(),
}));

const common = require('./common');
const { buildPayload, buildTextPayload, generateImage } = require('./openaiGptImage2Edit');

describe('Fal GPT Image 2 Edit payload', () => {
  const originalFalImageSize = process.env.FAL_IMAGE_SIZE;

  afterEach(() => {
    if (originalFalImageSize === undefined) {
      delete process.env.FAL_IMAGE_SIZE;
    } else {
      process.env.FAL_IMAGE_SIZE = originalFalImageSize;
    }
  });

  test.each(['1:1', '1x1', 'square', '1024x1024'])(
    'maps %s to the documented square_hd image_size',
    (aspectRatio) => {
      const payload = buildPayload({
        prompt: '严格正方形构图',
        imageInputs: ['data:image/png;base64,AAAA'],
        aspectRatio,
        size: '1024x1024',
      });

      expect(payload.image_size).toBe('square_hd');
      expect(payload).not.toHaveProperty('size');
    },
  );

  test('uses the selected request dimensions instead of an environment default', () => {
    process.env.FAL_IMAGE_SIZE = 'portrait_4_3';

    const payload = buildPayload({
      prompt: '严格正方形构图',
      imageInputs: ['data:image/png;base64,AAAA'],
      aspectRatio: '1:1',
      size: '1024x1024',
    });

    expect(payload.image_size).toBe('square_hd');
  });

  test('keeps higher square output quality as explicit dimensions', () => {
    const payload = buildPayload({
      prompt: '高清正方形构图',
      imageInputs: ['data:image/png;base64,AAAA'],
      aspectRatio: '1:1',
      size: '1280x1280',
    });

    expect(payload.image_size).toEqual({ width: 1280, height: 1280 });
  });

  test.each([
    ['3:4', { width: 768, height: 1024 }],
    ['4:5', { width: 832, height: 1040 }],
    ['16:9', { width: 1344, height: 768 }],
    ['9:16', { width: 768, height: 1344 }],
  ])('maps %s to explicit Fal image_size dimensions', (aspectRatio, expectedImageSize) => {
    const payload = buildPayload({
      prompt: '保持所选比例',
      imageInputs: ['data:image/png;base64,AAAA'],
      aspectRatio,
      size: `${expectedImageSize.width}x${expectedImageSize.height}`,
    });

    expect(payload.image_size).toEqual(expectedImageSize);
  });

  test('keeps the existing synchronous submit then poll lifecycle', async () => {
    common.submitFalTask.mockResolvedValue({ request_id: 'request-1' });
    common.pollFalResult.mockResolvedValue({
      taskId: 'request-1',
      resultUrl: 'https://cdn.example/image.png',
      status: 'success',
    });

    await expect(
      generateImage({ prompt: 'edit', imageInputs: ['data:image/png;base64,AAAA'] }),
    ).resolves.toMatchObject({ provider: 'fal', taskId: 'request-1' });
    expect(common.submitFalTask).toHaveBeenCalledTimes(1);
    expect(common.pollFalResult).toHaveBeenCalledTimes(1);
  });
});

describe('Fal GPT Image 2 text payload', () => {
  test.each([
    ['standard', 'low'],
    ['hd', 'medium'],
    ['ultra', 'high'],
  ])('maps UI %s quality to Fal %s', (outputQuality, quality) => {
    expect(
      buildTextPayload({
        prompt: '生成商品营销图',
        size: '1280x1280',
        outputQuality,
        count: 1,
      }),
    ).toEqual({
      prompt: '生成商品营销图',
      image_size: { width: 1280, height: 1280 },
      quality,
      num_images: 1,
      output_format: 'png',
    });
  });

  test.each([2, 4])('rejects num_images=%s at the Fal adapter boundary', (count) => {
    expect(() => buildTextPayload({ prompt: 'multiple', count })).toThrow(
      expect.objectContaining({ code: 'IMAGE_MODEL_COUNT_UNSUPPORTED' }),
    );
  });
});
