/**
 * Opt-in B02 release gate. Run from the repository root with a locally installed
 * mongod (no downloads, dotenv, production credentials, or application bootstrap):
 * env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test B02_REAL_MONGO=1 \
 *   B02_MONGOD_BINARY=/absolute/path/to/mongod node node_modules/jest/bin/jest.js \
 *   --config api/server/services/ImageGeneration/__fixtures__/batchAsyncRecovery.mongo.config.cjs \
 *   --runInBand
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { randomBytes, randomInt } = require('node:crypto');
const { fork } = require('node:child_process');

const enabled = process.env.B02_REAL_MONGO === '1';
(enabled ? describe : describe.skip)('B02 isolated real Mongo recovery release gate', () => {
  let server;
  let mongoose;
  let db;
  let uri;
  let scratch;
  const children = new Set();
  const fixture = path.join(__dirname, '__fixtures__/batchAsyncRecovery.mongo.worker.cjs');
  const database = `b02_release_${randomBytes(12).toString('hex')}`;

  beforeAll(async () => {
    assert.equal(process.env.MONGO_URI, undefined);
    assert.ok(process.env.B02_MONGOD_BINARY);
    assert.ok(fs.existsSync(process.env.B02_MONGOD_BINARY));
    process.env.MONGOMS_RUNTIME_DOWNLOAD = 'false';
    const { MongoMemoryServer } = require('mongodb-memory-server');
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'b02-mongo-release-'));
    server = await MongoMemoryServer.create({
      binary: { systemBinary: process.env.B02_MONGOD_BINARY, checkMD5: false },
      // Avoid memory-server's wildcard-address port probe: mongod alone binds localhost.
      instance: {
        ip: '127.0.0.1',
        port: randomInt(20000, 60000),
        portGeneration: false,
        dbName: database,
        dbPath: scratch,
      },
    });
    uri = server.getUri(database).replace(/\/$/, '');
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/b02_release_[a-f0-9]+$/);
    mongoose = new (require('mongoose').Mongoose)();
    const { createModels, createMethods } = require('@librechat/data-schemas');
    createModels(mongoose);
    assert.ok(mongoose.models.ImageBatchTask.schema.path('internalTaskId'));
    assert.ok(mongoose.models.ImageBatchTask.schema.path('internalJobStatus'));
    db = createMethods(mongoose);
    await mongoose.connect(uri, {
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 5000,
    });
    await db.ensureImageGenerationJobStorage();
  });

  afterAll(async () => {
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise((resolve) => {
            child.once('exit', resolve);
            child.kill('SIGKILL');
          }),
      ),
    );
    const mongodPid = server?.instanceInfo?.instance?.mongodProcess?.pid;
    if (mongoose?.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose?.disconnect();
    await server?.stop({ doCleanup: true, force: true });
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    assert.equal(children.size, 0, 'All fixture processes must exit');
    if (scratch)
      assert.equal(fs.existsSync(scratch), false, 'Temporary Mongo data must be removed');
    if (mongodPid) assert.throws(() => process.kill(mongodPid, 0), { code: 'ESRCH' });
  });

  async function seed(batchId, overrides = {}, childOverrides = {}) {
    await db.createImageBatchTaskItem({
      userId: 'user',
      tenantId: 'tenant',
      batchId,
      itemId: 'item',
      templateId: 'style',
      templateName: 'Style',
      title: 'Box',
      prompt: 'draw a box',
      provider: 'apimart',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2_text',
      generationMode: 't2i',
      status: 'submitting',
      submitAttempt: 1,
      retryCount: 0,
      processingWorkerId: 'dead-worker',
      processingLeaseUntil: new Date(Date.now() - 1000),
      ...overrides,
    });
    if (childOverrides === null) return;
    await db.createImageGenerationJob({
      userId: 'user',
      tenantId: 'tenant',
      batchTaskId: batchId,
      itemId: 'item',
      internalTaskId: `child-${batchId}`,
      requestId: `request-${batchId}`,
      asyncVersion: 2,
      businessType: 'batch_image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      status: 'succeeded',
      providerTaskId: 'existing-paid-task',
      providerStatus: 'SUCCEEDED',
      result: { images: [{ b64_json: 'data:image/png;base64,dGVzdA==' }] },
      ...childOverrides,
    });
  }

  function worker(mode, batchId, asyncMode = 'off') {
    const child = fork(fixture, [uri, mode, batchId], {
      cwd: scratch,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', APIMART_IMG2_ASYNC_MODE: asyncMode },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: [],
    });
    children.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    let report;
    const message = new Promise((resolve, reject) => {
      child.once('message', (value) => {
        report = value;
        resolve(value);
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!report) reject(new Error(`Worker ${mode} exited ${code}: ${output}`));
      });
    });
    const exit = new Promise((resolve) =>
      child.once('exit', (code, signal) => {
        children.delete(child);
        resolve({ code, signal, output });
      }),
    );
    return { child, message, exit };
  }

  async function run(mode, batchId, asyncMode) {
    const process = worker(mode, batchId, asyncMode);
    const report = await process.message;
    const exited = await process.exit;
    if (exited.code !== 0)
      throw new Error(`Worker ${mode} failed: ${exited.output}\n${JSON.stringify(report)}`);
    expect(exited).toMatchObject({ code: 0, signal: null });
    expect(report.counts).toMatchObject({ provider: 0, network: 0 });
    return report;
  }

  test.each(['submitting', 'processing', 'failed'])(
    'fresh process hydrates %s and reuses existing child even with rollout off',
    async (status) => {
      const id = `hydrate-${status}`;
      await seed(id, { status });
      const report = await run('recover', id);
      expect(report.record).toMatchObject({
        status: 'succeeded',
        internalTaskId: `child-${id}`,
        providerTaskId: 'existing-paid-task',
        resultImage: { fileId: 'isolated-result' },
      });
      expect(report.client.items[0]).not.toHaveProperty('internalTaskId');
      expect(report.counts.enqueue).toBe(0);
      expect(await mongoose.models.ImageGenerationJob.countDocuments({ batchTaskId: id })).toBe(1);
    },
  );

  test('queued progress renews leases beyond 15 minutes; SIGKILL loses memory and restart reuses child', async () => {
    const id = 'queued-restart';
    await seed(id, { status: 'pending', submitAttempt: 0 }, null);
    const first = worker('queued-crash', id, 'all');
    const queued = await first.message;
    expect(queued.elapsedApplicationMs).toBe(16 * 60 * 1000);
    expect(queued.counts).toMatchObject({ enqueue: 1, provider: 0, network: 0 });
    expect(queued.record).toMatchObject({ status: 'processing', internalJobStatus: 'waiting' });
    first.child.kill('SIGKILL');
    expect(await first.exit).toMatchObject({ signal: 'SIGKILL' });
    await mongoose.models.ImageBatchTask.updateOne(
      { batchId: id },
      {
        $set: { processingLeaseUntil: new Date(Date.now() - 1) },
      },
    );
    await mongoose.models.ImageGenerationJob.updateOne(
      { internalTaskId: queued.record.internalTaskId },
      {
        $set: {
          status: 'succeeded',
          providerTaskId: 'existing-paid-task',
          result: { images: [{ b64_json: 'data:image/png;base64,dGVzdA==' }] },
        },
      },
    );
    const recovered = await run('recover', id);
    expect(recovered.record).toMatchObject({
      status: 'succeeded',
      internalTaskId: queued.record.internalTaskId,
    });
    expect(recovered.counts.enqueue).toBe(0);
    expect(await mongoose.models.ImageGenerationJob.countDocuments({ batchTaskId: id })).toBe(1);
  });

  test('real wait updates propagate waiting and succeeded; callbacks are excluded from BSON', async () => {
    const report = await run('wait-updates', 'wait-updates', 'all');
    expect(report.seen).toEqual(['waiting', 'succeeded']);
    expect(report.result.taskId).toBe('existing-paid-task');
  });

  test('Mongo lease fencing prevents an old observer from storing completed output', async () => {
    await seed(
      'fence',
      {
        status: 'processing',
        internalTaskId: 'child-fence',
        internalJobStatus: 'waiting',
        retryMode: 'resume_polling',
      },
      { status: 'waiting' },
    );
    const report = await run('fence', 'fence');
    expect(report.record).toMatchObject({
      status: 'processing',
      processingWorkerId: 'successor-worker',
    });
    expect(report.counts).toMatchObject({ enqueue: 0, writes: 0 });
  });

  test('enqueue-to-link write failure recovers the orphan durable child in a new process', async () => {
    const id = 'link-failure';
    await seed(id, { status: 'pending', submitAttempt: 0 }, null);
    const failed = await run('link-failure', id, 'all');
    expect(failed.counts).toMatchObject({ enqueue: 1, linkFailures: 1 });
    expect(failed.record.status).toBe('failed');
    expect(failed.record.internalTaskId).toBeUndefined();
    const job = await mongoose.models.ImageGenerationJob.findOne({ batchTaskId: id }).lean();
    expect(job.status).toBe('waiting');
    await mongoose.models.ImageGenerationJob.updateOne(
      { internalTaskId: job.internalTaskId },
      {
        $set: {
          status: 'succeeded',
          providerTaskId: 'existing-paid-task',
          result: { images: [{ b64_json: 'data:image/png;base64,dGVzdA==' }] },
        },
      },
    );
    const report = await run('recover', id);
    expect(report.record).toMatchObject({
      status: 'succeeded',
      internalTaskId: job.internalTaskId,
    });
    expect(report.counts.enqueue).toBe(0);
    expect(await mongoose.models.ImageGenerationJob.countDocuments({ batchTaskId: id })).toBe(1);
  });
  test.each(['retry', 'retry-link-failure'])(
    'explicit %s persists a new identity and a fresh process recovers only that attempt',
    async (mode) => {
      const id = `new-attempt-${mode}`;
      await seed(
        id,
        {
          status: 'failed',
          internalTaskId: `child-${id}`,
          internalJobStatus: 'failed',
          providerTaskId: 'old-provider-task',
          providerStatus: 'FAILED',
          retryMode: 'resubmit_provider',
          processingWorkerId: null,
          processingLeaseUntil: null,
        },
        { status: 'failed', providerStatus: 'FAILED', providerTaskId: 'old-provider-task' },
      );
      const first = worker(mode, id, 'all');
      const report = await first.message;
      expect(report.counts).toMatchObject({ enqueue: 1, provider: 0, network: 0 });
      expect(report.record.internalJobItemId).toBeTruthy();
      expect(report.record.retryCount).toBe(1);
      const jobs = await mongoose.models.ImageGenerationJob.find({ batchTaskId: id }).lean();
      expect(jobs).toHaveLength(2);
      const fresh = jobs.find((job) => job.internalTaskId !== `child-${id}`);
      expect(fresh).toMatchObject({ itemId: report.record.internalJobItemId, status: 'waiting' });
      // The actual production unique index must deduplicate this attempt too.
      const duplicate = await db.findOrCreateImageGenerationJob({
        ...fresh,
        _id: undefined,
        internalTaskId: 'duplicate-attempt',
      });
      expect(duplicate.deduplicated).toBe(true);
      expect(duplicate.job.internalTaskId).toBe(fresh.internalTaskId);
      if (mode === 'retry') {
        first.child.kill('SIGKILL');
        expect(await first.exit).toMatchObject({ signal: 'SIGKILL' });
      } else {
        expect(await first.exit).toMatchObject({ code: 0 });
        expect(report.record.internalTaskId).toBeUndefined();
        expect(report.record.retryMode).toBeUndefined();
      }
      await mongoose.models.ImageBatchTask.updateOne(
        { batchId: id },
        {
          $set: { processingLeaseUntil: new Date(Date.now() - 1) },
        },
      );
      await mongoose.models.ImageGenerationJob.updateOne(
        { internalTaskId: fresh.internalTaskId },
        {
          $set: {
            status: 'succeeded',
            providerTaskId: 'new-provider-task',
            result: { images: [{ b64_json: 'data:image/png;base64,dGVzdA==' }] },
          },
        },
      );
      const recovered = await run('recover', id);
      expect(recovered.record).toMatchObject({
        status: 'succeeded',
        internalTaskId: fresh.internalTaskId,
        internalJobItemId: fresh.itemId,
        providerTaskId: 'new-provider-task',
      });
      expect(recovered.counts.enqueue).toBe(0);
      expect(await mongoose.models.ImageGenerationJob.countDocuments({ batchTaskId: id })).toBe(2);
      expect(recovered.client.items[0].itemId).toBe('item');
    },
  );

  test.each([false, true])(
    'retry CAS prevents stale requests replacing an unknown attempt (legacy=%s)',
    async (legacy) => {
      const id = `retry-cas-${legacy}`;
      await seed(id, {
        status: 'failed',
        retryMode: 'resubmit_provider',
        providerStatus: 'FAILED',
      });
      if (legacy)
        await mongoose.models.ImageBatchTask.updateOne(
          { batchId: id },
          { $unset: { retryCount: 1 } },
        );
      const observed = {
        batchId: id,
        itemId: 'item',
        statuses: ['failed'],
        expectedRetryCount: 0,
        expectedInternalJobItemId: null,
      };
      const results = await Promise.all(
        ['attempt-a', 'attempt-b'].map((internalJobItemId) =>
          db.updateImageBatchTaskItem({
            ...observed,
            updates: { status: 'pending', retryCount: 1, internalJobItemId },
          }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.find(Boolean);
      await mongoose.models.ImageBatchTask.updateOne(
        { batchId: id },
        {
          $set: {
            status: 'failed',
            internalJobStatus: 'status_unknown',
            errorKind: 'provider_submit_unknown',
          },
          $unset: { retryMode: 1 },
        },
      );
      expect(
        await db.updateImageBatchTaskItem({
          ...observed,
          updates: { status: 'pending', retryCount: 1, internalJobItemId: 'stale-attempt' },
        }),
      ).toBeNull();
      const record = await db.getImageBatchTaskItem({ batchId: id, itemId: 'item' });
      expect(record).toMatchObject({
        internalJobItemId: winner.internalJobItemId,
        internalJobStatus: 'status_unknown',
      });
    },
  );
});
