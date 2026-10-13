import { getBatchItemErrorMessage } from './batchErrorMessages';

describe('getBatchItemErrorMessage', () => {
  it.each([
    ['result_url_rejected', '生成结果地址未通过安全校验，请重试或联系管理员。'],
    ['result_download_failed', '生成已完成，但图片下载失败，请重试。'],
    ['invalid_image', '生成结果不是有效图片，请重试。'],
    ['normalization_failed', '图片尺寸处理失败，请重试。'],
    ['result_storage_failed', '生成已完成，但结果保存失败，请重新加载。'],
    ['provider_submit_unknown', '供应商提交状态无法确认，为避免重复计费，请联系管理员处理。'],
  ] as const)('maps %s to an operator-safe summary', (errorKind, expected) => {
    expect(getBatchItemErrorMessage({ errorKind, error: 'technical detail' })).toBe(expected);
  });

  it('falls back to the backend message for existing timeout/no-image errors', () => {
    expect(getBatchItemErrorMessage({ error: 'APIMart GPT Image 2 生成超时。' })).toBe(
      'APIMart GPT Image 2 生成超时。',
    );
  });
});
