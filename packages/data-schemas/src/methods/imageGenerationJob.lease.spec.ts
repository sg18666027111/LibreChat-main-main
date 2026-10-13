import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import imageGenerationJobSchema from '~/schema/imageGenerationJob';
import { createImageGenerationJobMethods } from './imageGenerationJob';

jest.mock('~/config/winston', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

describe('APIMart late result ownership', () => {
  let server: MongoMemoryServer;
  let methods: ReturnType<typeof createImageGenerationJobMethods>;
  const now = new Date('2026-09-10T06:11:48Z');

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    mongoose.model('ImageGenerationJob', imageGenerationJobSchema);
    methods = createImageGenerationJobMethods(mongoose);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  beforeEach(async () => {
    await mongoose.models.ImageGenerationJob.deleteMany({});
    await mongoose.models.ImageGenerationJob.create({
      internalTaskId: 'blocked',
      userId: 'user-a',
      requestId: 'request-a',
      businessType: 'product_replacement',
      taskType: 'single-image-edit',
      provider: 'apimart',
      model: 'gpt-image-2',
      asyncVersion: 2,
      status: 'submitting',
      workerOwner: 'worker-a',
      workerLeaseUntil: new Date(now.getTime() - 1000),
    });
  });

  const completion = () => ({
    internalTaskId: 'blocked',
    workerId: 'worker-a',
    statuses: ['submitting' as const],
    now,
    allowExpiredLease: true,
    updates: { status: 'succeeded' as const, providerTaskId: 'original-provider-task' },
    releaseLease: true,
  });

  it('saves a late result if no other worker took ownership', async () => {
    const result = await methods.updateImageGenerationJobWithLease(completion());
    expect(result?.status).toBe('succeeded');
    expect(result?.workerOwner).toBeNull();
  });

  it('rejects the previous worker after a new worker takes ownership', async () => {
    await mongoose.models.ImageGenerationJob.updateOne(
      { internalTaskId: 'blocked' },
      { $set: { workerOwner: 'worker-b' } },
    );
    expect(await methods.updateImageGenerationJobWithLease(completion())).toBeNull();
  });

  it('keeps strict expiry checking by default', async () => {
    const input = { ...completion(), allowExpiredLease: false };
    expect(await methods.updateImageGenerationJobWithLease(input)).toBeNull();
  });
});
