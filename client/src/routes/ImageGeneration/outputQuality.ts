export type OutputQuality = 'standard' | 'hd' | 'ultra';
export type OutputQualityTaskType =
  | 'text-to-image'
  | 'image-to-image'
  | 'dual-product-replace'
  | 'white-background';
export type OutputQualityGenerationTab = 'single' | 'batch-packaging';

export const DEFAULT_OUTPUT_QUALITY: OutputQuality = 'hd';

export const OUTPUT_QUALITY_OPTIONS: Array<{
  value: OutputQuality;
  label: string;
  description: string;
}> = [
  { value: 'standard', label: '标准', description: '速度更快' },
  { value: 'hd', label: '高清', description: '更清晰，推荐' },
  { value: 'ultra', label: '超清', description: '更清晰，但生成更慢' },
];

export function normalizeOutputQuality(value: unknown): OutputQuality {
  return OUTPUT_QUALITY_OPTIONS.some((option) => option.value === value)
    ? (value as OutputQuality)
    : DEFAULT_OUTPUT_QUALITY;
}

export function appendOutputQuality(formData: FormData, outputQuality: OutputQuality) {
  formData.append('outputQuality', normalizeOutputQuality(outputQuality));
}

export function shouldAttachOutputQuality({
  taskType,
  generationTab = 'single',
}: {
  taskType: OutputQualityTaskType;
  generationTab?: OutputQualityGenerationTab;
}) {
  return (
    generationTab === 'single' && (taskType === 'text-to-image' || taskType === 'image-to-image')
  );
}

export function getTaskOutputQuality({
  taskType,
  generationTab = 'single',
  outputQuality,
}: {
  taskType: OutputQualityTaskType;
  generationTab?: OutputQualityGenerationTab;
  outputQuality: OutputQuality;
}) {
  return shouldAttachOutputQuality({ taskType, generationTab })
    ? normalizeOutputQuality(outputQuality)
    : undefined;
}

export function buildTextToImagePayload({
  platform,
  imageType,
  modelKey,
  model,
  frontendTaskId,
  prompt,
  aspectRatio,
  count,
  outputQuality,
}: {
  platform: string;
  imageType: string;
  modelKey?: string;
  model: string;
  frontendTaskId?: string;
  prompt: string;
  aspectRatio: string;
  count: number;
  outputQuality: OutputQuality;
}) {
  return {
    platform,
    imageType,
    modelKey,
    model,
    frontendTaskId,
    prompt,
    aspectRatio,
    count,
    outputQuality: normalizeOutputQuality(outputQuality),
  };
}
