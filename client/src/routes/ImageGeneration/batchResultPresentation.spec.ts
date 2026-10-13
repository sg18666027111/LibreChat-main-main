import {
  createBatchResultImage,
  getBatchResultFileUrl,
  getBatchResultRecoveryUrl,
  getBatchRetryAction,
  getBatchStatusPresentation,
  getBatchTaskStatusPresentation,
  isProviderStillProcessingItem,
  isBatchResultFileUrl,
} from './batchResultPresentation';

describe('batch result presentation', () => {
  test('uses the authenticated batch result endpoint for preview and download', () => {
    const url = getBatchResultFileUrl('batch_1', 'item_1');
    expect(url).toBe('/api/batch/image-generation/batch_1/items/item_1/file');
    expect(getBatchResultRecoveryUrl('batch_1', 'item_1')).toBe(
      '/api/batch/image-generation/batch_1/items/item_1/recover-result',
    );
    expect(createBatchResultImage('batch_1', 'item_1')).toEqual({
      url,
      proxiedUrl: url,
      downloadUrl: `${url}?download=1`,
    });
    expect(isBatchResultFileUrl(url)).toBe(true);
    expect(isBatchResultFileUrl(`${url}?download=1`)).toBe(true);
    expect(isBatchResultFileUrl('https://provider.example.com/signed.png')).toBe(false);
    expect(isBatchResultFileUrl('/api/image-generation/result-proxy/token')).toBe(false);
  });

  test('only offers a provider regeneration after a provider failure', () => {
    expect(getBatchRetryAction('failed', 'resubmit_provider')).toEqual({
      label: '重新生成',
      mode: 'regenerate',
    });
    expect(getBatchRetryAction('failed', 'reprocess_result')).toEqual({
      label: '重新加载',
      mode: 'reload',
    });
    expect(getBatchRetryAction('failed', undefined)).toBeNull();
    expect(getBatchRetryAction('succeeded', 'resubmit_provider')).toBeNull();
    expect(getBatchRetryAction('cancelled', 'resubmit_provider')).toBeNull();
  });

  test('presents long IN_PROGRESS provider tasks as still processing instead of retryable failures', () => {
    const item = {
      status: 'failed',
      retryMode: 'resume_polling',
      providerStatus: 'IN_PROGRESS',
    };

    expect(isProviderStillProcessingItem(item)).toBe(true);
    expect(getBatchStatusPresentation(item)).toEqual({
      label: '生成时间较长',
      message: '供应商仍在处理本次任务，系统将继续检查原任务。请勿重复提交，以免产生重复费用。',
    });
    expect(getBatchRetryAction('failed', 'resume_polling', { providerStatus: 'IN_PROGRESS' })).toEqual({
      label: '继续检查',
      mode: 'continue_check',
    });
    expect(getBatchTaskStatusPresentation([item])).toEqual({
      label: '生成时间较长',
      message: '供应商仍在处理本次任务，系统将继续检查原任务。请勿重复提交，以免产生重复费用。',
    });
  });
});
