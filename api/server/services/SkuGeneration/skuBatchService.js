const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');
const { composeSkuImage } = require('./composeSkuImage');
const { validateSkuInput } = require('./skuTemplate');
const { readSkuTemplateAsset } = require('./skuTemplateAssets');
const {
  getAuthorizedSkuFile,
  getStorageRequest,
  readAuthorizedSkuFile,
  saveSkuOutputFile,
} = require('./skuFileStorage');
const { serializeSkuBatch } = require('./skuBatchSerialization');

const SKU_WORKER_LEASE_MS = 60_000;

function createSkuBatchError(message, code, statusCode = 400, field) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (field) {
    error.field = field;
  }
  return error;
}

function createBatchId() {
  return `sku_batch_${crypto.randomUUID().replace(/-/g, '')}`;
}

function createItemId() {
  return `sku_item_${crypto.randomUUID().replace(/-/g, '')}`;
}

async function assertOwnedFile({ fileId, field, userId, tenantId }) {
  const file = await getAuthorizedSkuFile({ fileId, userId, tenantId });
  if (!file) {
    throw createSkuBatchError('素材不存在或无权访问。', 'SKU_FILE_NOT_FOUND', 404, field);
  }
  return file;
}

function scheduleBatchWorker(args) {
  setImmediate(() => {
    processSkuBatch(args).catch((error) => {
      logger.error('[SkuGeneration] batch worker failed', {
        batchId: args.batchId,
        errorCode: error?.code || 'SKU_BATCH_WORKER_FAILED',
      });
    });
  });
}

async function createSkuBatch({
  userId,
  tenantId,
  storageConfig,
  sourceFileId,
  leftIconFileId,
  rightIconFileId,
  templateKey,
  textRows,
  startWorker = true,
}) {
  if (!userId) {
    throw createSkuBatchError('用户身份无效。', 'SKU_USER_REQUIRED', 401);
  }
  const { textRows: normalizedRows, template } = validateSkuInput({ textRows, templateKey });
  await Promise.all([
    assertOwnedFile({ fileId: sourceFileId, field: 'sourceFileId', userId, tenantId }),
    ...(leftIconFileId
      ? [assertOwnedFile({ fileId: leftIconFileId, field: 'leftIconFileId', userId, tenantId })]
      : []),
    ...(rightIconFileId
      ? [assertOwnedFile({ fileId: rightIconFileId, field: 'rightIconFileId', userId, tenantId })]
      : []),
  ]);

  const batchId = createBatchId();
  const items = [];
  for (const [itemIndex, text] of normalizedRows.entries()) {
    const item = {
      userId,
      tenantId,
      batchId,
      itemId: createItemId(),
      itemIndex,
      sourceFileId,
      leftIconFileId,
      rightIconFileId,
      templateKey: template.key,
      text,
      status: 'pending',
      retryCount: 0,
    };
    await db.createSkuBatchTaskItem(item);
    items.push(item);
  }

  if (startWorker) {
    scheduleBatchWorker({ batchId, userId, tenantId, storageConfig });
  }
  return serializeSkuBatch({ batchId, items });
}

async function getSkuBatch(batchId, { userId, tenantId }) {
  const items = await db.getSkuBatchTaskItems({ batchId, userId, tenantId });
  if (!items?.length) {
    return null;
  }
  return serializeSkuBatch({ batchId, items });
}

async function processSkuBatch({
  batchId,
  userId,
  tenantId,
  storageConfig,
  workerId = `sku-worker-${process.pid}`,
}) {
  const items = await db.getSkuBatchTaskItems({ batchId, userId, tenantId });
  for (const item of items || []) {
    if (item.status !== 'pending') {
      continue;
    }
    await processSkuBatchItem({ item, userId, tenantId, storageConfig, workerId });
  }
  return getSkuBatch(batchId, { userId, tenantId });
}

