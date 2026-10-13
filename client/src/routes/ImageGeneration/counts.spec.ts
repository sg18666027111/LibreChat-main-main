import {
  getGenerationCountNotice,
  getSupportedGenerationCounts,
  normalizeGenerationCount,
} from './counts';

describe('model-specific generation counts', () => {
  const globalCounts = [1, 2, 4];

  it('keeps global counts available when a model has no override', () => {
    expect(getSupportedGenerationCounts(globalCounts)).toEqual([1, 2, 4]);
    expect(normalizeGenerationCount(4, globalCounts)).toBe(4);
  });

  it('limits GPT Image 2 to one without changing the global count list', () => {
    const supportedCounts = [1];

    expect(getSupportedGenerationCounts(globalCounts, supportedCounts)).toEqual([1]);
    expect(globalCounts).toEqual([1, 2, 4]);
    expect(normalizeGenerationCount(2, globalCounts, supportedCounts)).toBe(1);
    expect(normalizeGenerationCount(4, globalCounts, supportedCounts)).toBe(1);
  });

  it('shows the approved single-output notice only for GPT Image 2 text-to-image', () => {
    expect(getGenerationCountNotice('apimart_gpt_image_2_text', [1])).toBe(
      'GPT Image 2 当前暂仅支持单张生成',
    );
    expect(getGenerationCountNotice('apimart_gpt_image_2_text', [1], true)).toBeNull();
    expect(getGenerationCountNotice('apimart_gemini_3_1_flash')).toBeNull();
  });
});

test('Flare text selection explains its single output limit', () => {
  expect(getGenerationCountNotice('fal_gpt_image_2_5_flare_text', [1])).toBe(
    'GPT Image 2.5 Flare（FAL）每次生成 1 张',
  );
  expect(getGenerationCountNotice('fal_gpt_image_2_5_flare_edit', [1], true)).toBeNull();
});
