import { getTokenHeader, request } from 'librechat-data-provider';
import type { SkuBatchSummary, SkuFile, SkuFileKind, SkuTemplateAssetSlot } from './types';
import { SKU_TEMPLATE_V1 } from './skuTemplate';

const SKU_BASE_PATH = '/api/sku-generation';

function getMessage(error: unknown, fallback: string) {
  const apiError = error as { response?: { data?: { message?: string } }; message?: string };
  return apiError.response?.data?.message || apiError.message || fallback;
}

export async function uploadSkuFile(file: File, kind: SkuFileKind): Promise<SkuFile> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('kind', kind);
  try {
    const response = (await request.postMultiPart(`${SKU_BASE_PATH}/sources`, formData)) as
      | SkuFile
      | { file?: SkuFile };
    return 'fileId' in response ? response : (response.file as SkuFile);
  } catch (error) {
    throw new Error(getMessage(error, '图片上传失败，请稍后重试。'));
  }
}

export async function createSkuBatch(input: {
  sourceFileId: string;
  templateKey: string;
  textRows: string[];
}): Promise<SkuBatchSummary> {
  try {
    return (await request.post(`${SKU_BASE_PATH}/batches`, input)) as SkuBatchSummary;
  } catch (error) {
    throw new Error(getMessage(error, 'SKU 批量任务创建失败，请稍后重试。'));
  }
}

export async function loadSkuTemplateAssetObjectUrl(
  templateKey: string,
  slot: SkuTemplateAssetSlot,
): Promise<string> {
  const response = await fetch(
    `${SKU_BASE_PATH}/templates/${encodeURIComponent(templateKey)}/assets/${encodeURIComponent(slot)}?v=${SKU_TEMPLATE_V1.assetVersion}`,
    {
      headers: {
        ...(getTokenHeader() ? { Authorization: getTokenHeader() } : {}),
      },
    },
  );
  if (!response.ok) {
    let message = '模板素材读取失败，请稍后重试。';
    try {
      const body = (await response.json()) as { message?: string };
      message = body.message || message;
    } catch {
      // Keep the operator-safe fallback for non-JSON responses.
    }
    throw new Error(message);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) {
    throw new Error('服务器返回的模板素材不是图片文件。');
  }
  return URL.createObjectURL(await response.blob());
}

export async function getSkuBatch(batchId: string): Promise<SkuBatchSummary> {
  try {
    return (await request.get(
      `${SKU_BASE_PATH}/batches/${encodeURIComponent(batchId)}`,
    )) as SkuBatchSummary;
  } catch (error) {
    throw new Error(getMessage(error, 'SKU 任务状态读取失败，请稍后重试。'));
  }
}

export async function cancelSkuBatch(batchId: string): Promise<SkuBatchSummary> {
  try {
    return (await request.post(
      `${SKU_BASE_PATH}/batches/${encodeURIComponent(batchId)}/cancel`,
      {},
    )) as SkuBatchSummary;
  } catch (error) {
    throw new Error(getMessage(error, 'SKU 任务取消失败，请稍后重试。'));
  }
}

export async function retrySkuBatchItem(batchId: string, itemId: string) {
  try {
    return await request.post(
      `${SKU_BASE_PATH}/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/retry`,
      {},
    );
  } catch (error) {
    throw new Error(getMessage(error, 'SKU 子任务重试失败，请稍后重试。'));
  }
}

export async function loadSkuFileObjectUrl(fileId: string): Promise<string> {
  const response = await fetch(`${SKU_BASE_PATH}/files/${encodeURIComponent(fileId)}`, {
    headers: {
      ...(getTokenHeader() ? { Authorization: getTokenHeader() } : {}),
    },
  });
  if (!response.ok) {
    let message = '图片读取失败，请稍后重试。';
    try {
      const body = (await response.json()) as { message?: string };
      message = body.message || message;
    } catch {
      // Keep the operator-safe fallback for non-JSON responses.
    }
    throw new Error(message);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) {
    throw new Error('服务器返回的不是图片文件。');
  }
  return URL.createObjectURL(await response.blob());
}

export async function downloadSkuFile(fileId: string, filename = 'sku.png'): Promise<void> {
  const objectUrl = await loadSkuFileObjectUrl(fileId);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
