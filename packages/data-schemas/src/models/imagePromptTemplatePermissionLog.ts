import imagePromptTemplatePermissionLogSchema from '~/schema/imagePromptTemplatePermissionLog';
import type { IImagePromptTemplatePermissionLogDocument } from '~/types/imagePromptTemplatePermissionLog';

export function createImagePromptTemplatePermissionLogModel(
  mongoose: typeof import('mongoose'),
) {
  return (
    mongoose.models.ImagePromptTemplatePermissionLog ||
    mongoose.model<IImagePromptTemplatePermissionLogDocument>(
      'ImagePromptTemplatePermissionLog',
      imagePromptTemplatePermissionLogSchema,
    )
  );
}
