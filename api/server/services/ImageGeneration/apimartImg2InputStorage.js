const { randomUUID } = require('crypto');
const { MAX_STAGED_IMAGE_BYTES } = require('@librechat/api');
const { FileContext } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');
const { getAppConfig } = require('~/server/services/Config');
const { uploadImageBuffer } = require('~/server/services/Files/process');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const db = require('~/models');

const APIMART_IMG2_INPUT_FILE_TTL_MS = 26 * 60 * 60 * 1000;
const APIMART_IMG2_MAX_STAGED_INPUT_BYTES = MAX_STAGED_IMAGE_BYTES;
const APIMART_IMG2_MAX_BASE64_LENGTH = Math.ceil(APIMART_IMG2_MAX_STAGED_INPUT_BYTES / 3) * 4;
const APIMART_IMG2_MAX_DATA_URL_HEADER_LENGTH = 256;
const APIMART_IMG2_MAX_BASE64_WHITESPACE_LENGTH = 1024 * 1024;
const APIMART_IMG2_MAX_RAW_PAYLOAD_LENGTH =
  APIMART_IMG2_MAX_BASE64_LENGTH + APIMART_IMG2_MAX_BASE64_WHITESPACE_LENGTH;

function getImageExtension(mimeType) {
  if (mimeType === 'image/jpeg') {
    return 'jpg';
  }
  if (mimeType === 'image/webp') {
    return 'webp';
  }
  return 'png';
}

function createSafeInputStorageError(error) {
  if (error?.code?.startsWith?.('APIMART_IMG2_INPUT_')) {
    return error;
  }
  const wrapped = new Error('参考图暂存失败，请稍后重试。');
  wrapped.code = 'APIMART_IMG2_INPUT_STORAGE_FAILED';
  wrapped.statusCode = 502;
  wrapped.cause = error;
  return wrapped;
}

function createInputError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isBase64CharacterCode(code) {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47
  );
}

function getBase64Value(code) {
  if (code >= 65 && code <= 90) {
    return code - 65;
  }
  if (code >= 97 && code <= 122) {
    return code - 71;
  }
  if (code >= 48 && code <= 57) {
    return code + 4;
  }
  return code === 43 ? 62 : 63;
}

function decodeValidatedBase64Payload(input, payloadStart, decodedLength) {
  const buffer = Buffer.alloc(decodedLength);
  let accumulator = 0;
  let bitCount = 0;
  let outputIndex = 0;

  for (let index = payloadStart; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (/\s/.test(input[index])) {
      continue;
    }
    if (code === 61) {
      break;
    }

    accumulator = (accumulator << 6) | getBase64Value(code);
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      buffer[outputIndex] = (accumulator >> bitCount) & 0xff;
      outputIndex += 1;
      accumulator &= bitCount ? (1 << bitCount) - 1 : 0;
    }
  }

  return buffer;
}

