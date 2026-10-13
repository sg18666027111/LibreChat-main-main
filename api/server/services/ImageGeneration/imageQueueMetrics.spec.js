const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { readImageQueueSnapshot, startImageQueueMetrics } = require('./imageQueueMetrics');

describe('durable image queue snapshot', () => {
  let server;
  let model;
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    model = mongoose.model('O01QueueFixture', new mongoose.Schema({}, { strict: false }));
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  beforeEach(async () => {
    await model.deleteMany({});
  });

  test('separates legacy records, unknown outcomes and ineligible staging without leaking identities', async () => {
    const now = new Date('2026-01-01T00:10:00Z');
    const base = {
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
      workerEligible: true,
      status: 'waiting',
      queueEnteredAt: new Date('2026-01-01T00:00:00Z'),
      userId: 'private-user',
      payload: { prompt: 'private-prompt' },
    };
    await model.insertMany([
      { ...base, workerOwner: 'owner', workerLeaseUntil: new Date('2026-01-01T00:09:00Z') },
      { ...base, workerLeaseUntil: new Date('2026-01-01T00:11:00Z') },
      { ...base, workerEligible: false },
      { ...base, asyncVersion: 1, workerFamily: undefined },
      { ...base, asyncVersion: 2, provider: 'apimart', status: 'status_unknown' },
      { ...base, status: 'succeeded' },
      { ...base, status: 'failed' },
    ]);
    const rows = await readImageQueueSnapshot({ model, now });
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          worker: 'image_egress',
          status: 'waiting',
          eligibility: 'eligible',
          count: 2,
          oldestEnteredAt: 1767225600,
          expiredLeases: 1,
        },
        {
          worker: 'image_egress',
          status: 'waiting',
          eligibility: 'ineligible',
          count: 1,
          oldestEnteredAt: 1767225600,
          expiredLeases: 0,
        },
        {
          worker: 'legacy',
          status: 'waiting',
          eligibility: 'eligible',
          count: 1,
          oldestEnteredAt: 1767225600,
          expiredLeases: 0,
        },
        {
          worker: 'apimart_img2',
          status: 'status_unknown',
          eligibility: 'eligible',
          count: 1,
          oldestEnteredAt: 1767225600,
          expiredLeases: 0,
        },
      ]),
    );
    expect(rows).toHaveLength(4);
    expect(JSON.stringify(rows)).not.toMatch(/private-|owner|payload/);
  });

  test('falls back to createdAt for old records and ignores unowned expired dates', async () => {
    await model.insertMany([
      {
        status: 'waiting',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        workerLeaseUntil: new Date(0),
      },
    ]);
    expect(await readImageQueueSnapshot({ model })).toEqual([
      {
        worker: 'legacy',
        status: 'waiting',
        eligibility: 'ineligible',
        count: 1,
        oldestEnteredAt: 1767225600,
        expiredLeases: 0,
      },
    ]);
  });
});

describe('queue sampler lifecycle', () => {
  afterEach(() => jest.useRealTimers());
  test('does not sample when metrics are disabled', async () => {
    let reads = 0;
    expect(
      startImageQueueMetrics({
        enabled: false,
        read: async () => {
          reads++;
          return [];
        },
      }),
    ).toBeNull();
    expect(reads).toBe(0);
  });
  test('a database failure is exposed without erasing the last good snapshot, then sampling recovers', async () => {
    const express = require('express');
    const request = require('supertest');
    const { createMetrics } = require('@librechat/api');
    const saved = process.env.METRICS_SECRET;
    process.env.METRICS_SECRET = 'queue-test';
    const app = express();
    app.use('/metrics', createMetrics().metricsRouter);
    jest.useFakeTimers();
    let reads = 0;
    const sampler = startImageQueueMetrics({
      enabled: true,
      intervalMs: 1000,
      read: async () => {
        if (++reads === 2) throw new Error('controlled database failure');
        return reads === 1
          ? [
              {
                worker: 'image_egress',
                status: 'waiting',
                eligibility: 'eligible',
                count: 2,
                oldestEnteredAt: 100,
                expiredLeases: 0,
              },
            ]
          : [];
      },
    });
    const scrape = async () =>
      (await request(app).get('/metrics').set('Authorization', 'Bearer queue-test').expect(200))
        .text;
    try {
      await sampler.waitForIdle();
      expect(await scrape()).toContain(
        'image_queue_jobs{worker="image_egress",status="waiting",eligibility="eligible"} 2',
      );
      jest.advanceTimersByTime(1000);
      await sampler.waitForIdle();
      const failed = await scrape();
      expect(failed).toContain('image_queue_snapshot_success 0');
      expect(failed).toContain('image_queue_snapshot_errors_total 1');
      expect(failed).toContain(
        'image_queue_jobs{worker="image_egress",status="waiting",eligibility="eligible"} 2',
      );
      jest.advanceTimersByTime(1000);
      await sampler.waitForIdle();
      const recovered = await scrape();
      expect(recovered).toContain('image_queue_snapshot_success 1');
      expect(recovered).toContain(
        'image_queue_jobs{worker="image_egress",status="waiting",eligibility="eligible"} 0',
      );
    } finally {
      sampler.stop();
      await sampler.waitForIdle();
      if (saved === undefined) delete process.env.METRICS_SECRET;
      else process.env.METRICS_SECRET = saved;
    }
  });

  test('coalesces slow reads, drains on stop and never starts another read', async () => {
    jest.useFakeTimers();
    let release;
    let reads = 0;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const sampler = startImageQueueMetrics({
      enabled: true,
      intervalMs: 1000,
      read: () => {
        reads++;
        return pending;
      },
    });
    await Promise.resolve();
    jest.advanceTimersByTime(5000);
    expect(reads).toBe(1);
    sampler.stop();
    let drained = false;
    const wait = sampler.waitForIdle().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release([]);
    await wait;
    jest.advanceTimersByTime(5000);
    expect(reads).toBe(1);
  });
});
