import imageEgressWorkerSlotSchema from '~/schema/imageEgressWorkerSlot';
import type { IImageEgressWorkerSlot } from '~/types/imageEgressWorkerSlot';

export function createImageEgressWorkerSlotModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ImageEgressWorkerSlot ||
    mongoose.model<IImageEgressWorkerSlot>('ImageEgressWorkerSlot', imageEgressWorkerSlotSchema)
  );
}
