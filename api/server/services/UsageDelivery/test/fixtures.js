function makeEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'image',
    sourceKey: 'test-call-1',
    revision: 1,
    occurredAt: '2026-09-20T00:00:00.000Z',
    expiresAt: '2026-10-20T00:00:00.000Z',
    reportingSubjectId: 'usage-subject-test-1',
    pricing: { kind: 'confirmed_cost', costCny: 0.25 },
    event: {
      usageEventId: 'image_generation:test-call-1:single',
      userId: '507f1f77bcf86cd799439011',
      businessType: 'image_generation',
      provider: 'fixture',
      model: 'fixture-image',
      status: 'succeeded',
      imageCount: 1,
    },
    ...overrides,
  };
}
module.exports = { makeEnvelope };
