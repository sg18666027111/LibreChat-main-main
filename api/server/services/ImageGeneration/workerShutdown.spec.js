jest.mock('~/models', () => ({}));
jest.mock('~/server/services/UsageLedgerService', () => ({
  admitImageUsage: jest.fn(async () => null),
  releaseImageUsage: jest.fn(async () => {}),
  buildImageUsageEnvelope: jest.fn(() => null),
  recordImageUsage: jest.fn(),
}));

const flush = () => new Promise((resolve) => setImmediate(resolve));
let controllers;
let releases;
let originalEnv;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  releases.push(resolve);
  return { promise, resolve, reject };
}

function load(kind) {
  const isEgress = kind === 'egress';
  const service = require(isEgress ? './imageEgressAsync' : './apimartImg2Async');
  const start = (worker, initializeStorage = async () => {}) => {
    const controller = isEgress
      ? service.startImageEgressWorker({
          env: { IMAGE_EGRESS_ASYNC_MODE: 'all' },
          intervalMs: 60_000,
          deps: { createWorker: () => worker, initializeStorage },
        })
      : service.startAPIMartImg2JobWorker({ worker, intervalMs: 60_000 });
    if (controller) {
      controllers.push(controller);
    }
    return controller;
  };
  return {
    start,
    stop: () => (isEgress ? service.stopImageEgressWorker() : service.stopAPIMartImg2JobWorker()),
    wait: () =>
      isEgress ? service.waitForImageEgressWorker() : service.waitForAPIMartImg2JobWorker(),
    schedule: () =>
      isEgress
        ? service.scheduleImageEgressJobRun({ IMAGE_EGRESS_ASYNC_MODE: 'all' })
        : service.scheduleAPIMartImg2JobRun(),
  };
}

beforeEach(() => {
  jest.resetModules();
  controllers = [];
  releases = [];
  originalEnv = { ...process.env };
});

afterEach(async () => {
  controllers.forEach((controller) => controller.stop());
  releases.forEach((resolve) => resolve());
  await flush();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
});

describe.each(['apimart', 'egress'])('%s worker shutdown', (kind) => {
  test('publishes tick errors and idle completion while preserving shutdown behavior', async () => {
    process.env.METRICS_SECRET = 'test-secret';
    const express = require('express');
    const request = require('supertest');
    const { createMetrics } = require('@librechat/api');
    const app = express();
    app.use('/metrics', createMetrics().metricsRouter);
    const api = load(kind);
    let calls = 0;
    const controller = api.start({
      runOnce: async () => {
        if (++calls === 1) throw new Error('test DB failure');
        return null;
      },
    });
    await controller.runTick();
    await controller.runTick();
    api.stop();
    await controller.runTick();
    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);
    const worker = kind === 'apimart' ? 'apimart_img2' : 'image_egress';
    expect(response.text).toContain(
      `image_worker_ticks_total{worker="${worker}",result="error"} 1`,
    );
    expect(response.text).toContain(
      `image_worker_ticks_total{worker="${worker}",result="success"} 1`,
    );
    expect(response.text).toContain(`image_worker_ticks_in_flight{worker="${worker}"} 0`);
    expect(response.text).toContain(`image_worker_running{worker="${worker}"} 0`);
    expect(calls).toBe(2);
  });

  test('waits for every full tick despite another tick failing, and prevents restart', async () => {
    const api = load(kind);
    const first = deferred();
    const second = deferred();
    const persisted = [];
    let count = 0;
    const worker = {
      runOnce: async () => {
        const index = count++;
        await (index === 0 ? first.promise : second.promise);
        persisted.push(index);
      },
    };
    const controller = api.start(worker);
    const ticks = [controller.runTick(), controller.runTick()];
    await flush();
    expect(count).toBe(2);
    api.stop();
    let idle = false;
    const drained = api.wait().then(() => {
      idle = true;
    });
    expect(api.start(worker)).toBeNull();
    await controller.runTick();
    expect(count).toBe(2);
    first.reject(new Error('controlled tick failure'));
    await flush();
    expect(idle).toBe(false);
    second.resolve();
    await Promise.all([...ticks, drained]);
    expect(persisted).toEqual([1]);
    expect(idle).toBe(true);
    await api.wait();
  });

  test('retains in-flight work from a normally stopped controller across restart', async () => {
    const api = load(kind);
    const pending = deferred();
    const worker = { runOnce: () => pending.promise };
    const first = api.start(worker);
    const tick = first.runTick();
    await flush();
    first.stop();
    const second = api.start({ runOnce: async () => null });
    expect(second).not.toBe(first);
    api.stop();
    let idle = false;
    const drain = api.wait().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);
    pending.resolve();
    await Promise.all([tick, drain]);
    expect(idle).toBe(true);
  });

  test('fences queued immediate runs and scheduling from a late HTTP request', async () => {
    const api = load(kind);
    let claims = 0;
    const worker = {
      runOnce: async () => {
        claims += 1;
      },
    };
    api.start(worker);
    process.env.NODE_ENV = 'production';
    delete process.env.JEST_WORKER_ID;
    process.env.APIMART_IMG2_ASYNC_MODE = 'all';
    api.schedule();
    api.stop();
    api.schedule();
    await flush();
    await api.wait();
    expect(claims).toBe(0);
    expect(api.start(worker)).toBeNull();
  });
});

test('egress does not claim after initialization finishes during shutdown', async () => {
  const api = load('egress');
  const initializing = deferred();
  let claims = 0;
  const controller = api.start(
    {
      runOnce: async () => {
        claims += 1;
      },
    },
    () => initializing.promise,
  );
  const tick = controller.runTick();
  await flush();
  api.stop();
  initializing.resolve();
  await tick;
  await api.wait();
  expect(claims).toBe(0);
});

test('egress rollout all to off to all reports a paused controller without a false heartbeat alarm', async () => {
  process.env.METRICS_SECRET = 'rollout-test';
  const express = require('express');
  const request = require('supertest');
  const { createMetrics } = require('@librechat/api');
  const app = express();
  app.use('/metrics', createMetrics().metricsRouter);
  const env = { IMAGE_EGRESS_ASYNC_MODE: 'all' };
  let calls = 0;
  const controller = require('./imageEgressAsync').startImageEgressWorker({
    env,
    intervalMs: 60_000,
    deps: {
      initializeStorage: async () => {},
      createWorker: () => ({
        runOnce: async () => {
          calls++;
        },
      }),
    },
  });
  controllers.push(controller);
  const scrape = async () =>
    (await request(app).get('/metrics').set('Authorization', 'Bearer rollout-test').expect(200))
      .text;
  await controller.runTick();
  env.IMAGE_EGRESS_ASYNC_MODE = 'off';
  await controller.runTick();
  expect(await scrape()).toContain('image_worker_running{worker="image_egress"} 0');
  expect(calls).toBe(1);
  env.IMAGE_EGRESS_ASYNC_MODE = 'all';
  await controller.runTick();
  expect(await scrape()).toContain('image_worker_running{worker="image_egress"} 1');
  expect(calls).toBe(2);
});
