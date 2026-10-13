const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const {
  isMetricsConfigured,
  publishImageQueueSnapshot,
  recordImageQueueCollectionFailure,
} = require('@librechat/api');

async function readImageQueueSnapshot({
  model = mongoose.models.ImageGenerationJob,
  now = new Date(),
} = {}) {
  // Raw collection intentionally reads across tenants, exposing ONLY bounded aggregate counts.
  // Existing status index bounds the candidate set; no payloads, results or identities leave Mongo.
  const rows = await model.collection
    .aggregate(
      [
        {
          $match: {
            status: { $in: ['waiting', 'submitting', 'submitted', 'polling', 'status_unknown'] },
          },
        },
        {
          $group: {
            _id: {
              worker: {
                $switch: {
                  branches: [
                    {
                      case: {
                        $and: [
                          { $eq: ['$asyncVersion', 3] },
                          { $eq: ['$workerFamily', 'image-egress-v1'] },
                        ],
                      },
                      then: 'image_egress',
                    },
                    {
                      case: {
                        $and: [{ $eq: ['$asyncVersion', 2] }, { $eq: ['$provider', 'apimart'] }],
                      },
                      then: 'apimart_img2',
                    },
                  ],
                  default: 'legacy',
                },
              },
              status: '$status',
              eligibility: {
                $cond: [{ $eq: ['$workerEligible', true] }, 'eligible', 'ineligible'],
              },
            },
            count: { $sum: 1 },
            oldest: { $min: { $ifNull: ['$queueEnteredAt', '$createdAt'] } },
            expiredLeases: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: [{ $ifNull: ['$workerOwner', ''] }, ''] },
                      { $eq: [{ $type: '$workerLeaseUntil' }, 'date'] },
                      { $lte: ['$workerLeaseUntil', now] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ],
      { maxTimeMS: 2000, timeoutMS: 2500, allowDiskUse: false },
    )
    .toArray();
  return rows.map(({ _id, count, oldest, expiredLeases }) => ({
    ..._id,
    count,
    oldestEnteredAt: oldest instanceof Date ? oldest.getTime() / 1000 : 0,
    expiredLeases,
  }));
}

function startImageQueueMetrics({
  enabled = isMetricsConfigured(),
  intervalMs = 60_000,
  read = readImageQueueSnapshot,
} = {}) {
  if (!enabled) return null;
  let stopped = false;
  let pending = null;
  function sample() {
    if (stopped || pending) return;
    pending = Promise.resolve()
      .then(read)
      .then(
        (rows) => publishImageQueueSnapshot(rows, Date.now() / 1000),
        () => {
          recordImageQueueCollectionFailure();
          logger.warn('[metrics] Image queue snapshot failed; prior values are stale');
        },
      )
      .finally(() => {
        pending = null;
      });
  }
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  sample();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    async waitForIdle() {
      await pending;
    },
  };
}
module.exports = { readImageQueueSnapshot, startImageQueueMetrics };