function parseImageDataUrl(value) {
  const input = String(value || '');
  const boundedHeader = input.slice(0, APIMART_IMG2_MAX_DATA_URL_HEADER_LENGTH + 1);
  const delimiterIndex = boundedHeader.indexOf(',');
  if (delimiterIndex < 0 || delimiterIndex === input.length - 1) {
    throw createInputError('参考图格式无效。', 'APIMART_IMG2_INPUT_INVALID', 400);
  }

  const headerMatch = /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(
    boundedHeader.slice(0, delimiterIndex),
  );
  if (!headerMatch) {
    throw createInputError('参考图格式无效。', 'APIMART_IMG2_INPUT_INVALID', 400);
  }

  const rawPayloadLength = input.length - delimiterIndex - 1;
  if (rawPayloadLength > APIMART_IMG2_MAX_RAW_PAYLOAD_LENGTH) {
    throw createInputError(
      '参考图超过供应商支持的大小，请压缩后重试。',
      'APIMART_IMG2_INPUT_TOO_LARGE',
      413,
    );
  }

  let encodedLength = 0;
  let paddingLength = 0;
  let whitespaceLength = 0;
  let sawPadding = false;
  for (let index = delimiterIndex + 1; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (isBase64CharacterCode(code)) {
      if (sawPadding) {
        throw createInputError('参考图格式无效。', 'APIMART_IMG2_INPUT_INVALID', 400);
      }
      encodedLength += 1;
    } else if (code === 61) {
      sawPadding = true;
      paddingLength += 1;
      encodedLength += 1;
      if (paddingLength > 2) {
        throw createInputError('参考图格式无效。', 'APIMART_IMG2_INPUT_INVALID', 400);
      }
    } else if (/\s/.test(input[index])) {
      whitespaceLength += 1;
      if (whitespaceLength > APIMART_IMG2_MAX_BASE64_WHITESPACE_LENGTH) {
        throw createInputError(
          '参考图超过供应商支持的大小，请压缩后重试。',
          'APIMART_IMG2_INPUT_TOO_LARGE',
          413,
        );
      }
      continue;
    } else {
      throw createInputError('参考图格式无效。', 'APIMART_IMG2_INPUT_INVALID', 400);
    }

    if (encodedLength > APIMART_IMG2_MAX_BASE64_LENGTH) {
      throw createInputError(
        '参考图超过供应商支持的大小，请压缩后重试。',
        'APIMART_IMG2_INPUT_TOO_LARGE',
        413,
      );
    }
  }

  if (!encodedLength) {
    throw createInputError('参考图内容为空。', 'APIMART_IMG2_INPUT_EMPTY', 400);
  }

  const remainder = encodedLength % 4;
  if (remainder === 1 || (paddingLength && remainder !== 0)) {
    throw createInputError('参考图格式无效。', 'APIMART_IMG2_INPUT_INVALID', 400);
  }

  let decodedLength = Math.floor(encodedLength / 4) * 3;
  if (paddingLength) {
    decodedLength -= paddingLength;
  } else if (remainder === 2) {
    decodedLength += 1;
  } else if (remainder === 3) {
    decodedLength += 2;
  }
  if (decodedLength > APIMART_IMG2_MAX_STAGED_INPUT_BYTES) {
    throw createInputError(
      '参考图超过供应商支持的大小，请压缩后重试。',
      'APIMART_IMG2_INPUT_TOO_LARGE',
      413,
    );
  }

  const mimeType = headerMatch[1].toLowerCase();
  const buffer = decodeValidatedBase64Payload(input, delimiterIndex + 1, decodedLength);
  if (!buffer.length) {
    throw createInputError('参考图内容为空。', 'APIMART_IMG2_INPUT_EMPTY', 400);
  }
  if (buffer.length > APIMART_IMG2_MAX_STAGED_INPUT_BYTES) {
    throw createInputError(
      '参考图超过供应商支持的大小，请压缩后重试。',
      'APIMART_IMG2_INPUT_TOO_LARGE',
      413,
    );
  }

  return { mimeType, buffer };
}

