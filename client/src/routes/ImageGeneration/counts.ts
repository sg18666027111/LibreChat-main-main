export function getSupportedGenerationCounts(counts: number[], supportedCounts?: number[]) {
  return supportedCounts?.length
    ? counts.filter((count) => supportedCounts.includes(count))
    : counts;
}

export function normalizeGenerationCount(
  count: number,
  counts: number[],
  supportedCounts?: number[],
) {
  const availableCounts = getSupportedGenerationCounts(counts, supportedCounts);
  return availableCounts.includes(count) ? count : (availableCounts[0] ?? counts[0] ?? 1);
}

export function getGenerationCountNotice(
  modelKey?: string,
  supportedCounts?: number[],
  isImageEditTask = false,
) {
  if (
    !isImageEditTask &&
    modelKey === 'fal_gpt_image_2_5_flare_text' &&
    supportedCounts?.length === 1 &&
    supportedCounts[0] === 1
  ) {
    return 'GPT Image 2.5 Flare（FAL）每次生成 1 张';
  }
  if (
    !isImageEditTask &&
    modelKey === 'apimart_gpt_image_2_text' &&
    supportedCounts?.length === 1 &&
    supportedCounts[0] === 1
  ) {
    return 'GPT Image 2 当前暂仅支持单张生成';
  }
  return null;
}
