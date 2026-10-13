const express = require('express');
const multer = require('multer');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const configMiddleware = require('~/server/middleware/config/app');
const {
  cancelSkuBatch,
  createSkuBatch,
  getSkuBatch,
  retrySkuBatchItem,
} = require('~/server/services/SkuGeneration/skuBatchService');
const {
  getAuthorizedSkuFile,
  readAuthorizedSkuFile,
  saveSkuSourceFile,
} = require('~/server/services/SkuGeneration/skuFileStorage');
const { readSkuTemplateAsset } = require('~/server/services/SkuGeneration/skuTemplateAssets');

const router = express.Router();
const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const uploadSkuFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('只支持 PNG、JPG/JPEG、WebP 图片。'));
    }
    cb(null, true);
  },
}).single('file');

router.use(requireJwtAuth);
router.use(configMiddleware);

function handleUpload(req, res, next) {
  uploadSkuFile(req, res, (error) => {
    if (error) {
      const isSizeError = error.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        message: isSizeError ? '图片不能超过 8MB。' : error.message,
        field: 'file',
      });
    }
    if (!req.file) {
      return res.status(400).json({ message: '请上传图片。', field: 'file' });
    }
    return next();
  });
}

function sendBusinessError(res, error) {
  const status = error.statusCode || (error.code?.includes('NOT_FOUND') ? 404 : 400);
  return res.status(status).json({
    message: error.message || 'SKU 操作失败。',
    ...(error.code ? { code: error.code } : {}),
    ...(error.field ? { field: error.field } : {}),
  });
}

router.post('/sources', handleUpload, async (req, res) => {
  try {
    const result = await saveSkuSourceFile({
      req,
      file: req.file,
      kind: req.body?.kind || 'source',
    });
    return res.status(200).json(result);
  } catch (error) {
    return sendBusinessError(res, error);
  }
});

router.get('/templates/:templateKey/assets/:slot', async (req, res) => {
  try {
    const asset = await readSkuTemplateAsset({
      templateKey: req.params.templateKey,
      slot: req.params.slot,
    });
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Content-Length', String(asset.buffer.length));
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(asset.filename)}"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).send(asset.buffer);
  } catch (error) {
    return sendBusinessError(res, error);
  }
});

router.post('/batches', async (req, res) => {
  try {
    const result = await createSkuBatch({
      userId: req.user?.id,
      tenantId: req.user?.tenantId,
      storageConfig: req.config,
      sourceFileId: req.body?.sourceFileId,
      leftIconFileId: req.body?.leftIconFileId,
      rightIconFileId: req.body?.rightIconFileId,
      templateKey: req.body?.templateKey,
      textRows: req.body?.textRows,
    });
    return res.status(200).json(result);
  } catch (error) {
    return sendBusinessError(res, error);
  }
});

router.get('/batches/:id', async (req, res) => {
  try {
    const result = await getSkuBatch(req.params.id, {
      userId: req.user?.id,
      tenantId: req.user?.tenantId,
    });
    if (!result) {
      return res.status(404).json({ message: 'SKU 批量任务不存在。', code: 'SKU_BATCH_NOT_FOUND' });
    }
    return res.status(200).json(result);
  } catch (error) {
    return sendBusinessError(res, error);
  }
});

router.post('/batches/:id/cancel', async (req, res) => {
  try {
    return res.status(200).json(
      await cancelSkuBatch(req.params.id, {
        userId: req.user?.id,
        tenantId: req.user?.tenantId,
      }),
    );
  } catch (error) {
    return sendBusinessError(res, error);
  }
});

router.post('/batches/:id/items/:itemId/retry', async (req, res) => {
  try {
    return res.status(200).json(
      await retrySkuBatchItem(req.params.id, req.params.itemId, {
        userId: req.user?.id,
        tenantId: req.user?.tenantId,
        storageConfig: req.config,
      }),
    );
  } catch (error) {
    return sendBusinessError(res, error);
  }
});

router.get('/files/:fileId', async (req, res) => {
  try {
    const file = await getAuthorizedSkuFile({
      fileId: req.params.fileId,
      userId: req.user?.id,
      tenantId: req.user?.tenantId,
    });
    if (!file) {
      return res
        .status(404)
        .json({ message: '文件不存在或无权访问。', code: 'SKU_FILE_NOT_FOUND' });
    }
    const { buffer, contentType } = await readAuthorizedSkuFile(req, file);
    const download = req.query.download === '1' || req.query.download === 'true';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(file.filename || 'sku.png')}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).send(buffer);
  } catch (error) {
    logger.error('[SkuGeneration] file read failed', {
      fileId: req.params.fileId,
      errorCode: error?.code || 'SKU_FILE_READ_FAILED',
    });
    return sendBusinessError(res, error);
  }
});

module.exports = router;
