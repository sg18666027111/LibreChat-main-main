/* eslint-disable i18next/no-literal-string */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SkuGeneration from './SkuGeneration';

const mockApi = {
  uploadSkuFile: jest.fn(),
  loadSkuTemplateAssetObjectUrl: jest.fn(),
  createSkuBatch: jest.fn(),
  getSkuBatch: jest.fn(),
  cancelSkuBatch: jest.fn(),
  retrySkuBatchItem: jest.fn(),
  loadSkuFileObjectUrl: jest.fn(),
  downloadSkuFile: jest.fn(),
};
const mockShowToast = jest.fn();

jest.mock('./api', () => ({
  uploadSkuFile: (...args: unknown[]) => mockApi.uploadSkuFile(...args),
  loadSkuTemplateAssetObjectUrl: (...args: unknown[]) =>
    mockApi.loadSkuTemplateAssetObjectUrl(...args),
  createSkuBatch: (...args: unknown[]) => mockApi.createSkuBatch(...args),
  getSkuBatch: (...args: unknown[]) => mockApi.getSkuBatch(...args),
  cancelSkuBatch: (...args: unknown[]) => mockApi.cancelSkuBatch(...args),
  retrySkuBatchItem: (...args: unknown[]) => mockApi.retrySkuBatchItem(...args),
  loadSkuFileObjectUrl: (...args: unknown[]) => mockApi.loadSkuFileObjectUrl(...args),
  downloadSkuFile: (...args: unknown[]) => mockApi.downloadSkuFile(...args),
}));
jest.mock('../ImageGeneration', () => ({
  __esModule: true,
  default: ({
    skuSourceWorkflow,
  }: {
    skuSourceWorkflow?: { onSourceReady: (payload: { fileId: string }) => void };
  }) => (
    <div data-testid="sku-embedded-image-edit">
      <button
        type="button"
        onClick={() => skuSourceWorkflow?.onSourceReady({ fileId: 'edited-source' })}
      >
        模拟改图完成
      </button>
    </div>
  ),
}));
jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

