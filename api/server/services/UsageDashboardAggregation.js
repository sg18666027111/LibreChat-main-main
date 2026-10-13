const QUERY_TIMEOUT_MS = 5000;
const RECENT_LIMIT = 100;
const RANKING_LIMIT = 50;
const STATUSES = ['submitted', 'succeeded', 'failed', 'cancelled', 'status_unknown'];
const COUNTS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cachedOutputTokens',
  'imageCount',
  'requestCount',
];
const IMAGE_BUSINESSES = [
  'image_generation',
  'multi_reference_generation',
  'product_replacement',
  'white_background',
  'batch_image_generation',
  'canvas_generation',
  'main_image_generation',
  'detail_page_generation',
];
const EVENT_FIELDS = Object.fromEntries(
  [
    '_id',
    'usageEventId',
    'occurredAt',
    'reportingSubjectId',
    'userId',
    'businessType',
    'provider',
    'model',
    'status',
    ...COUNTS,
    'costCny',
    'pricingMissing',
  ].map((field) => [field, 1]),
);

function emptyTotals() {
  return {
    eventCount: 0,
    userCount: 0,
    ...Object.fromEntries(COUNTS.map((field) => [field, 0])),
    costCny: 0,
    textCostCny: 0,
    imageCostCny: 0,
    failedCount: 0,
    statusCounts: Object.fromEntries(STATUSES.map((status) => [status, 0])),
  };
}

// Preserve the existing per-event Math.round(costCny * 100), not $round's ties-to-even.
// Compare the fractional part rather than floor(x + .5), which can itself round x up.
const cents = {
  $let: {
    vars: { scaled: { $multiply: [{ $ifNull: ['$costCny', 0] }, 100] } },
    in: {
      $add: [
        { $floor: '$$scaled' },
        { $cond: [{ $gte: [{ $subtract: ['$$scaled', { $floor: '$$scaled' }] }, 0.5] }, 1, 0] },
      ],
    },
  },
};

function sumFields() {
  return {
    eventCount: { $sum: 1 },
    ...Object.fromEntries(COUNTS.map((field) => [field, { $sum: { $ifNull: [`$${field}`, 0] } }])),
    costCents: { $sum: '$dashboardCents' },
    imageCostCents: { $sum: { $cond: ['$dashboardImage', '$dashboardCents', 0] } },
    textCostCents: { $sum: { $cond: ['$dashboardImage', 0, '$dashboardCents'] } },
    failedCount: { $sum: { $cond: [{ $in: ['$status', ['failed', 'status_unknown']] }, 1, 0] } },
    ...Object.fromEntries(
      STATUSES.map((status) => [
        `status_${status}`,
        { $sum: { $cond: [{ $eq: ['$status', status] }, 1, 0] } },
      ]),
    ),
  };
}

function totalFields() {
  return {
    _id: 0,
    eventCount: 1,
    userCount: { $literal: 0 },
    ...Object.fromEntries(COUNTS.map((field) => [field, 1])),
    costCny: { $divide: ['$costCents', 100] },
    textCostCny: { $divide: ['$textCostCents', 100] },
    imageCostCny: { $divide: ['$imageCostCents', 100] },
    failedCount: 1,
    statusCounts: Object.fromEntries(STATUSES.map((status) => [status, `$status_${status}`])),
  };
}

function ranking(id, fields) {
  return [
    {
      $group: {
        _id: id,
        ...sumFields(),
        latest: {
          $top: {
            sortBy: { occurredAt: -1, _id: -1 },
            output: {
              occurredAt: '$occurredAt',
              _id: '$_id',
              ...Object.fromEntries(fields.map((field) => [field, `$${field}`])),
            },
          },
        },
      },
    },
    { $sort: { costCents: -1, 'latest.occurredAt': -1, 'latest._id': -1 } },
    { $limit: RANKING_LIMIT },
    {
      $project: {
        ...totalFields(),
        ...Object.fromEntries(fields.map((field) => [field, `$latest.${field}`])),
      },
    },
  ];
}

function buildDashboardPipeline(filter) {
  return [
    { $match: filter },
    // Retain the existing time index; tie-breaking belongs in bounded top-k operations.
    { $sort: { occurredAt: -1 } },
    {
      $project: {
        ...EVENT_FIELDS,
        dashboardCents: cents,
        dashboardImage: {
          $or: [
            { $gt: [{ $ifNull: ['$imageCount', 0] }, 0] },
            { $in: ['$businessType', IMAGE_BUSINESSES] },
          ],
        },
      },
    },
    {
      $facet: {
        totals: [{ $group: { _id: null, ...sumFields() } }, { $project: totalFields() }],
        // Count subjects without building an unbounded array in a single BSON document.
        subjects: [{ $group: { _id: '$reportingSubjectId' } }, { $count: 'count' }],
        byUser: ranking('$reportingSubjectId', ['reportingSubjectId', 'userId']),
        byModel: ranking({ $concat: ['$provider', ':', '$model', ':', '$businessType'] }, [
          'provider',
          'model',
          'businessType',
        ]),
        byBusiness: ranking('$businessType', ['businessType']),
        recentEvents: [
          { $sort: { occurredAt: -1, _id: -1 } },
          { $limit: RECENT_LIMIT },
          { $project: EVENT_FIELDS },
        ],
      },
    },
  ];
}

module.exports = { buildDashboardPipeline, emptyTotals, QUERY_TIMEOUT_MS };