async function streamToBuffer(stream, maxBytes = APIMART_IMG2_MAX_STAGED_INPUT_BYTES) {
  if (!stream || typeof stream.on !== 'function') {
    const error = new Error('参考图读取失败。');
    error.code = 'APIMART_IMG2_INPUT_STREAM_INVALID';
    error.statusCode = 502;
    throw error;
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      const error = new Error('参考图超过供应商支持的大小，请压缩后重试。');
      error.code = 'APIMART_IMG2_INPUT_TOO_LARGE';
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

function buildStorageReq({ req, userId, tenantId, config }) {
  if (req) {
    return req;
  }
  return {
    config,
    user: {
      id: userId,
      tenantId,
    },
  };
}

async function getStorageReq({ req, userId, tenantId, storageConfig }) {
  if (req) {
    return req;
  }
  const config = storageConfig || (await getAppConfig({ userId, tenantId }));
  return buildStorageReq({ userId, tenantId, config });
}

function toInputRef({ savedFile, fallbackFileId, index, mimeType, bytes, metadata = {} }) {
  return {
    kind: 'file',
    index,
    fileId: savedFile.file_id || fallbackFileId,
    source: savedFile.source,
    filepath: savedFile.filepath,
    storageKey: savedFile.storageKey,
    storageRegion: savedFile.storageRegion,
    mimeType: savedFile.type || mimeType,
    bytes: savedFile.bytes || bytes,
    width: savedFile.width ?? metadata.width,
    height: savedFile.height ?? metadata.height,
  };
}

async function cleanupAPIMartImg2InputRefs({
  req,
  userId,
  tenantId,
  storageConfig,
  refs,
  payload,
}) {
  const inputRefs = refs || payload?.imageInputRefs || [];
  if (!Array.isArray(inputRefs) || !inputRefs.length) {
    return;
  }

  const storageReq = await getStorageReq({ req, userId, tenantId, storageConfig });
  await Promise.allSettled(
    inputRefs.map(async (ref) => {
      if (!ref?.fileId) {
        return;
      }
      let file = null;
      try {
        file = (typeof db.findFileById === 'function'
          ? await db.findFileById(ref.fileId, {
              user: userId || storageReq.user?.id,
              ...(tenantId || storageReq.user?.tenantId
                ? { tenantId: tenantId || storageReq.user?.tenantId }
                : { tenantId: null }),
            })
          : null) || {
          file_id: ref.fileId,
          source: ref.source,
          filepath: ref.filepath,
          storageKey: ref.storageKey,
          storageRegion: ref.storageRegion,
          filename: ref.filename || `${ref.fileId}.${getImageExtension(ref.mimeType)}`,
          type: ref.mimeType,
          bytes: ref.bytes || 0,
        };
        const { deleteFile } = getStrategyFunctions(file.source || ref.source);
        if (deleteFile) {
          await deleteFile(storageReq, file);
        }
        if (typeof db.deleteFile === 'function') {
          await db.deleteFile(ref.fileId);
        }
      } catch (error) {
        logger.warn('[ImageGeneration] APIMart img2 staged input cleanup failed', {
          fileId: ref.fileId,
          source: file?.source || ref.source || null,
          errorCode: error?.code || error?.statusCode || 'APIMART_IMG2_INPUT_CLEANUP_FAILED',
        });
      }
    }),
  );
}

async function stageAPIMartImg2ImageInputs({
  req,
  requestId,
  taskType,
  imageInputs,
  metadata = [],
}) {
  if (!Array.isArray(imageInputs) || !imageInputs.length) {
    return [];
  }

  const refs = [];
  try {
    for (const [index, imageInput] of imageInputs.entries()) {
      const parsed = parseImageDataUrl(imageInput);
      const fileId = randomUUID();
      const inputMetadata = metadata[index] || {};
      const extension = getImageExtension(parsed.mimeType);
      const filename = `apimart-img2-input-${requestId || fileId}-${index + 1}.${extension}`;
      const expiredAt = new Date(Date.now() + APIMART_IMG2_INPUT_FILE_TTL_MS);
      const savedFile = await uploadImageBuffer({
        req,
        context: FileContext.image_generation,
        resize: false,
        metadata: {
          file_id: fileId,
          buffer: parsed.buffer,
          width: inputMetadata.width,
          height: inputMetadata.height,
          bytes: parsed.buffer.length,
          filename,
          type: parsed.mimeType,
          expiredAt,
        },
      });
      const ref = toInputRef({
        savedFile,
        fallbackFileId: fileId,
        index,
        mimeType: parsed.mimeType,
        bytes: parsed.buffer.length,
        metadata: inputMetadata,
      });
      refs.push(ref);
    }
    return refs;
  } catch (error) {
    await cleanupAPIMartImg2InputRefs({ req, refs });
    logger.warn('[ImageGeneration] APIMart img2 staged input storage failed', {
      requestId,
      taskType,
      stagedInputCount: refs.length,
      errorCode: error?.code || error?.statusCode || 'APIMART_IMG2_INPUT_STORAGE_FAILED',
    });
    throw createSafeInputStorageError(error);
  }
}

async function resolveAPIMartImg2JobPayload({ userId, tenantId, payload, storageConfig, timing }) {
  if (!Array.isArray(payload?.imageInputRefs) || !payload.imageInputRefs.length) {
    return payload || {};
  }

  const storageReq = await getStorageReq({ userId, tenantId, storageConfig });
  const orderedRefs = [...payload.imageInputRefs].sort(
    (left, right) => (left.index ?? 0) - (right.index ?? 0),
  );
  const imageInputs = [];
  for (const [imageIndex, ref] of orderedRefs.entries()) {
    const stats = { imageIndex, imageCount: orderedRefs.length };
    const read = async () => {
      const file = await db.findFileById(ref.fileId, {
        user: userId,
        ...(tenantId ? { tenantId } : { tenantId: null }),
      });
      if (!file) {
        const error = new Error('参考图暂存文件不存在或已过期。');
        error.code = 'APIMART_IMG2_INPUT_FILE_MISSING';
        error.statusCode = 410;
        throw error;
      }
      const { getDownloadStream } = getStrategyFunctions(file.source || ref.source);
      if (!getDownloadStream) {
        const error = new Error('当前图片存储不支持读取。');
        error.code = 'APIMART_IMG2_INPUT_STORAGE_UNSUPPORTED';
        error.statusCode = 502;
        throw error;
      }
      const stream = await getDownloadStream(storageReq, file.storageKey || file.filepath);
      const buffer = await streamToBuffer(stream);
      stats.bytes = buffer.length;
      const mimeType = ref.mimeType || file.type || 'image/png';
      imageInputs.push(`data:${mimeType};base64,${buffer.toString('base64')}`);
    };
    if (timing) {
      await timing.measure('reference_read', read, stats);
    } else {
      await read();
    }
  }

  const { imageInputRefs: _imageInputRefs, ...restPayload } = payload;
  return {
    ...restPayload,
    imageInputs,
  };
}

async function cleanupAPIMartImg2JobInputRefs(job) {
  return cleanupAPIMartImg2InputRefs({
    userId: job.userId,
    tenantId: job.tenantId,
    payload: job.payload,
  });
}

module.exports = {
  APIMART_IMG2_INPUT_FILE_TTL_MS,
  APIMART_IMG2_MAX_STAGED_INPUT_BYTES,
  cleanupAPIMartImg2InputRefs,
  cleanupAPIMartImg2JobInputRefs,
  resolveAPIMartImg2JobPayload,
  stageAPIMartImg2ImageInputs,
};
