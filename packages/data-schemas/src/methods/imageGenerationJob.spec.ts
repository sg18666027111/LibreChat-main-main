import imageGenerationJobSchema, { imageGenerationJobStatuses } from '~/schema/imageGenerationJob';
import { createImageGenerationJobMethods } from './imageGenerationJob';

function createQuery(result: unknown = null) {
  const query = {
    select: jest.fn(),
    sort: jest.fn(),
    lean: jest.fn(async () => result),
  };
  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  return query;
}

function createMethods(overrides: Record<string, jest.Mock> = {}) {
  const model = {
    create: jest.fn(),
    createCollection: jest.fn(),
    createIndexes: jest.fn(),
    modelName: 'ImageGenerationJob',
    findOne: jest.fn(() => createQuery(null)),
    findOneAndUpdate: jest.fn(() => createQuery(null)),
    countDocuments: jest.fn(),
    ...overrides,
  };
  const mongoose = { models: { ImageGenerationJob: model } } as never;
  return { methods: createImageGenerationJobMethods(mongoose), model };
}

describe('ImageGenerationJob persistence', () => {
  test('looks up a batch child within its user, tenant, model and v2 identity', async () => {
    const query = createQuery({ internalTaskId: 'child-1' });
    const { methods, model } = createMethods({ findOne: jest.fn(() => query) });
    const result = await methods.getImageGenerationJobByBatchItem({
      userId: 'user-1',
      tenantId: 'tenant-1',
      batchTaskId: 'batch-1',
      itemId: 'item-1',
      model: 'gpt-image-2',
    });
    expect(model.findOne).toHaveBeenCalledWith({
      'usageDelivery.payloadPruned': { $ne: true },
      userId: 'user-1',
      tenantId: 'tenant-1',
      batchTaskId: 'batch-1',
      itemId: 'item-1',
      model: 'gpt-image-2',
      provider: 'apimart',
      asyncVersion: 2,
      businessType: 'batch_image_generation',
    });
    expect(result).toEqual({ internalTaskId: 'child-1' });
  });

  test('supports the durable APIMart job lifecycle statuses', () => {
    expect(imageGenerationJobStatuses).toEqual([
      'waiting',
      'submitting',
      'submitted',
      'polling',
      'succeeded',
      'failed',
      'status_unknown',
      'cancelled',
    ]);

    const indexes = imageGenerationJobSchema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [{ internalTaskId: 1 }, expect.objectContaining({ unique: true })],
        [{ status: 1, workerLeaseUntil: 1, queueEnteredAt: 1 }, expect.any(Object)],
        [
          { resourceKey: 1, submittedToProvider: 1, status: 1, providerTaskId: 1 },
          expect.any(Object),
        ],
        [
          { userId: 1, frontendTaskId: 1, businessType: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: expect.objectContaining({
              asyncVersion: 2,
              frontendTaskId: expect.any(Object),
            }),
          }),
        ],
        [
          { userId: 1, batchTaskId: 1, itemId: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: expect.objectContaining({
              asyncVersion: 2,
              batchTaskId: expect.any(Object),
              itemId: expect.any(Object),
            }),
          }),
        ],
      ]),
    );
    expect(imageGenerationJobSchema.path('asyncVersion')).toBeDefined();
    expect(imageGenerationJobSchema.path('rolloutMode')).toBeDefined();
    expect(imageGenerationJobSchema.path('workerEligible')).toBeDefined();
    expect(imageGenerationJobSchema.path('providerErrorCode')).toBeDefined();
    expect(imageGenerationJobSchema.path('providerErrorCategory')).toBeDefined();
    expect(imageGenerationJobSchema.path('pollCount')).toBeDefined();
    expect(imageGenerationJobSchema.path('lastPolledAt')).toBeDefined();
    expect(imageGenerationJobSchema.path('nextPollAt')).toBeDefined();
  });

  test('defines isolated v3 worker fields and idempotency indexes', () => {
    const indexes = imageGenerationJobSchema.indexes();

    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { userId: 1, frontendTaskId: 1, businessType: 1, asyncVersion: 1 },
          expect.objectContaining({
            name: 'uniq_image_egress_v3_frontend_identity',
            unique: true,
            partialFilterExpression: {
              asyncVersion: 3,
              workerFamily: 'image-egress-v1',
              frontendTaskId: { $exists: true, $type: 'string' },
            },
          }),
        ],
        [
          { userId: 1, batchTaskId: 1, itemId: 1, asyncVersion: 1 },
          expect.objectContaining({
            name: 'uniq_image_egress_v3_batch_identity',
            unique: true,
            partialFilterExpression: {
              asyncVersion: 3,
              workerFamily: 'image-egress-v1',
              batchTaskId: { $exists: true, $type: 'string' },
              itemId: { $exists: true, $type: 'string' },
            },
          }),
        ],
      ]),
    );
    expect(imageGenerationJobSchema.path('workerFamily')).toBeDefined();
    expect(imageGenerationJobSchema.path('providerMetadata')?.options.select).toBe(false);
    expect(imageGenerationJobSchema.path('currentOperation')).toBeDefined();
    expect(imageGenerationJobSchema.path('operationAttemptCount')).toBeDefined();
    expect(imageGenerationJobSchema.path('operationTransientFailureCount')).toBeDefined();
    expect(imageGenerationJobSchema.path('failedTurnCount')).toBeDefined();
    expect(imageGenerationJobSchema.path('lastOperationErrorCode')).toBeDefined();
    expect(imageGenerationJobSchema.path('lastOperationAt')).toBeDefined();
    expect(imageGenerationJobSchema.path('nextAttemptAt')).toBeDefined();
    expect(imageGenerationJobSchema.path('deadlineAt')).toBeDefined();
    expect(imageGenerationJobSchema.path('jobDeadlineAt')).toBeDefined();
  });

  test('creates the collection and indexes before the first internal job insert', async () => {
    const events: string[] = [];
    const { methods, model } = createMethods({
      createCollection: jest.fn(async () => events.push('collection')),
      createIndexes: jest.fn(async () => events.push('indexes')),
      create: jest.fn(async () => events.push('insert')),
    });

    await methods.createImageGenerationJob({
      internalTaskId: 'task-1',
      requestId: 'request-1',
      userId: 'user-1',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      payload: { prompt: 'stored but not logged' },
    } as never);

    expect(events).toEqual(['collection', 'indexes', 'insert']);
    expect(model.createCollection).toHaveBeenCalledTimes(1);
    expect(model.createIndexes).toHaveBeenCalledTimes(1);
  });

  test('reuses the original job for a replayed frontend task id', async () => {
    const existingJob = {
      internalTaskId: 'task-original',
      requestId: 'request-original',
      userId: 'user-1',
      frontendTaskId: 'frontend-click-1',
      businessType: 'image_generation',
    };
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    const query = createQuery(existingJob);
    const { methods, model } = createMethods({
      create: jest.fn().mockRejectedValueOnce(duplicateError),
      findOne: jest.fn(() => query),
    });

    const result = await methods.findOrCreateImageGenerationJob({
      internalTaskId: 'task-replayed',
      requestId: 'request-replayed',
      userId: 'user-1',
      frontendTaskId: 'frontend-click-1',
      businessType: 'image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      asyncVersion: 2,
      rolloutMode: 'canary',
      workerEligible: true,
      payload: { prompt: 'stored but not logged' },
    } as never);

    expect(result).toEqual({ job: existingJob, deduplicated: true });
    expect(model.findOne).toHaveBeenCalledWith({
      'usageDelivery.payloadPruned': { $ne: true },
      userId: 'user-1',
      frontendTaskId: 'frontend-click-1',
      businessType: 'image_generation',
      asyncVersion: 2,
    });
    expect(query.select).toHaveBeenCalledWith('+payload +result +usageContext +usageDelivery');
  });

  test('reuses the original job for a replayed batch item', async () => {
    const existingJob = {
      internalTaskId: 'task-batch-original',
      requestId: 'request-batch-original',
      userId: 'user-1',
      batchTaskId: 'batch-1',
      itemId: 'item-1',
      businessType: 'batch_image_generation',
    };
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    const query = createQuery(existingJob);
    const { methods, model } = createMethods({
      create: jest.fn().mockRejectedValueOnce(duplicateError),
      findOne: jest.fn(() => query),
    });

    const result = await methods.findOrCreateImageGenerationJob({
      internalTaskId: 'task-batch-replayed',
      requestId: 'request-batch-replayed',
      userId: 'user-1',
      batchTaskId: 'batch-1',
      itemId: 'item-1',
      businessType: 'batch_image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      asyncVersion: 2,
      rolloutMode: 'canary',
      workerEligible: true,
      payload: { prompt: 'stored but not logged' },
    } as never);

    expect(result).toEqual({ job: existingJob, deduplicated: true });
    expect(model.findOne).toHaveBeenCalledWith({
      'usageDelivery.payloadPruned': { $ne: true },
      userId: 'user-1',
      batchTaskId: 'batch-1',
      itemId: 'item-1',
      asyncVersion: 2,
    });
    expect(query.select).toHaveBeenCalledWith('+payload +result +usageContext +usageDelivery');
  });

  test('uses the batch item idempotency key when a batch item also has a frontend task id', async () => {
    const existingJob = {
      internalTaskId: 'task-batch-original',
      requestId: 'request-batch-original',
      userId: 'user-1',
      frontendTaskId: 'frontend-batch-1',
      batchTaskId: 'batch-1',
      itemId: 'item-1',
      businessType: 'batch_image_generation',
    };
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    const query = createQuery(existingJob);
    const { methods, model } = createMethods({
      create: jest.fn().mockRejectedValueOnce(duplicateError),
      findOne: jest.fn(() => query),
    });

    const result = await methods.findOrCreateImageGenerationJob({
      internalTaskId: 'task-batch-replayed',
      requestId: 'request-batch-replayed',
      userId: 'user-1',
      frontendTaskId: 'frontend-batch-1',
      batchTaskId: 'batch-1',
      itemId: 'item-1',
      businessType: 'batch_image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      asyncVersion: 2,
      rolloutMode: 'canary',
      workerEligible: true,
      payload: { prompt: 'stored but not logged' },
    } as never);

    expect(result).toEqual({ job: existingJob, deduplicated: true });
    expect(model.findOne).toHaveBeenCalledWith({
      'usageDelivery.payloadPruned': { $ne: true },
      userId: 'user-1',
      batchTaskId: 'batch-1',
      itemId: 'item-1',
      asyncVersion: 2,
    });
    expect(query.select).toHaveBeenCalledWith('+payload +result +usageContext +usageDelivery');
  });

  test('claims only an expected-status job without an active worker lease', async () => {
    const query = createQuery({ internalTaskId: 'task-1', workerOwner: 'worker-a' });
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });
    const now = new Date('2026-08-04T10:00:00.000Z');

    await methods.acquireImageGenerationJobLease({
      workerId: 'worker-a',
      leaseMs: 30_000,
      statuses: ['waiting'],
      now,
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        provider: 'apimart',
        model: 'gpt-image-2',
        asyncVersion: 2,
        workerEligible: true,
        status: { $in: ['waiting'] },
        $and: [
          {
            $or: [
              { workerLeaseUntil: null },
              { workerLeaseUntil: { $exists: false } },
              { workerLeaseUntil: { $lte: now } },
            ],
          },
          {
            $or: [
              { nextPollAt: null },
              { nextPollAt: { $exists: false } },
              { nextPollAt: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: {
          workerOwner: 'worker-a',
          workerLeaseUntil: new Date('2026-08-04T10:00:30.000Z'),
        },
        $inc: { runVersion: 1 },
        $unset: { expiresAt: 1 },
      },
      { new: true, sort: { queueEnteredAt: 1, createdAt: 1 } },
    );
    expect(query.select).toHaveBeenCalledWith('+payload +result +usageContext +usageDelivery');
  });

  test('limits atomic worker claim to allowed rollout modes', async () => {
    const query = createQuery({ internalTaskId: 'task-1', workerOwner: 'worker-a' });
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });

    await methods.acquireImageGenerationJobLease({
      workerId: 'worker-a',
      leaseMs: 30_000,
      statuses: ['waiting'],
      rolloutModes: ['canary'],
      now: new Date('2026-08-04T10:00:00.000Z'),
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        rolloutMode: { $in: ['canary'] },
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  test('claims only due v3 image-egress jobs from the exact provider allowset', async () => {
    const query = createQuery({ internalTaskId: 'task-v3', workerOwner: 'egress-worker-a' });
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });
    const now = new Date('2026-08-08T10:00:00.000Z');
    const allowset = [
      { provider: 'fal', model: 'openai/gpt-image-2/edit' },
      { provider: 'fal', model: 'xai/grok-imagine-image/edit' },
    ];

    await methods.acquireImageEgressJobLease({
      workerId: 'egress-worker-a',
      leaseMs: 30_000,
      statuses: ['waiting', 'polling'],
      rolloutModes: ['canary'],
      allowset,
      now,
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        asyncVersion: 3,
        workerFamily: 'image-egress-v1',
        workerEligible: true,
        status: { $in: ['waiting', 'polling'] },
        rolloutMode: { $in: ['canary'] },
        $or: allowset,
        $and: [
          {
            $or: [
              { workerLeaseUntil: null },
              { workerLeaseUntil: { $exists: false } },
              { workerLeaseUntil: { $lte: now } },
            ],
          },
          {
            $or: [
              { nextAttemptAt: null },
              { nextAttemptAt: { $exists: false } },
              { nextAttemptAt: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: {
          workerOwner: 'egress-worker-a',
          workerLeaseUntil: new Date('2026-08-08T10:00:30.000Z'),
        },
        $inc: { runVersion: 1 },
        $unset: { expiresAt: 1 },
      },
      { new: true, sort: { queueEnteredAt: 1, createdAt: 1 } },
    );
    expect(query.select).toHaveBeenCalledWith(
      '+payload +result +providerMetadata +usageContext +usageDelivery',
    );
  });

  test('rejects an empty v3 provider allowset without querying', async () => {
    const { methods, model } = createMethods();

    await expect(
      methods.acquireImageEgressJobLease({
        workerId: 'egress-worker-a',
        leaseMs: 30_000,
        statuses: ['waiting'],
        rolloutModes: ['canary'],
        allowset: [],
      }),
    ).resolves.toBeNull();
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('terminalizes only an inactive unleased v3 job with one atomic compare-and-set', async () => {
    const terminal = createQuery({ internalTaskId: 'task-v3', status: 'failed' });
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => terminal) });
    const now = new Date('2026-08-10T10:00:00.000Z');

    await methods.failInactiveImageEgressJob({
      internalTaskId: 'task-v3',
      errorCode: 'IMAGE_EGRESS_JOB_ACTIVATION_FAILED',
      error: 'activation failed',
      now,
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        internalTaskId: 'task-v3',
        asyncVersion: 3,
        workerFamily: 'image-egress-v1',
        status: 'waiting',
        workerEligible: false,
        $and: [
          { $or: [{ workerOwner: null }, { workerOwner: { $exists: false } }] },
          {
            $or: [
              { workerLeaseUntil: null },
              { workerLeaseUntil: { $exists: false } },
              { workerLeaseUntil: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: {
          status: 'failed',
          workerEligible: true,
          errorCode: 'IMAGE_EGRESS_JOB_ACTIVATION_FAILED',
          error: 'activation failed',
          completedAt: now,
        },
      },
      { new: true },
    );
    expect(terminal.select).toHaveBeenCalledWith(
      '+payload +result +providerMetadata +usageContext +usageDelivery',
    );
  });

  test('finds a v3 job by frontend or batch identity without matching v2 jobs', async () => {
    const frontendQuery = createQuery({ internalTaskId: 'task-front' });
    const batchQuery = createQuery({ internalTaskId: 'task-batch' });
    const findOne = jest.fn().mockReturnValueOnce(frontendQuery).mockReturnValueOnce(batchQuery);
    const { methods, model } = createMethods({ findOne });

    await methods.findImageEgressJobByIdentity({
      userId: 'user-1',
      frontendTaskId: 'front-1',
      businessType: 'product_replacement',
    });
    await methods.findImageEgressJobByIdentity({
      userId: 'user-1',
      batchTaskId: 'batch-1',
      itemId: 'item-1',
    });

    expect(model.findOne).toHaveBeenNthCalledWith(1, {
      'usageDelivery.payloadPruned': { $ne: true },
      userId: 'user-1',
      frontendTaskId: 'front-1',
      businessType: 'product_replacement',
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
    });
    expect(model.findOne).toHaveBeenNthCalledWith(2, {
      'usageDelivery.payloadPruned': { $ne: true },
      userId: 'user-1',
      batchTaskId: 'batch-1',
      itemId: 'item-1',
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
    });
    expect(frontendQuery.select).toHaveBeenCalledWith(
      '+payload +result +providerMetadata +usageContext +usageDelivery',
    );
    expect(batchQuery.select).toHaveBeenCalledWith(
      '+payload +result +providerMetadata +usageContext +usageDelivery',
    );
  });

  test('does not query a dedupe identity when neither complete identity is present', async () => {
    const { methods, model } = createMethods();

    await expect(
      methods.findImageEgressJobByIdentity({
        userId: 'user-1',
        businessType: 'product_replacement',
      }),
    ).resolves.toBeNull();
    expect(model.findOne).not.toHaveBeenCalled();
  });

  test('recognizes staged files owned by nonterminal v3 jobs only', async () => {
    const { methods, model } = createMethods({ countDocuments: jest.fn(async () => 1) });

    await expect(
      methods.hasNonterminalImageEgressJobReferencingFile({ fileId: 'file-input-1' }),
    ).resolves.toBe(true);

    expect(model.countDocuments).toHaveBeenCalledWith({
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
      status: { $in: ['waiting', 'submitting', 'polling'] },
      'payload.imageInputRefs.fileId': 'file-input-1',
    });
  });

  test('updates terminal state only for the matching live worker lease', async () => {
    const query = createQuery({ status: 'succeeded' });
    const { methods, model } = createMethods({ findOneAndUpdate: jest.fn(() => query) });
    const now = new Date('2026-08-04T10:00:00.000Z');

    await methods.updateImageGenerationJobWithLease({
      internalTaskId: 'task-1',
      workerId: 'worker-a',
      statuses: ['polling'],
      updates: { status: 'succeeded', submittedToProvider: true },
      releaseLease: true,
      now,
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        internalTaskId: 'task-1',
        status: { $in: ['polling'] },
        workerOwner: 'worker-a',
        workerLeaseUntil: { $gt: now },
      },
      {
        $set: {
          status: 'succeeded',
          submittedToProvider: true,
          workerOwner: null,
          workerLeaseUntil: null,
        },
      },
      { new: true },
    );
    expect(query.select).toHaveBeenCalledWith(
      '+payload +result +providerMetadata +usageContext +usageDelivery',
    );
  });

  test.each(['owned', 'unowned'])(
    'retains submit diagnostics across %s terminal updates',
    async (mode) => {
      const metadata = { submitDiagnostic: { phase: 'request_fetch', elapsedMs: 90001 } };
      const query = createQuery();
      query.lean.mockImplementation(async () => ({
        status: 'status_unknown',
        ...(query.select.mock.calls.some(([fields]) => fields.includes('+providerMetadata'))
          ? { providerMetadata: metadata }
          : {}),
      }));
      const { methods } = createMethods({ findOneAndUpdate: jest.fn(() => query) });
      const input = {
        internalTaskId: 'task-diagnostic',
        statuses: ['status_unknown' as const],
        updates: { usageRecorded: true },
      };
      const updated =
        mode === 'owned'
          ? await methods.updateImageGenerationJobWithLease({ ...input, workerId: 'worker-a' })
          : await methods.updateImageGenerationJob(input);
      expect(updated?.providerMetadata).toEqual(metadata);
    },
  );

  test('does not expose stored prompt and image payloads unless explicitly requested', async () => {
    const safeQuery = createQuery(null);
    const internalQuery = createQuery(null);
    const findOne = jest.fn().mockReturnValueOnce(safeQuery).mockReturnValueOnce(internalQuery);
    const { methods } = createMethods({ findOne });

    await methods.getImageGenerationJob({ internalTaskId: 'task-1' });
    await methods.getImageGenerationJob({ internalTaskId: 'task-1', includeSensitive: true });

    expect(safeQuery.select).not.toHaveBeenCalled();
    expect(internalQuery.select).toHaveBeenCalledWith(
      '+payload +result +usageContext +usageDelivery',
    );
  });

  test('counts active submitted provider tasks as a provider concurrency guard', async () => {
    const { methods, model } = createMethods({ countDocuments: jest.fn(async () => 1) });

    await methods.countActiveImageGenerationProviderTasks({
      resourceKey: 'apimart:key:gpt-image-2',
      excludeInternalTaskId: 'task-current',
    });

    expect(model.countDocuments).toHaveBeenCalledWith({
      provider: 'apimart',
      model: 'gpt-image-2',
      resourceKey: 'apimart:key:gpt-image-2',
      internalTaskId: { $nin: ['task-current'] },
      asyncVersion: 2,
      workerEligible: true,
      status: { $in: ['submitting', 'submitted', 'polling', 'status_unknown'] },
      $or: [
        { status: 'submitting' },
        {
          submittedToProvider: true,
          providerTaskId: { $exists: true, $type: 'string', $ne: '' },
        },
      ],
    });
  });
});
