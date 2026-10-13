import skuBatchTaskSchema from '~/schema/skuBatchTask';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import type { ISkuBatchTask } from '~/types/skuBatchTask';

export function createSkuBatchTaskModel(mongoose: typeof import('mongoose')) {
  applyTenantIsolation(skuBatchTaskSchema);
  return (
    mongoose.models.SkuBatchTask ||
    mongoose.model<ISkuBatchTask>('SkuBatchTask', skuBatchTaskSchema)
  );
}
