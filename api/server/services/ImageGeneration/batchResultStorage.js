const { FileContext } = require('librechat-data-provider');
const { randomUUID } = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { getAppConfig } = require('~/server/services/Config');
const { uploadImageBuffer } = require('~/server/services/Files/process');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { sniffImageContentType } = require('~/server/services/ImageGeneration/providerResultDownload');
const db = require('~/models');

// Keep the file available beyond its task record so TTL monitor timing cannot remove it first.
const BATCH_RESULT_FILE_TTL_MS = 26 * 60 * 60 * 1000;
const BATCH_RESULT_MAX_BYTES = 20 * 1024 * 1024;

function getBatchResultFilePath(batchId, itemId) {
  return `/api/batch/image-generation/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/file`;
}

function getBatchResultFilename(mimeType) {
  if (mimeType === 'image/jpeg') {
    return 'batch-main-image.jpg';
  }
  if (mimeType === 'image/webp') {
    return 'batch-main-image.webp';
  }
  return 'batch-main-image.png';
}

/**
 * 归一化为持久化形态。必须幂等：入参既可能是 StorageAdapter 的原始文件记录
 * （file_id / type），也可能是已映射过的 stored/client 形态（fileId / contentType）。
 * 成功转移处会对 createClientImage 的返回值再次调用本函数——若只读 file_id/type，
 * 双重映射会把 fileId/contentType 覆写为 undefined，落库即产生
 * “succeeded 但 resultImage.fileId 为空”的坏成功态。
 */
function toStoredBatchResultImage(file) {
  return {
    fileId: file.fileId ?? file.file_id ?? null,
    filename: file.filename,
    contentType: file.contentType ?? file.type ?? null,
    bytes: file.bytes,
    width: file.width,
    height: file.height,
  };
}

function toClientBatchResultImage({ batchId, itemId, resultImage }) {
  if (!resultImage?.fileId) {
    return resultImage;
  }
  const url = getBatchResultFilePath(batchId, itemId);
  return {
    ...resultImage,
    url,
    proxiedUrl: url,
    downloadUrl: `${url}?download=1`,
  };
}

async function getStorageRequest(task) {
  const config =
    task.storageConfig ||
    (await getAppConfig({ userId: task.userId, tenantId: task.tenantId }));
  return {
    config,
    user: {
      id: task.userId,
      tenantId: task.tenantId,
    },
  };
}

async function saveBatchResultImage({ task, item, output }) {
  if (!Buffer.isBuffer(output?.buffer) || !output.buffer.length) {
    const error = new Error('标准化图片结果为空。');
    error.code = 'RESULT_STORAGE_FAILED';
    throw error;
  }

  let storageRequest;
  let savedFile;
  const fileId = randomUUID();
  try {
    storageRequest = await getStorageRequest(task);
    savedFile = await uploadImageBuffer({
      req: storageRequest,
      context: FileContext.image_generation,
      resize: false,
      metadata: {
        file_id: fileId,
        buffer: output.buffer,
        width: output.width,
        height: output.height,
        bytes: output.buffer.length,
        filename: `batch-${task.id}-${item.itemId}-${getBatchResultFilename(output.mimeType)}`,
        type: output.mimeType,
      },
    });
    if (!savedFile) {
      const error = new Error('标准化图片结果未能创建存储记录。');
      error.code = 'RESULT_STORAGE_FAILED';
      throw error;
    }
    savedFile = { ...savedFile, file_id: savedFile.file_id || fileId };
    const retentionUpdated = await db.updateFile({
      file_id: savedFile.file_id,
      expiredAt: new Date(Date.now() + BATCH_RESULT_FILE_TTL_MS),
    });
    if (!retentionUpdated) {
      const error = new Error('标准化图片结果未能设置清理期限。');
      error.code = 'RESULT_STORAGE_FAILED';
      throw error;
    }
    return toStoredBatchResultImage(savedFile);
  } catch (error) {
    if (savedFile?.file_id && storageRequest) {
      try {
        const { deleteFile } = getStrategyFunctions(savedFile.source);
        if (deleteFile) {
          await deleteFile(storageRequest, savedFile);
        }
        await db.deleteFile(savedFile.file_id);
      } catch (cleanupError) {
        logger.warn('[BatchPackaging] normalized result storage cleanup failed', {
          batchId: task.id,
          itemId: item.itemId,
          errorCode: cleanupError?.code || 'RESULT_STORAGE_CLEANUP_FAILED',
        });
      }
    }
    logger.error('[BatchPackaging] normalized result storage failed', {
      batchId: task.id,
      itemId: item.itemId,
      errorCode: error?.code || 'RESULT_STORAGE_FAILED',
      errorName: error?.name || 'Error',
    });
    if (!error.code) {
      error.code = 'RESULT_STORAGE_FAILED';
    }
    throw error;
  }
}

async function getAuthorizedBatchResultFile({ task, itemId, userId, tenantId }) {
  const item = task?.items?.find((candidate) => candidate.itemId === itemId);
  const fileId = item?.resultImage?.fileId;
  if (!fileId) {
    return null;
  }
  if (task.userId !== userId || (task.tenantId || null) !== (tenantId || null)) {
    return null;
  }
  return db.findFileById(fileId, {
    user: userId,
    ...(tenantId ? { tenantId } : { tenantId: null }),
  });
}

async function getBatchResultStream(req, file) {
  const { getDownloadStream } = getStrategyFunctions(file.source);
  if (!getDownloadStream) {
    const error = new Error('当前图片存储不支持读取。');
    error.code = 'RESULT_STORAGE_UNSUPPORTED';
    throw error;
  }
  return getDownloadStream(req, file.storageKey || file.filepath);
}

async function getBatchResultBuffer(req, file, maxBytes = BATCH_RESULT_MAX_BYTES) {
  const stream = await getBatchResultStream(req, file);
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      const error = new Error('结果图片超过允许大小。');
      error.code = 'RESULT_FILE_TOO_LARGE';
      throw error;
    }
    chunks.push(buffer);
  }
  const buffer = Buffer.concat(chunks, totalBytes);
  const contentType = sniffImageContentType(buffer);
  if (!contentType || contentType !== file.type) {
    const error = new Error('结果图片内容或类型无效。');
    error.code = 'RESULT_FILE_INVALID';
    throw error;
  }
  return { buffer, contentType };
}

module.exports = {
  BATCH_RESULT_FILE_TTL_MS,
  BATCH_RESULT_MAX_BYTES,
  getAuthorizedBatchResultFile,
  getBatchResultBuffer,
  getBatchResultFilePath,
  getBatchResultStream,
  saveBatchResultImage,
  toClientBatchResultImage,
  toStoredBatchResultImage,
};
