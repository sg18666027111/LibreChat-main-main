import { Counter, Gauge, Histogram } from 'prom-client';
import type { Registry } from 'prom-client';

const workers = ['apimart_img2', 'image_egress'] as const;
const queueWorkers = [...workers, 'legacy'] as const;
const statuses = ['waiting', 'submitting', 'submitted', 'polling', 'status_unknown'] as const;
const eligibilities = ['eligible', 'ineligible'] as const;
type Worker = (typeof workers)[number];
export type ImageQueueRow = {
  worker: (typeof queueWorkers)[number];
  status: (typeof statuses)[number];
  eligibility: (typeof eligibilities)[number];
  count: number;
  oldestEnteredAt: number;
  expiredLeases: number;
};

type Recorders = {
  running: (worker: Worker, running: boolean) => void;
  begin: (worker: Worker) => (result: 'success' | 'error') => void;
  snapshot: (rows: ImageQueueRow[], timestamp: number) => void;
  failure: () => void;
};
let recorders: Recorders | undefined;

// Observability must never turn an accepted task into a retryable failure.
const safely = (action: () => void): void => {
  try {
    action();
  } catch {
    /* fail open */
  }
};
export function setImageWorkerRunning(worker: Worker, running: boolean): void {
  if (workers.includes(worker)) safely(() => recorders?.running(worker, running));
}
export function beginImageWorkerTick(worker: Worker): (result: 'success' | 'error') => void {
  let finish: ReturnType<Recorders['begin']> | undefined;
  if (workers.includes(worker))
    safely(() => {
      finish = recorders?.begin(worker);
    });
  let done = false;
  return (result) => {
    if (done) return;
    done = true;
    safely(() => finish?.(result === 'success' ? 'success' : 'error'));
  };
}
export function publishImageQueueSnapshot(rows: ImageQueueRow[], timestamp: number): void {
  safely(() => recorders?.snapshot(rows, timestamp));
}
export function recordImageQueueCollectionFailure(): void {
  safely(() => recorders?.failure());
}

export function initializeImageMetrics(registry?: Registry): void {
  recorders = undefined;
  if (!registry) return;
  const gauge = (name: string, help: string, labelNames: string[] = []) =>
    new Gauge({ name, help, labelNames, registers: [registry] });
  const running = gauge(
    'image_worker_running',
    'Worker controller is accepting ticks in this process',
    ['worker'],
  );
  const inFlight = gauge(
    'image_worker_ticks_in_flight',
    'Unsettled worker ticks, not provider jobs',
    ['worker'],
  );
  const heartbeat = gauge(
    'image_worker_last_tick_timestamp_seconds',
    'Last completed tick, including failures and idle ticks',
    ['worker'],
  );
  const ticks = new Counter({
    name: 'image_worker_ticks_total',
    help: 'Completed worker ticks, not job outcomes',
    labelNames: ['worker', 'result'],
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'image_worker_tick_duration_seconds',
    help: 'Worker tick duration including storage and provider waits',
    labelNames: ['worker', 'result'],
    buckets: [0.1, 1, 5, 30, 60, 300, 900],
    registers: [registry],
  });
  const labels = ['worker', 'status', 'eligibility'];
  const jobs = gauge(
    'image_queue_jobs',
    'Durable unfinished or unknown jobs at last successful snapshot; includes legacy records',
    labels,
  );
  const oldest = gauge(
    'image_queue_oldest_entered_timestamp_seconds',
    'Oldest queue entry timestamp; zero when empty',
    labels,
  );
  const leases = gauge(
    'image_queue_expired_leases',
    'Owned jobs whose worker lease expired at snapshot time',
    labels,
  );
  const success = gauge(
    'image_queue_snapshot_success',
    'Whether the latest queue snapshot succeeded',
  );
  const lastSuccess = gauge(
    'image_queue_snapshot_last_success_timestamp_seconds',
    'Last successful database snapshot timestamp; zero before first success',
  );
  const failures = new Counter({
    name: 'image_queue_snapshot_errors_total',
    help: 'Failed queue snapshots',
    registers: [registry],
  });
  success.set(0);
  lastSuccess.set(0);
  for (const worker of workers) {
    running.set({ worker }, 0);
    inFlight.set({ worker }, 0);
    heartbeat.set({ worker }, 0);
    for (const result of ['success', 'error']) ticks.inc({ worker, result }, 0);
  }
  recorders = {
    running: (worker, value) => running.set({ worker }, Number(value)),
    begin: (worker) => {
      inFlight.inc({ worker });
      const started = process.hrtime.bigint();
      return (result) => {
        inFlight.dec({ worker });
        heartbeat.set({ worker }, Date.now() / 1000);
        ticks.inc({ worker, result });
        duration.observe({ worker, result }, Number(process.hrtime.bigint() - started) / 1e9);
      };
    },
    snapshot: (rows, timestamp) => {
      if (!Number.isFinite(timestamp) || timestamp <= 0) return;
      for (const worker of queueWorkers)
        for (const status of statuses)
          for (const eligibility of eligibilities) {
            const row = rows.find(
              (r) => r.worker === worker && r.status === status && r.eligibility === eligibility,
            );
            const bounded = (value = 0) => (Number.isFinite(value) && value >= 0 ? value : 0);
            const key = { worker, status, eligibility };
            jobs.set(key, bounded(row?.count));
            oldest.set(key, bounded(row?.oldestEnteredAt));
            leases.set(key, bounded(row?.expiredLeases));
          }
      success.set(1);
      lastSuccess.set(timestamp);
    },
    failure: () => {
      success.set(0);
      failures.inc();
    },
  };
}
