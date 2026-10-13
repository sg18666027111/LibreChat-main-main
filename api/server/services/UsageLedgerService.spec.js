jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

jest.mock('~/models', () => ({
  recordAIUsageEvent: jest.fn(async (input) => ({ _id: 'usage', ...input })),
}));

const db = require('~/models');
const { recordImageUsage } = require('./UsageLedgerService');

describe('UsageLedgerService image business classification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['text-to-image', undefined, 'image_generation'],
    ['single-image-edit', undefined, 'product_replacement'],
    ['multi-reference', 'multi-reference', 'multi_reference_generation'],
    ['multi-reference', 'dual-product-replace', 'product_replacement'],
    ['white-background', undefined, 'white_background'],
    ['batch-packaging', undefined, 'batch_image_generation'],
    ['canvas-action-run', undefined, 'canvas_generation'],
    ['main-image', undefined, 'main_image_generation'],
    ['detail-page', undefined, 'detail_page_generation'],
  ])('classifies %s/%s as %s', async (taskType, subMode, expectedBusinessType) => {
    await recordImageUsage({
      req: { user: { id: 'user-1', tenantId: 'tenant-1' } },
      requestId: 'request-1',
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
      modelKey: 'fal_gpt_image_2_edit',
      taskType,
      subMode,
      status: 'succeeded',
      imageCount: 1,
    });

    expect(db.recordAIUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        usageEventId: `${expectedBusinessType}:request-1:single`,
        userId: 'user-1',
        tenantId: 'tenant-1',
        businessType: expectedBusinessType,
        provider: 'fal',
        model: 'openai/gpt-image-2/edit',
        status: 'succeeded',
        imageCount: 1,
        requestCount: 1,
        metadata: expect.objectContaining({ taskType, subMode }),
      }),
    );
  });

  it('keeps explicit business types for specialized callers', async () => {
    await recordImageUsage({
      userId: 'user-2',
      tenantId: 'tenant-2',
      requestId: 'canvas-run-1',
      itemId: 'item-1',
      provider: 'ark',
      model: 'seedream',
      taskType: 'single-image-edit',
      businessType: 'canvas_generation',
      status: 'status_unknown',
      imageCount: 1,
      providerTaskId: 'provider-task-1',
    });

    expect(db.recordAIUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        usageEventId: 'canvas_generation:canvas-run-1:item-1',
        userId: 'user-2',
        tenantId: 'tenant-2',
        businessType: 'canvas_generation',
        status: 'status_unknown',
        imageCount: 1,
        metadata: expect.objectContaining({
          providerTaskId: 'provider-task-1',
        }),
      }),
    );
  });

  it('stores zero-cost submit ambiguity as metadata-only billing audit semantics', async () => {
    await recordImageUsage({
      userId: 'user-3',
      requestId: 'request-unknown',
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
      taskType: 'multi-reference',
      status: 'status_unknown',
      costCny: 0,
      billingConfirmed: false,
      metadata: { auditOnly: true, submitOutcome: 'unknown' },
    });

    expect(db.recordAIUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'status_unknown',
        requestCount: 1,
        imageCount: 0,
        costCny: 0,
        metadata: expect.objectContaining({
          billingConfirmed: false,
          auditOnly: true,
          submitOutcome: 'unknown',
        }),
      }),
    );
    expect(db.recordAIUsageEvent.mock.calls[0][0]).not.toHaveProperty('billingConfirmed');
  });

  it('keeps the existing event shape when optional audit fields are omitted', async () => {
    await recordImageUsage({
      userId: 'user-4',
      requestId: 'request-existing',
      provider: 'fal',
      model: 'fal-ai/nano-banana-pro',
      taskType: 'text-to-image',
      status: 'succeeded',
      imageCount: 1,
    });

    const event = db.recordAIUsageEvent.mock.calls[0][0];
    expect(event).not.toHaveProperty('costCny');
    expect(event.metadata).not.toHaveProperty('billingConfirmed');
  });
});
