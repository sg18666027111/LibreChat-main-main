import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { createImageGenerationJobMethods } from './imageGenerationJob';
import { createImageBatchTaskMethods } from './imageBatchTask';
let server: MongoMemoryServer;
beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  await mongoose.connect(server.getUri());
  createModels(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
test('a delayed journal acknowledgement cannot downgrade a persisted image revision or touch the next revision', async () => {
  const Model = mongoose.models.ImageGenerationJob;
  await Model.collection.insertOne({
    internalTaskId: 'cas-image',
    usageRecorded: true,
    usageDelivery: { revision: 2, state: 'persisted' },
  });
  const methods = createImageGenerationJobMethods(mongoose);
  await methods.updateImageGenerationJobUsageDelivery({
    internalTaskId: 'cas-image',
    revision: 1,
    state: 'pending',
  });
  await methods.updateImageGenerationJobUsageDelivery({
    internalTaskId: 'cas-image',
    revision: 2,
    state: 'durable',
  });
  const stored = await Model.collection.findOne({ internalTaskId: 'cas-image' });
  expect(stored?.usageRecorded).toBe(true);
  expect(stored?.usageDelivery).toEqual({ revision: 2, state: 'persisted' });
});
test('a delayed batch ack cannot mark a new provider attempt as recorded', async () => {
  const Model = mongoose.models.ImageBatchTask;
  await Model.collection.insertOne({
    batchId: 'cas-batch',
    itemId: 'item',
    usageContext: { eventId: 'attempt-2' },
    usageRecorded: false,
    usageDelivery: { revision: 1, state: 'pending' },
  });
  const methods = createImageBatchTaskMethods(mongoose);
  await methods.updateImageBatchTaskUsageDelivery({
    batchId: 'cas-batch',
    itemId: 'item',
    eventId: 'attempt-1',
    revision: 1,
    state: 'persisted',
  });
  expect((await Model.collection.findOne({ batchId: 'cas-batch' }))?.usageRecorded).toBe(false);
  await methods.updateImageBatchTaskUsageDelivery({
    batchId: 'cas-batch',
    itemId: 'item',
    eventId: 'attempt-2',
    revision: 1,
    state: 'persisted',
  });
  await methods.updateImageBatchTaskUsageDelivery({
    batchId: 'cas-batch',
    itemId: 'item',
    eventId: 'attempt-2',
    revision: 1,
    state: 'durable',
  });
  const stored = await Model.collection.findOne({ batchId: 'cas-batch' });
  expect(stored?.usageRecorded).toBe(true);
  expect(stored?.usageDelivery.state).toBe('persisted');
});
