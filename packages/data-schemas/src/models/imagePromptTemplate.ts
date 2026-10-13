import imagePromptTemplateSchema from '~/schema/imagePromptTemplate';
import type { IImagePromptTemplateDocument } from '~/types/imagePromptTemplate';

export function createImagePromptTemplateModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ImagePromptTemplate ||
    mongoose.model<IImagePromptTemplateDocument>('ImagePromptTemplate', imagePromptTemplateSchema)
  );
}
