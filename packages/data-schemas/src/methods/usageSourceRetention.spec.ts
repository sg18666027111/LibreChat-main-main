import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { createImageBatchTaskMethods } from './imageBatchTask';
import { createImageGenerationJobMethods } from './imageGenerationJob';
let server: MongoMemoryServer;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  createModels(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
test.each(['image', 'batch'])(
  '%s terminal source suspends TTL until a durable copy, then restores original retention',
  async (source) => {
    const id = new mongoose.Types.ObjectId();
    const expiresAt = new Date(Date.now() + 100000);
    const envelope = { event: { usageEventId: 'fixture' }, revision: 1 };
    const methods =
      source === 'image'
        ? createImageGenerationJobMethods(mongoose)
        : createImageBatchTaskMethods(mongoose);
    const Model =
      source === 'image' ? mongoose.models.ImageGenerationJob : mongoose.models.ImageBatchTask;
    await Model.collection.insertOne({
      _id: id,
      status: 'polling',
      internalTaskId: String(id),
      batchId: String(id),
      itemId: 'item',
      expiresAt,
    });
    const updates = {
      status: 'succeeded',
      expiresAt,
      usageDelivery: { state: 'pending', revision: 1, envelope },
    } as never;
    if (source === 'image')
      await (
        methods as ReturnType<typeof createImageGenerationJobMethods>
      ).updateImageGenerationJob({ internalTaskId: String(id), statuses: ['polling'], updates });
    else
      await (methods as ReturnType<typeof createImageBatchTaskMethods>).updateImageBatchTaskItem({
        batchId: String(id),
        itemId: 'item',
        statuses: ['polling'] as never,
        updates,
      });
    const pending = await Model.collection.findOne({ _id: id });
    expect(pending?.expiresAt).toBeUndefined();
    expect(pending?.usageDelivery.cleanupAfter).toBe(expiresAt.toISOString());
    if (source === 'image')
      await (
        methods as ReturnType<typeof createImageGenerationJobMethods>
      ).updateImageGenerationJobUsageDelivery({
        internalTaskId: String(id),
        revision: 1,
        state: 'durable',
      });
    else
      await (
        methods as ReturnType<typeof createImageBatchTaskMethods>
      ).updateImageBatchTaskUsageDelivery({
        batchId: String(id),
        itemId: 'item',
        revision: 1,
        state: 'durable',
      });
    const durable = await Model.collection.findOne({ _id: id });
    expect(durable?.expiresAt).toEqual(expiresAt);
  },
);
test.each(['image', 'batch'])(
  '%s recovery-only records are hidden from business lookups',
  async (source) => {
    const id = new mongoose.Types.ObjectId();
    const Model =
      source === 'image' ? mongoose.models.ImageGenerationJob : mongoose.models.ImageBatchTask;
    await Model.collection.insertOne({
      _id: id,
      internalTaskId: String(id),
      batchId: String(id),
      itemId: 'item',
      status: 'succeeded',
      usageDelivery: { state: 'pending', payloadPruned: true },
    });
    const found =
      source === 'image'
        ? await createImageGenerationJobMethods(mongoose).getImageGenerationJob({
            internalTaskId: String(id),
          })
        : await createImageBatchTaskMethods(mongoose).getImageBatchTaskItem({
            batchId: String(id),
            itemId: 'item',
          });
    expect(found).toBeNull();
  },
);
