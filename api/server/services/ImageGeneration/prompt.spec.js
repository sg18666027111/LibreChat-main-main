const { buildWhiteBackgroundScenePrompt } = require('./prompt');

describe('ImageGeneration prompt aspect ratio constraints', () => {
  test('adds an explicit no-landscape-or-portrait constraint for 1:1', () => {
    const result = buildWhiteBackgroundScenePrompt({
      prompt: '把包装改成红色',
      platform: '通用',
      imageType: '商品主图',
      aspectRatio: '1:1',
    });

    expect(result).toContain('严格正方形构图，宽高完全相等，不得输出竖版或横版画布。');
  });

  test('does not add the square-only sentence to non-square requests', () => {
    const result = buildWhiteBackgroundScenePrompt({
      prompt: '把包装改成红色',
      platform: '通用',
      imageType: '商品主图',
      aspectRatio: '3:4',
    });

    expect(result).not.toContain('严格正方形构图，宽高完全相等，不得输出竖版或横版画布。');
  });
});
