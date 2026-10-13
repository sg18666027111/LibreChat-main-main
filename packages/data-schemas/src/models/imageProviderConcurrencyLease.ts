import imageProviderConcurrencyLeaseSchema from '~/schema/imageProviderConcurrencyLease';
import type { IImageProviderConcurrencyLease } from '~/types/imageProviderConcurrencyLease';

export function createImageProviderConcurrencyLeaseModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ImageProviderConcurrencyLease ||
    mongoose.model<IImageProviderConcurrencyLease>(
      'ImageProviderConcurrencyLease',
      imageProviderConcurrencyLeaseSchema,
    )
  );
}
