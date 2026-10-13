const crypto = require('crypto');
const sharp = require('sharp');
const { FileContext } = require('librechat-data-provider');
const db = require('~/models');
const { uploadImageBuffer } = require('~/server/services/Files/process');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const {
  sniffImageContentType,
} = require('~/server/services/ImageGeneration/providerResultDownload');

const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SKU_FILE_MAX_BYTES = 20 * 1024 * 1024;

function createSkuStorageError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function getStorageRequest({ config, userId, tenantId }) {
  return {
    config,
    user: { id: userId, tenantId: tenantId || null },
  };
}

async function getImageMetadata(buffer, field) {
  try {
    const metadata = await sharp(buffer).metadata();
    const contentType = `image/${metadata.format === 'jpg' ? 'jpeg' : metadata.format}`;
    if (
      !Number.isInteger(metadata.width) ||
      !Number.isInteger(metadata.height) ||
      !ALLOWED_IMAGE_MIME_TYPES.has(contentType)
    ) {
      throw new Error('unsupported image');
    }
    return { ...metadata, contentType };
  } catch (cause) {
    throw Object.assign(
      createSkuStorageError('图片格式无效或无法读取。', 'SKU_IMAGE_INVALID', 400),
      { field, cause },
    );
  }
}

async function saveSkuSourceFile({ req, file, kind }) {
  if (!file?.buffer || !file.mimetype || !ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
    throw createSkuStorageError('只支持 PNG、JPG/JPEG、WebP 图片。', 'SKU_IMAGE_MIME_INVALID', 400);
  }
  if (file.size > 8 * 1024 * 1024 || file.buffer.length > 8 * 1024 * 1024) {
    throw createSkuStorageError('图片不能超过 8MB。', 'SKU_IMAGE_TOO_LARGE', 400);
  }
  if (!['source', 'icon'].includes(kind)) {
    throw createSkuStorageError('素材类型无效。', 'SKU_FILE_KIND_INVALID', 400);
  }
  const metadata = await getImageMetadata(file.buffer, 'file');
  const fileId = crypto.randomUUID();
  const savedFile = await uploadImageBuffer({
    req,
    context: FileContext.image_generation,
    resize: false,
    metadata: {
      file_id: fileId,
      buffer: file.buffer,
      width: metadata.width,
      height: metadata.height,
      bytes: file.buffer.length,
      filename: file.originalname || `${kind}.png`,
      type: file.mimetype,
    },
  });
  if (!savedFile) {
    throw createSkuStorageError('素材保存失败。', 'SKU_SOURCE_STORAGE_FAILED', 502);
  }
  return {
    fileId: savedFile.file_id || fileId,
    filename: savedFile.filename,
    contentType: savedFile.type || file.mimetype,
    bytes: savedFile.bytes || file.buffer.length,
    width: savedFile.width || metadata.width,
    height: savedFile.height || metadata.height,
  };
}

async function saveSkuOutputFile({ req, batchId, itemId, output }) {
  if (!Buffer.isBuffer(output?.buffer) || !output.buffer.length) {
    throw createSkuStorageError('SKU 结果图片为空。', 'SKU_RESULT_STORAGE_FAILED', 502);
  }
  const fileId = crypto.randomUUID();
  const savedFile = await uploadImageBuffer({
    req,
    context: FileContext.image_generation,
    resize: false,
    metadata: {
      file_id: fileId,
      buffer: output.buffer,
      width: output.width,
      height: output.height,
      bytes: output.buffer.length,
      filename: `sku-${batchId}-${itemId}.png`,
      type: output.mimeType || 'image/png',
    },
  });
  if (!savedFile) {
    throw createSkuStorageError('SKU 结果文件保存失败。', 'SKU_RESULT_STORAGE_FAILED', 502);
  }
  return {
    fileId: savedFile.file_id || fileId,
    filename: savedFile.filename,
    contentType: savedFile.type || output.mimeType || 'image/png',
    bytes: savedFile.bytes || output.buffer.length,
    width: savedFile.width || output.width,
    height: savedFile.height || output.height,
  };
}

async function getAuthorizedSkuFile({ fileId, userId, tenantId }) {
  if (!fileId || !userId) {
    return null;
  }
  return db.findFileById(fileId, {
    user: userId,
    tenantId: tenantId || null,
  });
}

async function readAuthorizedSkuFile(req, file, maxBytes = SKU_FILE_MAX_BYTES) {
  if (!file?.source) {
    throw createSkuStorageError('SKU 文件记录不存在。', 'SKU_FILE_NOT_FOUND', 404);
  }
  const { getDownloadStream } = getStrategyFunctions(file.source);
  if (!getDownloadStream) {
    throw createSkuStorageError('当前图片存储不支持读取。', 'SKU_STORAGE_UNSUPPORTED', 502);
  }
  const stream = await getDownloadStream(req, file.storageKey || file.filepath);
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw createSkuStorageError('图片超过允许大小。', 'SKU_FILE_TOO_LARGE', 413);
    }
    chunks.push(buffer);
  }
  const buffer = Buffer.concat(chunks, totalBytes);
  const contentType = sniffImageContentType(buffer);
  if (!contentType || !ALLOWED_IMAGE_MIME_TYPES.has(contentType)) {
    throw createSkuStorageError('图片内容或类型无效。', 'SKU_FILE_INVALID', 422);
  }
  if (
    file.type &&
    file.type !== contentType &&
    !(file.type === 'image/jpg' && contentType === 'image/jpeg')
  ) {
    throw createSkuStorageError('图片内容或类型无效。', 'SKU_FILE_INVALID', 422);
  }
  return { buffer, contentType };
}

function getSkuFilePath(fileId) {
  return `/api/sku-generation/files/${encodeURIComponent(fileId)}`;
}

module.exports = {
  ALLOWED_IMAGE_MIME_TYPES,
  SKU_FILE_MAX_BYTES,
  getAuthorizedSkuFile,
  getSkuFilePath,
  getStorageRequest,
  readAuthorizedSkuFile,
  saveSkuOutputFile,
  saveSkuSourceFile,
};
