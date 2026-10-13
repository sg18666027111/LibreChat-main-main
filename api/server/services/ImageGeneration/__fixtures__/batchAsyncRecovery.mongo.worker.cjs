/* Isolated process fixture. Only provider/output boundaries are replaced; the batch,
 * persistence, async wait, compiled schemas and Mongo methods are production code. */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const net = require('node:net');

const [uri, mode, batchId] = process.argv.slice(2);
assert.match(uri || '', /^mongodb:\/\/127\.0\.0\.1:\d+\/b02_release_[a-f0-9]+$/);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.MONGO_URI, undefined);
const mongoPort = new URL(uri).port;
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  assert.equal(options.host, '127.0.0.1', 'Only isolated localhost Mongo traffic is allowed');
  assert.equal(String(options.port), mongoPort, 'Only the isolated Mongo port is allowed');
  return originalConnect.apply(this, args);
};
const counts = { provider: 0, network: 0, enqueue: 0, writes: 0, linkFailures: 0 };
const blocked = () => {
  counts.provider += 1;
  throw new Error('Provider calls are forbidden in the release validation');
};
global.fetch = () => {
  counts.network += 1;
  throw new Error('HTTP calls are forbidden in the release validation');
};
for (const protocol of ['node:http', 'node:https']) {
  const transport = require(protocol);
  transport.request = transport.get = global.fetch;
}

const mongoose = new (require('mongoose').Mongoose)();
const schemas = require('@librechat/data-schemas');
schemas.createModels(mongoose);
const realDb = schemas.createMethods(mongoose);
const db = { ...realDb };
db.findOrCreateImageGenerationJob = async (...args) => {
  counts.enqueue += 1;
  return realDb.findOrCreateImageGenerationJob(...args);
};
db.updateImageBatchTaskItemWithLease = async (args) => {
  if (
    ['link-failure', 'retry-link-failure'].includes(mode) &&
    args.updates.internalTaskId &&
    !counts.linkFailures
  ) {
    counts.linkFailures += 1;
    throw new Error('Injected enqueue-to-link write failure');
  }
  return realDb.updateImageBatchTaskItemWithLease(args);
};

const serviceDir = path.resolve(__dirname, '..');
const apiDir = path.resolve(serviceDir, '../../..');
const originalLoad = Module._load;
const replacements = new Map();
function replace(relative, value) {
  replacements.set(path.join(serviceDir, relative), value);
}
const common = require('../adapters/apimart/common');
replace('adapters/apimart/common', {
  ...common,
  getAPIMartConfig: () => ({ apiKey: 'isolated-test-key' }),
  pollTask: blocked,
});
replace('adapters/apimart', { generateAPIMartImage: blocked, resumeAPIMartImage: blocked });
replace('adapters/fal', { generateFalImage: blocked });
replace('adapters/ark', { generateArkImage: blocked });
replace('siliconflow', { TEXT_TO_IMAGE_MODEL: 'Qwen/Qwen-Image', generateTextToImage: blocked });
replace('promptTemplateStore', {});
replace('normalizeImageOutput', {
  normalizeGeneratedImageOutput: async () => ({
    buffer: Buffer.from('isolated-test-image'),
    mimeType: 'image/png',
    width: 800,
    height: 800,
  }),
});
replace('batchResultStorage', {
  getBatchResultFilePath: (batch, item) => `/batch/${batch}/${item}/file`,
  toStoredBatchResultImage: ({ url: _url, ...image }) => image,
  toClientBatchResultImage: ({ batchId: id, itemId, resultImage }) => ({
    ...resultImage,
    url: `/batch/${id}/${itemId}/file`,
  }),
  saveBatchResultImage: async () => {
    counts.writes += 1;
    return { fileId: 'isolated-result', contentType: 'image/png' };
  },
});
Module._load = function (request, parent, isMain) {
  if (request === '@librechat/data-schemas') {
    return { ...schemas, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  }
  if (request === '~/models') return db;
  if (request === '~/server/services/UsageLedgerService')
    return {
      recordImageUsage: async () => ({ durableAccepted: true, ledgerPersisted: true }),
      admitImageUsage: async () => null,
      releaseImageUsage: async () => {},
      buildImageUsageEnvelope: () => null,
    };
  let resolved = request;
  if (request.startsWith('~/')) resolved = path.resolve(apiDir, request.slice(2));
  else if (request.startsWith('.')) resolved = path.resolve(path.dirname(parent.filename), request);
  if (replacements.has(resolved)) return replacements.get(resolved);
  return originalLoad.call(this, resolved, parent, isMain);
};
const {
  batchTaskStore,
  getBatchTask,
  retryBatchItem,
  serializeBatchTask,
} = require('../batchPackaging');
const { runAPIMartImg2JobAndWait } = require('../apimartImg2Async');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await sleep(30);
  }
  throw new Error('Timed out waiting for fixture state');
}
const read = () =>
  realDb.getImageBatchTaskItem({ batchId, itemId: 'item', includeSensitive: true });
