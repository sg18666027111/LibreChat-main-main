import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IImageGenerationJob } from '~/types/imageGenerationJob';
import imageGenerationJobSchema from '~/schema/imageGenerationJob';
import { createImageGenerationJobMethods } from './imageGenerationJob';

describe('APIMart V2 model scope', () => {
  let server: MongoMemoryServer;
  let connection: mongoose.Connection;
  let model: mongoose.Model<IImageGenerationJob>;
  let methods: ReturnType<typeof createImageGenerationJobMethods>;
  const models = ['gpt-image-2', 'gpt-image-2.5-sunburst'];
  const now = new Date('2026-09-14T00:00:00Z');
  const resourceKey = 'apimart:test-key:gpt-image-2';
  const claim = {
    workerId: 'worker-a',
    leaseMs: 30_000,
    statuses: ['waiting' as const],
    rolloutModes: ['canary' as const],
    now,
  };

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

  async function insert(internalTaskId: string, overrides: Record<string, unknown> = {}) {
    return model.create({
      internalTaskId,
      requestId: internalTaskId,
      userId: 'user',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      resourceKey,
      asyncVersion: 2,
      workerEligible: true,
      rolloutMode: 'canary',
      status: 'waiting',
      queueEnteredAt: now,
      ...overrides,
    });
  }

  test('claims both allowed models while preserving eligibility and due-lease filters', async () => {
    const blocked = [
      { provider: 'another-provider' },
      { model: 'another-model' },
      { asyncVersion: 3 },
      { workerEligible: false },
      { rolloutMode: 'all' },
      { status: 'succeeded' },
      { workerLeaseUntil: new Date(now.getTime() + 1) },
      { nextPollAt: new Date(now.getTime() + 1) },
    ];
    for (const [index, overrides] of blocked.entries()) {
      await insert(`blocked-${index}`, { model: 'gpt-image-2.5-sunburst', ...overrides });
    }
    await insert('old', { queueEnteredAt: new Date(now.getTime() - 2) });
    await insert('new', {
      model: 'gpt-image-2.5-sunburst',
      queueEnteredAt: new Date(now.getTime() - 1),
      workerLeaseUntil: now,
      nextPollAt: now,
    });

    const input = { ...claim, models };
    expect(await methods.acquireImageGenerationJobLease(input)).toMatchObject({
      internalTaskId: 'old',
      workerOwner: 'worker-a',
      workerLeaseUntil: new Date(now.getTime() + 30_000),
      runVersion: 1,
    });
    expect(await methods.acquireImageGenerationJobLease(input)).toMatchObject({
      internalTaskId: 'new',
      workerOwner: 'worker-a',
      runVersion: 1,
    });
    expect(await methods.acquireImageGenerationJobLease(input)).toBeNull();
  });

  test.each([
    [{}, 'old'],
    [{ model: 'gpt-image-2.5-sunburst' }, 'new'],
    [{ model: 'gpt-image-2', models: ['gpt-image-2.5-sunburst'] }, 'new'],
    [{ models: [] }, null],
  ])('preserves claim scope for %j', async (scope, expectedId) => {
    await insert('old');
    await insert('new', { model: 'gpt-image-2.5-sunburst' });
    const result = await methods.acquireImageGenerationJobLease({ ...claim, ...scope });
    expect(result?.internalTaskId ?? null).toBe(expectedId);
  });

  test('counts both models in shared capacity regardless of lease ownership and expiry', async () => {
    await insert('old', { status: 'submitting', workerLeaseUntil: null });
    await insert('new', {
      model: 'gpt-image-2.5-sunburst',
      status: 'polling',
      submittedToProvider: true,
      providerTaskId: 'upstream-new',
      workerOwner: 'other-worker',
      workerLeaseUntil: new Date(now.getTime() + 30_000),
    });
    await insert('unknown', {
      model: 'gpt-image-2.5-sunburst',
      status: 'status_unknown',
      submittedToProvider: true,
      providerTaskId: 'upstream-unknown',
      workerLeaseUntil: new Date(now.getTime() - 1),
    });
    const excluded = [
      { provider: 'another-provider' },
      { model: 'another-model' },
      { resourceKey: 'another-resource' },
      { asyncVersion: 3 },
      { workerEligible: false },
      { status: 'succeeded' },
      { status: 'status_unknown', providerTaskId: '' },
    ];
    for (const [index, overrides] of excluded.entries()) {
      await insert(`excluded-${index}`, {
        model: 'gpt-image-2.5-sunburst',
        status: 'submitted',
        submittedToProvider: true,
        providerTaskId: `upstream-excluded-${index}`,
        ...overrides,
      });
    }

    const input = { resourceKey, models };
    expect(await methods.countActiveImageGenerationProviderTasks(input)).toBe(3);
    expect(
      await methods.countActiveImageGenerationProviderTasks({
        ...input,
        excludeInternalTaskId: 'old',
        excludeInternalTaskIds: ['new', 'unknown'],
      }),
    ).toBe(0);
  });

  test.each([
    [{}, 1],
    [{ model: 'gpt-image-2.5-sunburst' }, 2],
    [{ model: 'gpt-image-2', models: ['gpt-image-2.5-sunburst'] }, 2],
    [{ models: [] }, 0],
  ])('preserves capacity scope for %j', async (scope, expectedCount) => {
    await insert('old', { status: 'submitting' });
    await insert('new-1', { model: 'gpt-image-2.5-sunburst', status: 'submitting' });
    await insert('new-2', { model: 'gpt-image-2.5-sunburst', status: 'submitting' });
    expect(await methods.countActiveImageGenerationProviderTasks({ resourceKey, ...scope })).toBe(
      expectedCount,
    );
  });
});
