import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IImageGenerationJob } from '~/types/imageGenerationJob';
import imageGenerationJobSchema from '~/schema/imageGenerationJob';
import { createImageGenerationJobMethods } from './imageGenerationJob';

/** Real Mongo query semantics: missing, null and empty task IDs must behave identically. */
describe('APIMart V2 local capacity and unknown outcome', () => {
  let server: MongoMemoryServer;
  let connection: mongoose.Connection;
  let model: mongoose.Model<IImageGenerationJob>;
  let methods: ReturnType<typeof createImageGenerationJobMethods>;
  const resourceKey = 'apimart:test-key:gpt-image-2';

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(server.getUri()).asPromise();
    model = connection.model('ImageGenerationJob', imageGenerationJobSchema);
    methods = createImageGenerationJobMethods(connection as never);
    await methods.ensureImageGenerationJobStorage();
  });
  afterAll(async () => {
    await connection?.close();
    await server?.stop();
  });
  beforeEach(async () => {
    await model.deleteMany({});
  });

  async function insert(overrides: Record<string, unknown> = {}) {
    return model.create({
      internalTaskId: 'orphan',
      requestId: 'request',
      userId: 'user',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      resourceKey,
      asyncVersion: 2,
      workerEligible: true,
      status: 'status_unknown',
      submittedToProvider: true,
      ...overrides,
    });
  }

  test.each([undefined, null, ''])(
    'unknown without task ID (%s) does not own capacity',
    async (providerTaskId) => {
      await insert({ providerTaskId });
      expect(await methods.countActiveImageGenerationProviderTasks({ resourceKey })).toBe(0);
      expect((await model.findOne({ internalTaskId: 'orphan' }).lean())?.status).toBe(
        'status_unknown',
      );
    },
  );

  test.each(['status_unknown', 'submitted', 'polling'])(
    '%s with a task ID keeps capacity',
    async (status) => {
      await insert({ status, providerTaskId: 'provider-original' });
      expect(await methods.countActiveImageGenerationProviderTasks({ resourceKey })).toBe(1);
    },
  );

  test('submitting without an ID keeps capacity', async () => {
    await insert({ status: 'submitting', submittedToProvider: false });
    expect(await methods.countActiveImageGenerationProviderTasks({ resourceKey })).toBe(1);
  });

  test('active query isolates resource, task identity, eligibility and V2', async () => {
    await insert({ providerTaskId: 'provider-original' });
    expect(
      await methods.countActiveImageGenerationProviderTasks({ resourceKey: 'another-key' }),
    ).toBe(0);
    expect(
      await methods.countActiveImageGenerationProviderTasks({
        resourceKey,
        excludeInternalTaskId: 'orphan',
      }),
    ).toBe(0);
    await model.updateOne({}, { $set: { asyncVersion: 3 } });
    expect(await methods.countActiveImageGenerationProviderTasks({ resourceKey })).toBe(0);
    await model.updateOne({}, { $set: { asyncVersion: 2, workerEligible: false } });
    expect(await methods.countActiveImageGenerationProviderTasks({ resourceKey })).toBe(0);
  });

  test('leased unknown transition persists capacity audit without replacing error history', async () => {
    const now = new Date();
    await insert({
      status: 'submitting',
      workerOwner: 'worker-a',
      workerLeaseUntil: new Date(now.getTime() + 30000),
      errorCode: 'APIMART_IMAGE_SUBMIT_TIMEOUT',
      error: 'Original local timeout',
    });
    const audit = {
      providerOutcomeUnknown: true,
      manualReviewRequired: true,
      neverResubmit: true,
      localCapacityReleasedAt: now,
      localCapacityReleaseReason: 'status_unknown_without_provider_task_id',
    };
    await methods.updateImageGenerationJobWithLease({
      internalTaskId: 'orphan',
      workerId: 'worker-a',
      statuses: ['submitting'],
      now,
      updates: { status: 'status_unknown', workerOwner: null, workerLeaseUntil: null, ...audit },
    });
    const saved = await model.findOne({ internalTaskId: 'orphan' }).lean();
    expect(saved).toMatchObject({
      ...audit,
      status: 'status_unknown',
      submittedToProvider: true,
      errorCode: 'APIMART_IMAGE_SUBMIT_TIMEOUT',
      error: 'Original local timeout',
    });
    const duplicate = await methods.updateImageGenerationJobWithLease({
      internalTaskId: 'orphan',
      workerId: 'worker-a',
      statuses: ['submitting'],
      now,
      updates: { status: 'waiting' },
    });
    expect(duplicate).toBeNull();
    expect((await model.findOne({ internalTaskId: 'orphan' }).lean())?.status).toBe(
      'status_unknown',
    );
  });
});