async function processSkuBatchItem({ item, userId, tenantId, storageConfig, workerId }) {
  const leasedItem = await db.acquireSkuBatchTaskLease({
    batchId: item.batchId,
    itemId: item.itemId,
    workerId,
    leaseMs: SKU_WORKER_LEASE_MS,
    statuses: ['pending'],
  });
  if (!leasedItem) {
    return null;
  }

  const storageRequest = getStorageRequest({ config: storageConfig, userId, tenantId });
  try {
    const [sourceFile, leftIconFile, rightIconFile] = await Promise.all([
      getAuthorizedSkuFile({ fileId: leasedItem.sourceFileId, userId, tenantId }),
      leasedItem.leftIconFileId
        ? getAuthorizedSkuFile({ fileId: leasedItem.leftIconFileId, userId, tenantId })
        : null,
      leasedItem.rightIconFileId
        ? getAuthorizedSkuFile({ fileId: leasedItem.rightIconFileId, userId, tenantId })
        : null,
    ]);
    if (
      !sourceFile ||
      (leasedItem.leftIconFileId && !leftIconFile) ||
      (leasedItem.rightIconFileId && !rightIconFile)
    ) {
      throw createSkuBatchError('SKU 素材不存在或无权访问。', 'SKU_FILE_NOT_FOUND', 404);
    }
    const [source, leftIcon, rightIcon] = await Promise.all([
      readAuthorizedSkuFile(storageRequest, sourceFile),
      leftIconFile
        ? readAuthorizedSkuFile(storageRequest, leftIconFile)
        : readSkuTemplateAsset({ templateKey: leasedItem.templateKey, slot: 'leftIcon' }),
      rightIconFile
        ? readAuthorizedSkuFile(storageRequest, rightIconFile)
        : readSkuTemplateAsset({ templateKey: leasedItem.templateKey, slot: 'rightIcon' }),
    ]);
    const output = await composeSkuImage({
      sourceBuffer: source.buffer,
      leftIconBuffer: leftIcon.buffer,
      rightIconBuffer: rightIcon.buffer,
      text: leasedItem.text,
      templateKey: leasedItem.templateKey,
    });
    const savedOutput = await saveSkuOutputFile({
      req: storageRequest,
      batchId: leasedItem.batchId,
      itemId: leasedItem.itemId,
      output,
    });
    return db.updateSkuBatchTaskItemWithLease({
      batchId: leasedItem.batchId,
      itemId: leasedItem.itemId,
      workerId,
      statuses: ['running'],
      updates: {
        status: 'succeeded',
        outputFileId: savedOutput.fileId,
        completedAt: new Date(),
        error: undefined,
      },
    });
  } catch (error) {
    await db.updateSkuBatchTaskItemWithLease({
      batchId: leasedItem.batchId,
      itemId: leasedItem.itemId,
      workerId,
      statuses: ['running'],
      updates: {
        status: 'failed',
        error: error.message || 'SKU 图片合成失败。',
      },
    });
    return null;
  }
}

async function cancelSkuBatch(batchId, { userId, tenantId }) {
  const items = await db.getSkuBatchTaskItems({ batchId, userId, tenantId });
  if (!items?.length) {
    throw createSkuBatchError('SKU 批量任务不存在。', 'SKU_BATCH_NOT_FOUND', 404);
  }
  await Promise.all(
    items
      .filter((item) => item.status === 'pending')
      .map((item) =>
        db.updateSkuBatchTaskItem({
          batchId,
          itemId: item.itemId,
          userId,
          tenantId,
          statuses: ['pending'],
          updates: { status: 'cancelled', completedAt: new Date() },
        }),
      ),
  );
  return getSkuBatch(batchId, { userId, tenantId });
}

async function retrySkuBatchItem(
  batchId,
  itemId,
  { userId, tenantId, storageConfig, startWorker = true },
) {
  const item = await db.getSkuBatchTaskItem({ batchId, itemId, userId, tenantId });
  if (!item) {
    throw createSkuBatchError('SKU 子任务不存在。', 'SKU_ITEM_NOT_FOUND', 404);
  }
  if (item.status !== 'failed') {
    throw createSkuBatchError('只有失败的 SKU 子任务可以重试。', 'SKU_ITEM_NOT_RETRYABLE', 409);
  }
  await db.updateSkuBatchTaskItem({
    batchId,
    itemId,
    userId,
    tenantId,
    statuses: ['failed'],
    updates: {
      status: 'pending',
      retryCount: (item.retryCount || 0) + 1,
      error: undefined,
      outputFileId: undefined,
      completedAt: undefined,
    },
  });
  if (startWorker) {
    scheduleBatchWorker({ batchId, userId, tenantId, storageConfig });
  }
  return db.getSkuBatchTaskItem({ batchId, itemId, userId, tenantId });
}

module.exports = {
  SKU_WORKER_LEASE_MS,
  cancelSkuBatch,
  createSkuBatch,
  getSkuBatch,
  processSkuBatch,
  processSkuBatchItem,
  retrySkuBatchItem,
};
