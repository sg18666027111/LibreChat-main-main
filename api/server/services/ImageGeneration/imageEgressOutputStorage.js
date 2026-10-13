const { createHash, randomUUID } = require('crypto');
const { FileContext } = require('librechat-data-provider');
const { getAppConfig } = require('~/server/services/Config');
const { uploadImageBuffer } = require('~/server/services/Files/process');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const db = require('~/models');
const { downloadProviderResult, sniffImageContentType } = require('./providerResultDownload');
const { IMAGE_EGRESS_RETRY_POLICIES, runImageEgressTurnRetry } = require('./imageEgressRetry');

const IMAGE_EGRESS_OUTPUT_FILE_TTL_MS = 26 * 60 * 60 * 1000;
const IMAGE_EGRESS_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function sanitizeImageEgressOutputUrl(url) {
  const parsed = new URL(url);
  return {
    hostname: parsed.hostname.toLowerCase(),
    pathHash: shortHash(parsed.pathname),
    urlHash: shortHash(parsed.toString()),
    hasQuery: Boolean(parsed.search),
  };
}

async function downloadImageEgressOutput({
  url,
  provider,
  signal,
  retryPolicy = IMAGE_EGRESS_RETRY_POLICIES.output_download,
  deps = {},
}) {
  const result = await runImageEgressTurnRetry(
    () => downloadImageEgressOutputOnce({ url, provider, signal, deps }),
    {
      ...retryPolicy,
      sleep: deps.sleep,
      monotonicNow: deps.monotonicNow,
      random: deps.random,
    },
  );
  return {
    ...result.value,
    retryDiagnostics: { attempts: result.attempts, elapsedMs: result.elapsedMs },
  };
}

async function downloadImageEgressOutputOnce({ url, provider, signal, deps = {} }) {
  const download = deps.downloadProviderResult || downloadProviderResult;
  const result = await download({ url, provider, signal });
  return {
    buffer: result.buffer,
    contentType: result.contentType,
    sourceMetadata: {
      ...sanitizeImageEgressOutputUrl(url),
      redirectHostnames: result.redirectHostnames || [],
    },
  };
}

function getOutputFilename(contentType) {
  if (contentType === 'image/jpeg') {
    return 'image-egress-output.jpg';
  }
  if (contentType === 'image/webp') {
    return 'image-egress-output.webp';
  }
  return 'image-egress-output.png';
}

async function getStorageRequest(job, storageConfig) {
  const config =
    storageConfig || (await getAppConfig({ userId: job.userId, tenantId: job.tenantId }));
  return { config, user: { id: job.userId, tenantId: job.tenantId } };
}

async function storeImageEgressOutput({ job, downloaded, storageConfig, signal, deps = {} }) {
  if (!Buffer.isBuffer(downloaded?.buffer) || !downloaded.buffer.length) {
    const error = new Error('Image egress output is empty');
    error.code = 'RESULT_STORAGE_FAILED';
    throw error;
  }
  const upload = deps.uploadImageBuffer || uploadImageBuffer;
  const req = await getStorageRequest(job, storageConfig);
  const fileId = randomUUID();
  const expiresAt = new Date(Date.now() + IMAGE_EGRESS_OUTPUT_FILE_TTL_MS);
  const saved = await upload({
    req,
    context: FileContext.image_generation,
    resize: false,
    signal,
    durableIntent: true,
    metadata: {
      file_id: fileId,
      buffer: downloaded.buffer,
      bytes: downloaded.buffer.length,
      filename: `${job.internalTaskId}-${getOutputFilename(downloaded.contentType)}`,
      type: downloaded.contentType,
      expiredAt: expiresAt,
    },
  });
  if (!saved) {
    const error = new Error('Image egress output file was not created');
    error.code = 'RESULT_STORAGE_FAILED';
    throw error;
  }
  const savedFileId = saved?.file_id || fileId;
  return {
    fileRef: {
      fileId: savedFileId,
      filename: saved.filename,
      contentType: saved.type || downloaded.contentType,
      bytes: saved.bytes || downloaded.buffer.length,
    },
    expiresAt,
  };
}

async function readImageEgressOutput({ userId, tenantId, fileRef, storageConfig }) {
  const file = await db.findFileById(fileRef?.fileId, {
    user: userId,
    ...(tenantId ? { tenantId } : { tenantId: null }),
  });
  if (!file) {
    return null;
  }
  const req = await getStorageRequest({ userId, tenantId }, storageConfig);
  const { getDownloadStream } = getStrategyFunctions(file.source);
  if (!getDownloadStream) {
    const error = new Error('Image egress output storage cannot be read');
    error.code = 'RESULT_STORAGE_UNSUPPORTED';
    throw error;
  }
  const stream = await getDownloadStream(req, file.storageKey || file.filepath);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > IMAGE_EGRESS_OUTPUT_MAX_BYTES) {
      const error = new Error('Stored image egress output is too large');
      error.code = 'RESULT_FILE_TOO_LARGE';
      throw error;
    }
    chunks.push(buffer);
  }
  const buffer = Buffer.concat(chunks, bytes);
  const contentType = sniffImageContentType(buffer);
  if (!contentType || contentType !== file.type) {
    const error = new Error('Stored image egress output is invalid');
    error.code = 'RESULT_FILE_INVALID';
    throw error;
  }
  return { buffer, contentType };
}

async function cleanupUncommittedImageEgressOutput({ fileRef, jobId, storageConfig }) {
  const job = await db.getImageGenerationJob({ internalTaskId: jobId, includeSensitive: true });
  if (job?.result?.fileRef?.fileId === fileRef?.fileId) {
    return false;
  }
  const file = await db.findFileById(fileRef?.fileId);
  if (!file) {
    return true;
  }
  const req = await getStorageRequest(
    { userId: String(file.user), tenantId: file.tenantId },
    storageConfig,
  );
  const { deleteFile } = getStrategyFunctions(file.source);
  if (deleteFile) {
    await deleteFile(req, file);
  }
  await db.deleteFile(file.file_id);
  return true;
}

module.exports = {
  IMAGE_EGRESS_OUTPUT_FILE_TTL_MS,
  cleanupUncommittedImageEgressOutput,
  downloadImageEgressOutput,
  downloadImageEgressOutputOnce,
  readImageEgressOutput,
  sanitizeImageEgressOutputUrl,
  storeImageEgressOutput,
};