const send = (value) => new Promise((resolve) => process.send(value, resolve));

async function main() {
  await mongoose.connect(uri, {
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 5000,
  });
  assert.equal(batchTaskStore.size, 0, 'Every worker starts without batch memory');
  if (mode === 'wait-updates') {
    const seen = [];
    const result = await runAPIMartImg2JobAndWait({
      userId: 'user',
      tenantId: 'tenant',
      batchTaskId: batchId,
      itemId: 'item',
      businessType: 'batch_image_generation',
      taskType: 'text-to-image',
      provider: 'apimart',
      model: 'gpt-image-2',
      pollIntervalMs: 20,
      providerRequest: { prompt: 'box', onProviderTaskSubmitted: blocked, onProviderPoll: blocked },
      onJobUpdate: async (snapshot) => {
        seen.push(snapshot.status);
        if (snapshot.status === 'waiting') {
          await mongoose.models.ImageGenerationJob.updateOne(
            { internalTaskId: snapshot.internalTaskId },
            {
              $set: {
                status: 'succeeded',
                providerTaskId: 'existing-paid-task',
                result: { images: [{ b64_json: 'dGVzdA==' }] },
              },
            },
          );
        }
      },
    });
    const job = await realDb.getImageGenerationJobByBatchItem({
      userId: 'user',
      tenantId: 'tenant',
      batchTaskId: batchId,
      itemId: 'item',
      model: 'gpt-image-2',
    });
    const sensitive = await realDb.getImageGenerationJob({
      internalTaskId: job.internalTaskId,
      includeSensitive: true,
    });
    assert.deepEqual(seen, ['waiting', 'succeeded']);
    assert.equal(typeof sensitive.payload.onProviderTaskSubmitted, 'undefined');
    assert.equal(typeof sensitive.payload.onProviderPoll, 'undefined');
    await send({ mode, counts, seen, result });
    return;
  }

  let task;
  if (mode === 'retry' || mode === 'retry-link-failure') {
    task = await retryBatchItem(batchId, 'style', 'user');
    if (mode === 'retry') {
      await until(async () => (await read()).internalJobStatus === 'waiting');
      await retryBatchItem(batchId, 'style', 'user');
      await until(async () => Boolean((await read()).internalTaskId));
      await send({ mode, counts, record: await read(), client: serializeBatchTask(task) });
      await new Promise(() => {}); // Parent ends this observer; providers stay blocked.
    }
  } else {
    task = await getBatchTask(batchId, 'user');
  }
  if (mode === 'queued-crash' || mode === 'fence') {
    await until(async () => {
      const current = await read();
      return (
        current.internalJobStatus === 'waiting' &&
        current.processingWorkerId?.startsWith('batch-worker-')
      );
    });
    const initial = await read();
    if (mode === 'queued-crash') {
      // Keep real timers and Mongo I/O; advance only the application wall clock.
      const RealDate = Date;
      let offset = 0;
      global.Date = class extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [RealDate.now() + offset]));
        }
        static now() {
          return RealDate.now() + offset;
        }
      };
      for (let i = 0; i < 4; i++) {
        offset += 4 * 60 * 1000;
        await sleep(1150);
        await getBatchTask(batchId, 'user');
        await sleep(50);
        const queued = await read();
        assert.equal(queued.status, 'processing');
        assert.ok(queued.processingLeaseUntil.getTime() > Date.now());
      }
      const queued = await read();
      assert.ok(queued.processingLeaseUntil > initial.processingLeaseUntil);
      await send({ mode, counts, record: queued, elapsedApplicationMs: offset });
      await new Promise(() => {}); // Parent SIGKILL simulates abrupt memory loss.
    } else {
      await mongoose.models.ImageBatchTask.updateOne(
        { batchId },
        {
          $set: {
            processingWorkerId: 'successor-worker',
            processingLeaseUntil: new Date(Date.now() + 60000),
          },
        },
      );
      await mongoose.models.ImageGenerationJob.updateOne(
        { internalTaskId: initial.internalTaskId },
        {
          $set: { status: 'succeeded', result: { images: [{ b64_json: 'dGVzdA==' }] } },
        },
      );
      await until(() => !task.runnerActive);
      const record = await read();
      assert.equal(record.processingWorkerId, 'successor-worker');
      assert.equal(record.status, 'processing');
      assert.equal(record.resultImage, undefined);
      assert.equal(counts.writes, 0);
      await send({ mode, counts, record });
    }
  } else {
    await until(() => ['done', 'failed'].includes(task.status) && !task.runnerActive);
    await send({ mode, counts, record: await read(), client: serializeBatchTask(task) });
  }
}
main()
  .then(async () => {
    assert.equal(counts.provider, 0);
    assert.equal(counts.network, 0);
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error.stack);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
