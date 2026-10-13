import imageGenerationJobSchema from '~/schema/imageGenerationJob';
import type { IImageGenerationJob } from '~/types/imageGenerationJob';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';

export function createImageGenerationJobModel(mongoose: typeof import('mongoose')) {
  applyTenantIsolation(imageGenerationJobSchema);
  return (
    mongoose.models.ImageGenerationJob ||
    mongoose.model<IImageGenerationJob>('ImageGenerationJob', imageGenerationJobSchema)
  );
}
