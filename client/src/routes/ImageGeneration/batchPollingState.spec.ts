import {
  isProviderSubmitUnknownItem,
  mergePackagingBatchState,
  shouldPollPackagingBatch,
} from './batchPollingState';

const baseItem = {
  itemId: 'item-1',
  templateId: 'white_box_1',
};

describe('batch polling state', () => {
  test('only treats provider submit unknown as explicit failed backend state', () => {
    expect(
      isProviderSubmitUnknownItem({
        ...baseItem,
        status: 'failed',
        errorKind: 'provider_submit_unknown',
        errorMessage: '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。',
      }),
    ).toBe(true);
    expect(
      isProviderSubmitUnknownItem({
        ...baseItem,
        status: 'failed',
        errorMessage: '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。',
      }),
    ).toBe(false);
    expect(
      isProviderSubmitUnknownItem({
        ...baseItem,
        status: 'pending',
        errorKind: 'provider_submit_unknown',
      }),
    ).toBe(false);
  });

  test('does not keep polling a terminal provider submit unknown state', () => {
    const transition = {
      id: 'batch-1',
      status: 'failed' as const,
      items: [
        {
          ...baseItem,
          status: 'failed' as const,
          errorKind: 'provider_submit_unknown',
          error: '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。',
          errorMessage: '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。',
        },
      ],
    };

    expect(shouldPollPackagingBatch(transition)).toBe(false);
  });

  test('clears a stale provider submit unknown display when success arrives', () => {
    const transition = {
      id: 'batch-1',
      status: 'failed' as const,
      items: [
        {
          ...baseItem,
          status: 'failed' as const,
          errorKind: 'provider_submit_unknown',
          error: '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。',
          errorMessage: '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。',
        },
      ],
    };
    const succeeded = {
      id: 'batch-1',
      status: 'done' as const,
      items: [
        {
          ...baseItem,
          status: 'success' as const,
          resultImages: [{ url: '/api/batch/image-generation/batch-1/items/item-1/file' }],
        },
      ],
    };

    const merged = mergePackagingBatchState(transition, succeeded);

    expect(merged.status).toBe('done');
    expect(merged.items[0]).toMatchObject({ status: 'success', resultImages: succeeded.items[0].resultImages });
    expect(merged.items[0].error).toBeUndefined();
    expect(merged.items[0].errorKind).toBeUndefined();
    expect(merged.items[0].retryMode).toBeUndefined();
    expect(merged.items[0].errorMessage).toBeUndefined();
  });

  test('does not let an older submit-unknown response downgrade a newer succeeded item', () => {
    const succeeded = {
      id: 'batch-1',
      status: 'done' as const,
      items: [
        {
          ...baseItem,
          status: 'success' as const,
          resultImages: [{ url: '/api/batch/image-generation/batch-1/items/item-1/file' }],
        },
      ],
    };
    const lateOlderError = {
      id: 'batch-1',
      status: 'failed' as const,
      items: [
        {
          ...baseItem,
          status: 'failed' as const,
          errorKind: 'provider_submit_unknown',
          error: '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。',
          errorMessage: '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。',
        },
      ],
    };

    const merged = mergePackagingBatchState(succeeded, lateOlderError);

    expect(merged).toBe(succeeded);
    expect(shouldPollPackagingBatch(merged)).toBe(false);
  });

  test('does not let an older provider still-processing timeout downgrade a newer succeeded item', () => {
    const succeeded = {
      id: 'batch-1',
      status: 'done' as const,
      items: [
        {
          ...baseItem,
          status: 'success' as const,
          resultImages: [{ url: '/api/batch/image-generation/batch-1/items/item-1/file' }],
        },
      ],
    };
    const lateOlderStillProcessing = {
      id: 'batch-1',
      status: 'failed' as const,
      items: [
        {
          ...baseItem,
          status: 'failed' as const,
          providerStatus: 'IN_PROGRESS',
          retryMode: 'resume_polling' as const,
          error: '供应商仍在处理本次任务，系统将继续检查原任务。请勿重复提交，以免产生重复费用。',
          errorMessage: '供应商仍在处理本次任务，系统将继续检查原任务。请勿重复提交，以免产生重复费用。',
        },
      ],
    };

    const merged = mergePackagingBatchState(succeeded, lateOlderStillProcessing);

    expect(merged).toBe(succeeded);
    expect(shouldPollPackagingBatch(merged)).toBe(false);
  });
});
