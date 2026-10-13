const { formatPromptTemplateText } = require('./promptTemplateFormatter');

describe('promptTemplateFormatter', () => {
  test('formats structure without removing original business sentences', () => {
    const prompt = [
      '电商零食搜索主图，45°斜俯视角，包装占满整张画面。',
      '内部盛满【食材实物形态】，标题："红枣黑芝麻丸100%调理气血"',
      '包装文字要求较多：主标题、两行slogan、品质承诺、官方正品、全网第一。',
    ].join('\n');

    const result = formatPromptTemplateText(prompt);

    expect(result.originalPrompt).toBe(prompt);
    expect(result.formattedPrompt).toContain('电商零食搜索主图，45°斜俯视角，包装占满整张画面。');
    expect(result.formattedPrompt).toContain('内部盛满【食材实物形态】');
    expect(result.formattedPrompt).toContain('包装文字要求较多');
    expect(result.formattedPrompt).toContain('变量说明');
    expect(result.formattedPrompt).toContain('【食材实物形态】');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('具体商品标题'),
        expect.stringContaining('合规风险'),
        expect.stringContaining('强承诺词'),
        expect.stringContaining('包装文字要求较多'),
      ]),
    );
  });
});
