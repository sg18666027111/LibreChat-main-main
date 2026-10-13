import imageBatchTaskSchema from '~/schema/imageBatchTask';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import type { IImageBatchTask } from '~/types/imageBatchTask';

export function createImageBatchTaskModel(mongoose: typeof import('mongoose')) {
  applyTenantIsolation(imageBatchTaskSchema);
  return (
    mongoose.models.ImageBatchTask ||
    mongoose.model<IImageBatchTask>('ImageBatchTask', imageBatchTaskSchema)
  );
}
