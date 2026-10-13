/// <reference types="jest" />
import express from 'express';
import { createMetrics } from './metrics';
import {
  beginImageWorkerTick,
  setImageWorkerRunning,
  publishImageQueueSnapshot,
  recordImageQueueCollectionFailure,
} from './imageMetrics';
// @ts-expect-error The workspace does not install @types/supertest.
import request from 'supertest';

describe('image metric exposition', () => {
  let app: express.Express;
  beforeEach(() => {
    process.env.METRICS_SECRET = 'test-secret';
    app = express();
    app.use('/metrics', createMetrics().metricsRouter);
  });
  afterEach(() => {
    delete process.env.METRICS_SECRET;
  });
  const scrape = async () =>
    (await request(app).get('/metrics').set('Authorization', 'Bearer test-secret').expect(200))
      .text;

  test('concurrent ticks expose in-flight work, completion and failure without reporting a job success', async () => {
    setImageWorkerRunning('image_egress', true);
    const first = beginImageWorkerTick('image_egress');
    const second = beginImageWorkerTick('image_egress');
    expect(await scrape()).toContain('image_worker_ticks_in_flight{worker="image_egress"} 2');
    first('error');
    first('success'); // completion must be idempotent
    second('success');
    const text = await scrape();
    expect(text).toContain('image_worker_ticks_in_flight{worker="image_egress"} 0');
    expect(text).toContain('image_worker_ticks_total{worker="image_egress",result="error"} 1');
    expect(text).toContain('image_worker_ticks_total{worker="image_egress",result="success"} 1');
    expect(text).toMatch(/image_worker_last_tick_timestamp_seconds\{worker="image_egress"\} [1-9]/);
    setImageWorkerRunning('image_egress', false);
    expect(await scrape()).toContain('image_worker_running{worker="image_egress"} 0');
  });

  test('queue disappearance clears old series, whereas collection failure preserves stale values and freshness', async () => {
    publishImageQueueSnapshot(
      [
        {
          worker: 'apimart_img2',
          status: 'waiting',
          eligibility: 'eligible',
          count: 3,
          oldestEnteredAt: 100,
          expiredLeases: 1,
        },
      ],
      200,
    );
    recordImageQueueCollectionFailure();
    let text = await scrape();
    expect(text).toContain(
      'image_queue_jobs{worker="apimart_img2",status="waiting",eligibility="eligible"} 3',
    );
    expect(text).toContain('image_queue_snapshot_last_success_timestamp_seconds 200');
    expect(text).toContain('image_queue_snapshot_success 0');
    publishImageQueueSnapshot([], 300);
    text = await scrape();
    expect(text).toContain(
      'image_queue_jobs{worker="apimart_img2",status="waiting",eligibility="eligible"} 0',
    );
    expect(text).toContain(
      'image_queue_oldest_entered_timestamp_seconds{worker="apimart_img2",status="waiting",eligibility="eligible"} 0',
    );
    expect(text).toContain(
      'image_queue_expired_leases{worker="apimart_img2",status="waiting",eligibility="eligible"} 0',
    );
    expect(text).toContain('image_queue_snapshot_success 1');
  });

  test('runtime label validation prevents user-controlled labels and disabled metrics are inert', async () => {
    setImageWorkerRunning('private-user' as Parameters<typeof setImageWorkerRunning>[0], true);
    beginImageWorkerTick('private-task' as Parameters<typeof beginImageWorkerTick>[0])('error');
    publishImageQueueSnapshot(
      [
        {
          worker: 'legacy',
          status: 'private-status' as Parameters<
            typeof publishImageQueueSnapshot
          >[0][number]['status'],
          eligibility: 'eligible',
          count: 1,
          oldestEnteredAt: 0,
          expiredLeases: 0,
        },
      ],
      10,
    );
    expect(await scrape()).not.toMatch(/private-(user|task|status)/);
    delete process.env.METRICS_SECRET;
    const disabled = createMetrics();
    expect(() => beginImageWorkerTick('apimart_img2')('error')).not.toThrow();
    const other = express();
    other.use('/metrics', disabled.metricsRouter);
    await request(other).get('/metrics').expect(401);
  });
});
