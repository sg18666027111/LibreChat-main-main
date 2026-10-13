const express = require('express');
const multer = require('multer');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const configMiddleware = require('~/server/middleware/config/app');
const {
  cancelBatchTask,
  createBatchTask,
  getBatchTask,
  recoverBatchItemResult,
  retryBatchItem,
  serializeBatchTask,
} = require('~/server/services/ImageGeneration/batchPackaging');
const {
  getAuthorizedBatchResultFile,
  getBatchResultBuffer,
} = require('~/server/services/ImageGeneration/batchResultStorage');

const router = express.Router();
const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const uploadReferenceImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('只支持 PNG、JPG/JPEG、WebP 图片。'));
    }
    cb(null, true);
  },
}).single('referenceImage');

router.use(requireJwtAuth);
// 注入 req.config（含 paths），本地存储读取（getLocalFileStream）依赖 req.config.paths。
router.use(configMiddleware);

function parseTemplateIds(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === '') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return String(value)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function fileToDataUrl(file) {
  if (!file?.buffer || !file?.mimetype) {
    return undefined;
  }
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

function canAccessBatchTask(req, task) {
  return Boolean(
    task &&
      task.userId === req.user?.id &&
      (task.tenantId || null) === (req.user?.tenantId || null),
  );
}

router.post('/', (req, res) => {
  uploadReferenceImage(req, res, async (uploadError) => {
    if (uploadError) {
      const isSizeError = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        message: isSizeError ? '图片不能超过 8MB。' : uploadError.message,
      });
    }

    try {
      const task = await createBatchTask({
        userId: req.user?.id,
        tenantId: req.user?.tenantId,
        storageConfig: req.config,
        title: req.body?.title,
        mode: req.body?.mode,
        modelKey: req.body?.modelKey,
        model: req.body?.model,
        referenceImage: fileToDataUrl(req.file),
        templateIds: parseTemplateIds(req.body?.templateIds),
        promptTemplateId: req.body?.promptTemplateId,
      });

      return res.status(200).json({
        batchId: task.id,
        batch: serializeBatchTask(task),
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        message: error.message || '批量任务创建失败，请稍后重试。',
      });
    }
  });
});

router.get('/:id/items/:itemId/file', async (req, res) => {
  try {
    const task = await getBatchTask(req.params.id, req.user?.id, { resume: false });
    if (!task || !canAccessBatchTask(req, task)) {
      return res.status(404).json({
        message: '批量任务不存在或结果已过期。',
        errorKind: 'batch_not_found_or_expired',
      });
    }
    const item = task.items.find((candidate) => candidate.itemId === req.params.itemId);
    if (!item || item.status !== 'success') {
      return res.status(409).json({
        message: '图片结果仍在处理中，请稍后刷新。',
        errorKind: 'result_unavailable',
      });
    }
    const file = await getAuthorizedBatchResultFile({
      task,
      itemId: req.params.itemId,
      userId: req.user?.id,
      tenantId: req.user?.tenantId,
    });
    if (!file) {
      return res.status(410).json({
        message: '结果文件不存在或已清理，请重新处理结果。',
        errorKind: 'result_file_missing',
      });
    }
    const { buffer, contentType } = await getBatchResultBuffer(req, file);
    const download = req.query.download === '1' || req.query.download === 'true';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(file.filename)}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).send(buffer);
  } catch (error) {
    logger.error('[BatchPackaging] stored result request failed', {
      batchId: req.params.id,
      itemId: req.params.itemId,
      errorCode: error?.code || 'RESULT_STORAGE_READ_FAILED',
    });
    return res.status(502).json({
      message: '图片结果读取失败，请重新处理结果。',
      errorKind: 'result_storage_read_failed',
    });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const task = await getBatchTask(req.params.id, req.user?.id);
    if (!task || !canAccessBatchTask(req, task)) {
      return res.status(404).json({ message: '批量任务不存在。' });
    }

    return res.status(200).json({ batch: serializeBatchTask(task) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      message: error.message || '批量任务查询失败，请稍后重试。',
    });
  }
});

router.post('/:id/retry', async (req, res) => {
  try {
    const existingTask = await getBatchTask(req.params.id, req.user?.id, { resume: false });
    if (!existingTask || !canAccessBatchTask(req, existingTask)) {
      return res.status(404).json({ message: '批量任务不存在。' });
    }
    const task = await retryBatchItem(req.params.id, req.body?.templateId, req.user?.id);
    return res.status(200).json({ batch: serializeBatchTask(task) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      message: error.message || '重试失败，请稍后重试。',
      code: error.code,
    });
  }
});

router.post('/:id/items/:itemId/recover-result', async (req, res) => {
  try {
    const existingTask = await getBatchTask(req.params.id, req.user?.id, { resume: false });
    if (!existingTask || !canAccessBatchTask(req, existingTask)) {
      return res.status(404).json({ message: '批量任务不存在。' });
    }
    const task = await recoverBatchItemResult(
      req.params.id,
      req.params.itemId,
      req.user?.id,
      req.user?.tenantId,
    );
    return res.status(200).json({ batch: serializeBatchTask(task) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      message: error.message || '结果恢复失败，请稍后重试。',
      errorKind: error.code || 'batch_result_recovery_failed',
    });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const existingTask = await getBatchTask(req.params.id, req.user?.id, { resume: false });
    if (!existingTask || !canAccessBatchTask(req, existingTask)) {
      return res.status(404).json({ message: '批量任务不存在。' });
    }
    const task = await cancelBatchTask(req.params.id, req.user?.id);
    return res.status(200).json({ batch: serializeBatchTask(task) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      message: error.message || '停止任务失败，请稍后重试。',
    });
  }
});

module.exports = router;