describe('SkuGeneration workbench template one', () => {
  beforeAll(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn(() => 'blob:upload'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.loadSkuFileObjectUrl.mockResolvedValue('blob:source');
    mockApi.loadSkuTemplateAssetObjectUrl.mockImplementation(async (_key: string, slot: string) =>
      slot === 'leftIcon' ? 'blob:template-left' : 'blob:template-right',
    );
    mockApi.getSkuBatch.mockResolvedValue({
      batchId: 'batch-1',
      status: 'pending',
      outputCount: 1,
      completedCount: 0,
      failedCount: 0,
      items: [{ itemId: 'item-1', itemIndex: 0, text: '商品卖点', status: 'pending' }],
    });
    mockApi.uploadSkuFile.mockResolvedValue({
      fileId: 'source-file',
      filename: 'source.png',
      contentType: 'image/png',
      previewUrl: 'blob:upload',
    });
    mockApi.createSkuBatch.mockResolvedValue({
      batchId: 'batch-1',
      status: 'pending',
      outputCount: 1,
      completedCount: 0,
      failedCount: 0,
      items: [{ itemId: 'item-1', itemIndex: 0, text: '商品卖点', status: 'pending' }],
    });
    mockApi.retrySkuBatchItem.mockResolvedValue({
      batchId: 'batch-1',
      status: 'pending',
      outputCount: 1,
      completedCount: 0,
      failedCount: 0,
      items: [{ itemId: 'item-1', itemIndex: 0, text: '商品卖点', status: 'pending' }],
    });
  });

  function renderPage(initialEntry = '/sku-generation') {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/sku-generation" element={<SkuGeneration />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  test('loads a source file and both fixed template assets', async () => {
    renderPage('/sku-generation?sourceFileId=source-1&sourceType=image-edit-result');

    expect(await screen.findByText('来自单图改图')).toBeInTheDocument();
    expect(mockApi.loadSkuFileObjectUrl).toHaveBeenCalledWith('source-1');
    expect(mockApi.loadSkuTemplateAssetObjectUrl).toHaveBeenCalledWith(
      'sku_red_delivery_label_v1',
      'leftIcon',
    );
    expect(mockApi.loadSkuTemplateAssetObjectUrl).toHaveBeenCalledWith(
      'sku_red_delivery_label_v1',
      'rightIcon',
    );
    expect(screen.getByTestId('sku-template-left-asset')).toHaveAttribute(
      'src',
      'blob:template-left',
    );
    expect(screen.getByTestId('sku-template-right-asset')).toHaveAttribute(
      'src',
      'blob:template-right',
    );
  });

  test('keeps the workbench content scrollable inside the app shell', () => {
    renderPage();

    expect(screen.getByRole('main')).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
  });

  test('does not render icon upload inputs and submits template one with only source and text', async () => {
    renderPage('/sku-generation?sourceFileId=source-1');

    expect(screen.queryByTestId('sku-left-icon-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sku-right-icon-input')).not.toBeInTheDocument();
    expect(screen.getByText('模板一：左上/右上固定素材 + 左下动态文字')).toBeInTheDocument();
    expect(screen.getByText('左上和右上素材由模板提供，第一版不可替换。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '批量生成' })).toBeDisabled();

    fireEvent.change(screen.getByTestId('sku-text-input-0'), { target: { value: '商品卖点' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '批量生成' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: '批量生成' }));
    await waitFor(() =>
      expect(mockApi.createSkuBatch).toHaveBeenCalledWith({
        sourceFileId: 'source-1',
        templateKey: 'sku_red_delivery_label_v1',
        textRows: ['商品卖点'],
      }),
    );
  });

  test('keeps long text on one line and grows the red badge', async () => {
    renderPage('/sku-generation?sourceFileId=source-1');
    const longText = '桂花蜜酱250g*2瓶';

    fireEvent.change(screen.getByTestId('sku-text-input-0'), { target: { value: longText } });

    const badge = await screen.findByTestId('sku-template-badge');
    expect(badge).toHaveTextContent(longText);
    expect(badge).toHaveClass('whitespace-nowrap');
    expect(badge).not.toHaveClass('right-');
  });

  test('accepts a direct source upload and advances to template one', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('sku-source-method-upload'));
    const source = new File(['source'], 'source.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('sku-source-input'), { target: { files: [source] } });

    expect(await screen.findByTestId('sku-source-origin')).toHaveTextContent('直接上传');
    expect(screen.getByText('模板一：左上/右上固定素材 + 左下动态文字')).toBeInTheDocument();
  });

  test('allows returning to source step without losing SKU text rows', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('sku-source-method-upload'));
    const source = new File(['source'], 'source.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('sku-source-input'), { target: { files: [source] } });
    await screen.findByTestId('sku-source-origin');

    const text = '桂花蜜酱250g*2瓶';
    fireEvent.change(screen.getByTestId('sku-text-input-0'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: '步骤 1 · 出源图' }));

    expect(screen.getByTestId('sku-step1-upload')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '步骤 2 · 制 SKU' }));
    expect(screen.getByTestId('sku-text-input-0')).toHaveValue(text);
  });

  test('accepts an embedded image-edit result and advances to template one', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '模拟改图完成' }));

    expect(await screen.findByTestId('sku-source-origin')).toHaveTextContent('来自单图改图');
    expect(screen.getByTestId('sku-change-source')).toBeInTheDocument();
  });

  test('shows a failed result with retry', async () => {
    renderPage('/sku-generation?sourceFileId=source-1');
    fireEvent.change(screen.getByTestId('sku-text-input-0'), { target: { value: '商品卖点' } });
    mockApi.getSkuBatch.mockResolvedValueOnce({
      batchId: 'batch-1',
      status: 'partial_failed',
      outputCount: 1,
      completedCount: 0,
      failedCount: 1,
      items: [
        { itemId: 'item-1', itemIndex: 0, text: '商品卖点', status: 'failed', error: '合成失败' },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: '批量生成' }));
    expect(await screen.findByText('合成失败')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(mockApi.retrySkuBatchItem).toHaveBeenCalledWith('batch-1', 'item-1');
  });

  test('shows a successful result with download and follow-up actions', async () => {
    renderPage('/sku-generation?sourceFileId=source-1');
    fireEvent.change(screen.getByTestId('sku-text-input-0'), { target: { value: '商品卖点' } });
    mockApi.getSkuBatch.mockResolvedValueOnce({
      batchId: 'batch-1',
      status: 'completed',
      outputCount: 1,
      completedCount: 1,
      failedCount: 0,
      items: [
        {
          itemId: 'item-1',
          itemIndex: 0,
          text: '商品卖点',
          status: 'succeeded',
          outputFileId: 'output-1',
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: '批量生成' }));
    expect((await screen.findAllByText('已完成')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    await waitFor(() =>
      expect(mockApi.downloadSkuFile).toHaveBeenCalledWith('output-1', 'sku-1.png'),
    );
    expect(screen.getByRole('button', { name: '再次制作 SKU 图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续单图改图' })).toBeInTheDocument();
  });
});
