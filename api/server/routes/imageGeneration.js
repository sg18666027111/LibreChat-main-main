const express = require('express');
const {
  getImageProviderBillingMetadata,
} = require('~/server/services/ImageGeneration/providerBilling');
const fs = require('fs/promises');
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const { Readable } = require('stream');
const { createHash, randomUUID } = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
const {
  NEGATIVE_PROMPT,
  DEFAULT_ASPECT_RATIOS,
  PLATFORM_TYPE_ASPECT_RATIOS,
  buildDualReferencePrompt,
  buildMultiReferencePrompt,
  buildPrompt,
  buildWhiteBackgroundScenePrompt,
  getImageSize,
} = require('~/server/services/ImageGeneration/prompt');
const {
  TEXT_TO_IMAGE_MODEL,
  IMAGE_TO_IMAGE_MODEL,
  generateTextToImage,
  generateImageToImage,
} = require('~/server/services/ImageGeneration/siliconflow');
const { generateAPIMartImage } = require('~/server/services/ImageGeneration/adapters/apimart');
const {
  enqueueAPIMartImg2Job,
  getAPIMartImg2JobStatus,
  isAPIMartImg2ResolvedModel,
  shouldUseAPIMartImg2AsyncForUser,
} = require('~/server/services/ImageGeneration/apimartImg2Async');
const {
  cleanupAPIMartImg2InputRefs,
  stageAPIMartImg2ImageInputs,
} = require('~/server/services/ImageGeneration/apimartImg2InputStorage');
const {
  findOrStageAndEnqueueImageEgressJob,
  getImageEgressJobStatus,
  isImageEgressAsyncResolvedModel,
  readImageEgressJobOutput,
  shouldUseImageEgressAsyncForUser,
} = require('~/server/services/ImageGeneration/imageEgressAsync');
const { generateFalImage } = require('~/server/services/ImageGeneration/adapters/fal');
const { generateArkImage } = require('~/server/services/ImageGeneration/adapters/ark');
const {
  getImageGenerationEditModels,
  getImageGenerationTextModels,
  MODEL_REGISTRY,
  resolveImageGenerationModel,
} = require('~/server/services/ImageGeneration/models');
const {
  DEFAULT_OUTPUT_QUALITY,
  OUTPUT_QUALITY_OPTIONS,
  resolveSingleImageOutputQuality,
} = require('~/server/services/ImageGeneration/outputQuality');
const { recordImageGenerationResult } = require('~/server/services/ImageGeneration/resultRecorder');
const {
  normalizeGeneratedImageResult,
} = require('~/server/services/ImageGeneration/normalizeImageOutput');
const {
  extractHostname,
  getResultImage,
  isHostAllowed,
  registerResultImage,
  registerResultImageBuffer,
} = require('~/server/services/ImageGeneration/resultProxy');
const {
  CATEGORY_BATCH_PACKAGING,
  MAX_PACKAGING_STYLES_PER_BATCH,
  TEMPLATE_ROLES,
  createPromptTemplate,
  deletePromptTemplate,
  duplicatePromptTemplate,
  formatPromptTemplate,
  listPromptTemplates,
  restorePromptTemplateDefault,
  updatePromptTemplate,
} = require('~/server/services/ImageGeneration/promptTemplateStore');
const { recordImageUsage, admitImageUsage } = require('~/server/services/UsageLedgerService');

const router = express.Router();

const PROXY_FETCH_TIMEOUT_MS = 30000;
const PROXY_ENABLED_PROVIDERS = new Set(['fal', 'apimart', 'siliconflow', 'ark']);
const GPT_IMAGE_2_TEXT_MODEL_KEY = 'apimart_gpt_image_2_text';
const GPT_IMAGE_2_TEXT_ROUTING = Object.freeze({
  label: 'GPT Image 2（FAL）',
  name: 'GPT Image 2（FAL）',
  provider: 'fal',
  model: 'openai/gpt-image-2',
  asyncOnly: true,
  supportedCounts: Object.freeze([1]),
});

function isProxyEnabledProvider(provider) {
  return PROXY_ENABLED_PROVIDERS.has(provider);
}

function withoutProxy(image) {
  return { ...image, proxiedUrl: null, downloadUrl: null };
}

function decorateImagesWithProxy(images, provider, requestId) {
  if (!isProxyEnabledProvider(provider)) {
    return images.map(withoutProxy);
  }

  return images.map((image) => {
    if (Buffer.isBuffer(image?.buffer)) {
      const { buffer, contentType, originalUrl: _originalUrl, ...serializableImage } = image;
      const extension = contentType === 'image/jpeg' ? 'jpg' : contentType?.split('/')[1] || 'png';
      const registered = registerResultImageBuffer({
        buffer,
        contentType,
        provider,
        filename: `ai-image-result.${extension}`,
      });
      return {
        ...serializableImage,
        url: registered.proxyPath,
        b64_json: null,
        proxiedUrl: registered.proxyPath,
        downloadUrl: registered.downloadPath,
      };
    }

    if (!image?.url) {
      return withoutProxy(image);
    }

    try {
      const registered = registerResultImage({ resultUrl: image.url, provider });
      return {
        ...image,
        proxiedUrl: registered?.proxyPath ?? null,
        downloadUrl: registered?.downloadPath ?? null,
      };
    } catch (error) {
      logger.warn('[ImageGeneration] result proxy register failed, returning raw result', {
        requestId,
        provider,
        stage: 'proxy_register_failed',
        errorCode: error?.code || 'RESULT_PROXY_REGISTER_FAILED',
      });
      return withoutProxy(image);
    }
  });
}

function buildResultImages(result, provider, requestId) {
  let sourceImages = [];
  if (Array.isArray(result?.images) && result.images.length) {
    sourceImages = result.images;
  } else if (result?.resultUrl) {
    sourceImages = [{ url: result.resultUrl, b64_json: null }];
  }

  if (!sourceImages.length) {
    return { images: [], outputCount: 0, resultHost: null };
  }

  const baseImages = sourceImages.map((image) => ({
    ...image,
    b64_json: image.b64_json ?? null,
  }));
  const resultHost = extractHostname(baseImages[0]?.originalUrl || baseImages[0]?.url);

  try {
    const images = decorateImagesWithProxy(baseImages, provider, requestId);
    return { images, outputCount: images.length, resultHost };
  } catch (error) {
    logger.warn('[ImageGeneration] result proxy build failed, returning raw result', {
      requestId,
      provider,
      stage: 'proxy_register_failed',
      errorCode: error?.code || 'RESULT_PROXY_REGISTER_FAILED',
    });
    return {
      images: baseImages.map(withoutProxy),
      outputCount: baseImages.length,
      resultHost,
    };
  }
}

function logSuccessfulHttpResponse({
  requestId,
  route,
  requestReceivedAt,
  statusCode,
  internalTaskId,
  jobCreatedAt,
}) {
  logger.info(
    internalTaskId
      ? '[ImageGeneration] async job response written'
      : '[ImageGeneration] successful HTTP response written',
    {
      requestId,
      route,
      request_received_at: requestReceivedAt,
      ...(jobCreatedAt ? { job_created_at: jobCreatedAt } : {}),
      http_response_written_at: new Date().toISOString(),
      ...(internalTaskId ? { internalTaskId } : {}),
      statusCode,
    },
  );
}

function sniffImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif';
  }
  return null;
}

router.get('/result-image/:token', async (req, res) => {
  const entry = getResultImage(req.params.token);
  if (!entry) {
    return res.status(404).json({ message: '图片链接已过期，请重新生成。' });
  }

  const isDownloadRequest = req.query.download === '1' || req.query.download === 'true';

  if (Buffer.isBuffer(entry.buffer)) {
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `${isDownloadRequest ? 'attachment' : 'inline'}; filename="${entry.filename || 'ai-image-result.png'}"`,
    );
    res.setHeader('Content-Length', entry.buffer.length);
    return res.end(entry.buffer);
  }

  if (!isHostAllowed(entry.host)) {
    return res.status(403).json({ message: '图片来源不被允许。' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);
  let upstream = null;

  try {
    upstream = await fetch(entry.resultUrl, { signal: controller.signal });
  } catch (error) {
    clearTimeout(timeout);
    logger.warn('[ImageGeneration] result-image fetch failed', {
      provider: entry.provider,
      resultHost: entry.host,
      stage: 'proxy_fetch_failed',
      errorCode: error?.code || error?.name || null,
    });
    return res.status(502).json({ message: '图片加载失败，请稍后重试或重新生成。' });
  }

  clearTimeout(timeout);

  if (!upstream.ok || !upstream.body) {
    logger.warn('[ImageGeneration] result-image upstream not ok', {
      provider: entry.provider,
      resultHost: entry.host,
      stage: 'proxy_fetch_failed',
      statusCode: upstream.status,
    });
    return res.status(502).json({ message: '图片加载失败，请稍后重试或重新生成。' });
  }

  const contentType = upstream.headers.get('content-type') || '';

  if (!contentType.startsWith('image/')) {
    let sniffBuffer = null;
    try {
      sniffBuffer = Buffer.from(await upstream.arrayBuffer());
    } catch (error) {
      logger.warn('[ImageGeneration] result-image read failed', {
        provider: entry.provider,
        resultHost: entry.host,
        stage: 'proxy_fetch_failed',
        errorCode: error?.code || error?.name || null,
      });
      return res.status(502).json({ message: '图片加载失败，请稍后重试或重新生成。' });
    }

    const sniffedType = sniffImageContentType(sniffBuffer);
    if (!sniffedType) {
      logger.warn('[ImageGeneration] result-image unexpected content-type', {
        provider: entry.provider,
        resultHost: entry.host,
        stage: 'proxy_fetch_failed',
        upstreamContentType: contentType || null,
      });
      return res.status(502).json({ message: '图片内容不可用，请重新生成。' });
    }

    res.setHeader('Content-Type', sniffedType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `${isDownloadRequest ? 'attachment' : 'inline'}; filename="ai-image-result.png"`,
    );
    res.setHeader('Content-Length', sniffBuffer.length);
    return res.end(sniffBuffer);
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    `${isDownloadRequest ? 'attachment' : 'inline'}; filename="ai-image-result.png"`,
  );
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) {
    res.setHeader('Content-Length', contentLength);
  }

  const nodeStream = Readable.fromWeb(upstream.body);
  res.on('close', () => nodeStream.destroy());
  nodeStream.on('error', () => {
    if (!res.headersSent) {
      res.status(502).end();
    } else {
      res.destroy();
    }
  });
  nodeStream.pipe(res);
});

const ALLOWED_PLATFORMS = ['淘宝', '京东', '拼多多', '抖音', '小红书', '视频号', '通用'];
const ALLOWED_IMAGE_TYPES = [
  '商品主图',
  '详情页配图',
  '信息流图',
  '种草图',
  '直播封面',
  '分镜图',
  '通用营销图',
];
const ALLOWED_ASPECT_RATIOS = ['1:1', '3:4', '4:5', '16:9', '9:16'];
const ALLOWED_COUNTS = [1, 2, 4];
const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const DEBUG_IMAGE_DIR = process.env.IMAGE_GENERATION_DEBUG_DIR || '/tmp/jingjicang-image-debug';
const SAVE_DEBUG_IMAGES = process.env.IMAGE_GENERATION_SAVE_DEBUG === 'true';
const MULTI_REFERENCE_SUB_MODES = ['dual-product-replace', 'multi-reference'];
const uploadWhiteBackgroundImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('只支持 PNG、JPG/JPEG、WebP 图片。'));
    }

    cb(null, true);
  },
}).single('image');
const uploadReferenceImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('只支持 PNG、JPG/JPEG、WebP 图片。'));
    }

    cb(null, true);
  },
}).array('images', 3);

router.use(requireJwtAuth);

router.get('/tasks/:internalTaskId', async (req, res) => {
  try {
    const v3Task = await getImageEgressJobStatus({
      internalTaskId: req.params.internalTaskId,
      userId: req.user?.id,
    });
    const task =
      v3Task ||
      (await getAPIMartImg2JobStatus({
        internalTaskId: req.params.internalTaskId,
        userId: req.user?.id,
      }));
    if (!task) {
      return res.status(404).json({ message: '生成任务不存在或已过期。' });
    }
    return res.status(200).json(task);
  } catch (error) {
    logger.error('[ImageGeneration] internal task status lookup failed', {
      internalTaskId: req.params.internalTaskId,
      userHash: getUserHash(req.user?.id),
      errorCode: error?.code || error?.statusCode || 'IMAGE_GENERATION_TASK_LOOKUP_FAILED',
      message: getSafeErrorSummary(error),
    });
    return res.status(error.statusCode || 500).json({
      message: '查询生成任务状态失败，请稍后重试。',
      errorCode: error?.code || error?.statusCode || 'IMAGE_GENERATION_TASK_LOOKUP_FAILED',
    });
  }
});

router.get('/tasks/:internalTaskId/result-image', async (req, res) => {
  try {
    const output = await readImageEgressJobOutput({
      internalTaskId: req.params.internalTaskId,
      userId: req.user?.id,
      tenantId: req.user?.tenantId,
    });
    if (!output) {
      return res.status(404).json({
        message: '任务结果图片不存在或已过期，请重新生成。',
        errorCode: 'RESULT_FILE_MISSING',
        state: 'failed',
      });
    }
    res.setHeader('Content-Type', output.contentType);
    res.setHeader('Content-Length', output.buffer.length);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.end(output.buffer);
  } catch (error) {
    logger.error('[ImageGeneration] durable task result read failed', {
      internalTaskId: req.params.internalTaskId,
      userHash: getUserHash(req.user?.id),
      errorCode: error?.code || 'RESULT_FILE_READ_FAILED',
    });
    return res.status(error.statusCode || 500).json({
      message: '任务结果图片读取失败，请重新生成。',
      errorCode: error?.code || 'RESULT_FILE_READ_FAILED',
      state: 'failed',
    });
  }
});

function canManagePromptTemplates(user) {
  return (
    user?.role === SystemRoles.ADMIN || user?.permissions?.imagePromptTemplates?.manage === true
  );
}

function requirePromptTemplateManagement(req, res, next) {
  if (!canManagePromptTemplates(req.user)) {
    return res.status(403).json({
      message: '无提示词模板管理权限，请联系管理员授权。',
    });
  }
  return next();
}

function getPromptTemplateErrorPayload(error, fallbackMessage) {
  const message = error?.message || fallbackMessage;
  return { message };
}

router.get('/prompt-templates', async (req, res) => {
  try {
    const category = req.query?.category || CATEGORY_BATCH_PACKAGING;
    const templateRole = req.query?.templateRole;
    if (category !== CATEGORY_BATCH_PACKAGING) {
      return res.status(400).json({ message: '提示词模板分类不正确。' });
    }
    if (templateRole && !TEMPLATE_ROLES.includes(templateRole)) {
      return res.status(400).json({ message: '提示词模板角色不正确。' });
    }
    const templates = await listPromptTemplates({
      category,
      includeDisabled: canManagePromptTemplates(req.user),
      ...(templateRole ? { templateRole } : {}),
    });
    return res.status(200).json({
      templates,
      limits: { maxPackagingStylesPerBatch: MAX_PACKAGING_STYLES_PER_BATCH },
    });
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json(getPromptTemplateErrorPayload(error, '提示词模板加载失败。'));
  }
});

router.post(
  '/prompt-templates/:templateId/example-image',
  requirePromptTemplateManagement,
  configMiddleware,
  (req, res) => {
    uploadWhiteBackgroundImage(req, res, async (uploadError) => {
      if (uploadError || !req.file) {
        return res.status(uploadError?.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
          message:
            uploadError?.code === 'LIMIT_FILE_SIZE'
              ? '图片不能超过 8MB。'
              : '请上传一张 PNG、JPG/JPEG 或 WebP 图例。',
        });
      }
      try {
        const {
          saveExampleImage,
        } = require('~/server/services/ImageGeneration/promptTemplateExample');
        const template = await saveExampleImage(req, req.params.templateId);
        return res.status(200).json({ template });
      } catch (error) {
        return res.status(error.statusCode || 500).json({ message: '图例上传失败，请重试。' });
      }
    });
  },
);

router.delete(
  '/prompt-templates/:templateId/example-image',
  requirePromptTemplateManagement,
  async (req, res) => {
    try {
      const {
        removeExampleImage,
      } = require('~/server/services/ImageGeneration/promptTemplateExample');
      const template = await removeExampleImage(req, req.params.templateId);
      return res.status(200).json({ template });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ message: '图例删除失败，请重试。' });
    }
  },
);

router.get('/prompt-templates/:templateId/example-image', configMiddleware, async (req, res) => {
  try {
    const { readExampleImage } = require('~/server/services/ImageGeneration/promptTemplateExample');
    const { stream, contentType } = await readExampleImage(
      req,
      req.params.templateId,
      canManagePromptTemplates(req.user),
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).end();
      else res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: '图例暂时无法加载。' });
  }
});

router.post('/prompt-templates', requirePromptTemplateManagement, async (req, res) => {
  try {
    const template = await createPromptTemplate(req.body, req.user?.id);
    return res.status(201).json({ template });
  } catch (error) {
    return res
      .status(error.statusCode || 400)
      .json(getPromptTemplateErrorPayload(error, '提示词模板创建失败。'));
  }
});

router.patch('/prompt-templates/:templateId', requirePromptTemplateManagement, async (req, res) => {
  try {
    const template = await updatePromptTemplate(req.params.templateId, req.body, req.user?.id);
    return res.status(200).json({ template });
  } catch (error) {
    return res
      .status(error.statusCode || 400)
      .json(getPromptTemplateErrorPayload(error, '提示词模板保存失败。'));
  }
});

router.post(
  '/prompt-templates/:templateId/duplicate',
  requirePromptTemplateManagement,
  async (req, res) => {
    try {
      const template = await duplicatePromptTemplate(req.params.templateId, req.user?.id);
      return res.status(201).json({ template });
    } catch (error) {
      return res
        .status(error.statusCode || 400)
        .json(getPromptTemplateErrorPayload(error, '提示词模板复制失败。'));
    }
  },
);

router.post(
  '/prompt-templates/:templateId/format',
  requirePromptTemplateManagement,
  async (req, res) => {
    try {
      const result = await formatPromptTemplate(req.params.templateId, {
        save: req.body?.save === true,
        userId: req.user?.id,
      });
      return res.status(200).json(result);
    } catch (error) {
      return res
        .status(error.statusCode || 400)
        .json(getPromptTemplateErrorPayload(error, '提示词格式整理失败。'));
    }
  },
);

router.post(
  '/prompt-templates/:templateId/restore-default',
  requirePromptTemplateManagement,
  async (req, res) => {
    try {
      const template = await restorePromptTemplateDefault(req.params.templateId);
      return res.status(200).json({ template });
    } catch (error) {
      return res
        .status(error.statusCode || 400)
        .json(getPromptTemplateErrorPayload(error, '提示词模板恢复默认失败。'));
    }
  },
);

router.delete(
  '/prompt-templates/:templateId',
  requirePromptTemplateManagement,
  async (req, res) => {
    try {
      await deletePromptTemplate(req.params.templateId);
      return res.status(200).json({ deleted: true });
    } catch (error) {
      return res
        .status(error.statusCode || 400)
        .json(getPromptTemplateErrorPayload(error, '提示词模板删除失败。'));
    }
  },
);

router.get('/config', (req, res) => {
  return res.status(200).json({
    platforms: ALLOWED_PLATFORMS,
    imageTypes: ALLOWED_IMAGE_TYPES,
    aspectRatios: ALLOWED_ASPECT_RATIOS,
    counts: ALLOWED_COUNTS,
    models: [
      {
        name: '快速生图',
        label: '快速生图',
        modelKey: TEXT_TO_IMAGE_MODEL,
        value: TEXT_TO_IMAGE_MODEL,
        provider: 'siliconflow',
        model: TEXT_TO_IMAGE_MODEL,
        capabilities: ['text-to-image'],
      },
      ...getImageGenerationTextModels().map((modelConfig) =>
        modelConfig.modelKey === GPT_IMAGE_2_TEXT_MODEL_KEY
          ? { ...modelConfig, ...GPT_IMAGE_2_TEXT_ROUTING }
          : modelConfig,
      ),
    ].sort((a, b) => Number(b.provider === 'fal') - Number(a.provider === 'fal')),
    editModels: getImageGenerationEditModels({
      includeAsyncOnly: Boolean(shouldUseImageEgressAsyncForUser({ userId: req.user?.id })),
    }),
    outputQualities: OUTPUT_QUALITY_OPTIONS,
    defaultOutputQuality: DEFAULT_OUTPUT_QUALITY,
    defaultAspectRatios: DEFAULT_ASPECT_RATIOS,
    platformTypeAspectRatios: PLATFORM_TYPE_ASPECT_RATIOS,
  });
});

function validateGenerationFields({ platform, imageType, aspectRatio, count }) {
  const normalizedCount = Number(count);

  if (!ALLOWED_PLATFORMS.includes(platform)) {
    return { message: '平台参数不正确。' };
  }

  if (!ALLOWED_IMAGE_TYPES.includes(imageType)) {
    return { message: '图片类型参数不正确。' };
  }

  if (!ALLOWED_ASPECT_RATIOS.includes(aspectRatio)) {
    return { message: '比例参数不正确。' };
  }

  if (!ALLOWED_COUNTS.includes(normalizedCount)) {
    return { message: '生成数量只能选择 1、2 或 4。' };
  }

  return { normalizedCount };
}

function toImageMetadataLog(metadata) {
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    hasAlpha: Boolean(metadata.hasAlpha),
    channels: metadata.channels,
  };
}

function createRequestId() {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

function getUserHash(userId) {
  if (!userId) {
    return null;
  }
  return createHash('sha256').update(String(userId)).digest('hex').slice(0, 12);
}

function getDebugImagePath(requestId, name) {
  return path.join(DEBUG_IMAGE_DIR, `${requestId}-${name}.png`);
}

function getSafeTextSummary(text) {
  const message = typeof text === 'string' ? text : '';
  const sanitized = message
    .replace(/data:image\/[^\s"')]+/gi, '[image-data]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .slice(0, 200);
  return sanitized || null;
}

function getSafeErrorSummary(error) {
  return getSafeTextSummary(error?.safeMessage || error?.message);
}

function getErrorLog(error, context = {}) {
  const message = getSafeErrorSummary(error);
  return {
    ...context,
    statusCode: error?.statusCode,
    code: error?.code,
    errorCode: error?.code || error?.statusCode || context.errorCode,
    errorName: error?.errorName || error?.name || null,
    isTimeout: error?.code === 'FAL_TIMEOUT' || error?.code === 'IMAGE_GENERATION_TIMEOUT',
    message,
    errorSummary: message,
  };
}

function getGenerationStateFromError(errorCode) {
  return errorCode === 'IMAGE_GENERATION_TIMEOUT' ? 'degraded' : undefined;
}

function getSafeClientMessage(error, fallbackMessage) {
  const message = getSafeErrorSummary(error);
  return message || fallbackMessage;
}

function getClientErrorPayload(error, fallbackMessage, { errorCode, requestId, state } = {}) {
  const resolvedCode = error?.code || error?.statusCode || errorCode || null;
  return {
    message: getSafeClientMessage(error, fallbackMessage),
    ...(resolvedCode ? { errorCode: resolvedCode } : {}),
    ...(requestId ? { requestId } : {}),
    ...(state ? { state } : {}),
  };
}

async function prepareImageToImageInput(file, debugPath) {
  const originalMetadata = await sharp(file.buffer).metadata();
  const original = toImageMetadataLog(originalMetadata);
  const hasAlpha = Boolean(originalMetadata.hasAlpha);

  const imagePipeline = sharp(file.buffer).rotate();
  const sentBuffer = hasAlpha
    ? await imagePipeline.flatten({ background: '#ffffff' }).removeAlpha().png().toBuffer()
    : await imagePipeline.png().toBuffer();
  const sentMetadata = await sharp(sentBuffer).metadata();
  const processed = toImageMetadataLog(sentMetadata);
  let finalDebugPath = null;

  if (SAVE_DEBUG_IMAGES) {
    finalDebugPath = debugPath || getDebugImagePath(createRequestId(), 'sent-to-apimart');
    await fs.mkdir(DEBUG_IMAGE_DIR, { recursive: true });
    await fs.writeFile(finalDebugPath, sentBuffer);
  }

  return {
    image: `data:image/png;base64,${sentBuffer.toString('base64')}`,
    original,
    processed,
    debugPath: finalDebugPath,
    alphaFlattened: hasAlpha,
  };
}

function parseInputImageRoles(value) {
  if (!value) {
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

async function generateImageByResolvedModel(resolvedModel, request) {
  if (resolvedModel.provider === 'apimart') {
    return generateAPIMartImage({
      ...request,
      model: resolvedModel.model,
    });
  }

  if (resolvedModel.provider === 'fal') {
    return generateFalImage({
      ...request,
      model: resolvedModel.model,
    });
  }

  if (resolvedModel.provider === 'ark') {
    return generateArkImage({
      ...request,
      model: resolvedModel.model,
    });
  }

  const error = new Error(`不支持的生图供应商：${resolvedModel.provider}`);
  error.statusCode = 400;
  error.code = 'IMAGE_PROVIDER_UNSUPPORTED';
  throw error;
}

function resolveTextToImageProvider({ modelKey, model }) {
  const selectedModel = model || TEXT_TO_IMAGE_MODEL;

  if (!modelKey && selectedModel === TEXT_TO_IMAGE_MODEL) {
    return {
      modelKey: null,
      label: '快速生图',
      provider: 'siliconflow',
      model: TEXT_TO_IMAGE_MODEL,
      capabilities: ['text-to-image'],
    };
  }

  const registryModelKey = modelKey || (MODEL_REGISTRY[selectedModel] ? selectedModel : null);
  const resolvedModel = resolveImageGenerationModel({
    modelKey: registryModelKey,
    model: registryModelKey ? null : selectedModel,
    taskType: 'text-to-image',
  });
  if (resolvedModel.modelKey !== GPT_IMAGE_2_TEXT_MODEL_KEY) {
    return resolvedModel;
  }
  return { ...resolvedModel, ...GPT_IMAGE_2_TEXT_ROUTING };
}

function assertTextToImageCountSupported(resolvedModel, count) {
  if (!resolvedModel.supportedCounts || resolvedModel.supportedCounts.includes(count)) {
    return;
  }
  const error = new Error(`${resolvedModel.label}当前仅支持生成 1 张。`);
  error.statusCode = 400;
  error.code = 'IMAGE_MODEL_COUNT_UNSUPPORTED';
  throw error;
}

function getDimensionsFromSize(size) {
  const match = /^(\d+)x(\d+)$/i.exec(size || '');
  if (!match) {
    return null;
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function normalizeFalGPTImage2Result({
  result,
  resolvedModel,
  aspectRatio,
  size,
  requestId,
  taskType,
}) {
  if (
    resolvedModel.provider !== 'fal' ||
    resolvedModel.model !== 'openai/gpt-image-2/edit' ||
    aspectRatio !== '1:1'
  ) {
    return result;
  }

  const target = getDimensionsFromSize(size);
  if (!target) {
    return result;
  }

  const startedAt = Date.now();
  const normalizedResult = await normalizeGeneratedImageResult({
    result,
    targetWidth: target.width,
    targetHeight: target.height,
    isRemoteUrlAllowed: (url) => isHostAllowed(extractHostname(url)),
  });
  normalizedResult.images.forEach((image) => {
    logger.info('[ImageGeneration] Fal GPT Image 2 output normalized', {
      requestId,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      taskType,
      originalWidth: image.originalWidth,
      originalHeight: image.originalHeight,
      targetWidth: image.width,
      targetHeight: image.height,
      normalized: image.normalized,
      elapsedMs: Date.now() - startedAt,
    });
  });
  return normalizedResult;
}

router.post('/text-to-image', async (req, res) => {
  const requestId = createRequestId();
  let stage = 'route_received';
  let resolvedModel = null;

  try {
    const {
      platform = '通用',
      imageType = '通用营销图',
      modelKey,
      model,
      prompt = '',
      aspectRatio = '1:1',
      count = 1,
      outputQuality,
      frontendTaskId,
    } = req.body ?? {};

    logger.info('[ImageGeneration] text-to-image request received', {
      requestId,
      stage,
      state: 'waiting',
      userHash: getUserHash(req.user?.id),
      taskType: 'text-to-image',
    });

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ message: '请先填写提示词。' });
    }

    const validation = validateGenerationFields({ platform, imageType, aspectRatio, count });
    if (validation.message) {
      return res.status(400).json({ message: validation.message });
    }

    const finalPrompt = buildPrompt({
      prompt,
      platform,
      imageType,
      aspectRatio,
    });
    const baseSize = getImageSize(aspectRatio);
    const candidateResolvedModel = resolveTextToImageProvider({ modelKey, model });
    assertTextToImageCountSupported(candidateResolvedModel, validation.normalizedCount);
    resolvedModel = candidateResolvedModel;
    const outputQualityOptions = resolveSingleImageOutputQuality({
      outputQuality,
      aspectRatio,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      fallbackSize: baseSize,
    });
    const size = outputQualityOptions.size;

    stage = 'provider_start';
    logger.info('[ImageGeneration] text-to-image request prepared', {
      requestId,
      stage,
      state: 'running',
      userHash: getUserHash(req.user?.id),
      modelKey: resolvedModel.modelKey,
      model: resolvedModel.model,
      provider: resolvedModel.provider,
      taskType: 'text-to-image',
      platform,
      imageType,
      aspectRatio,
      count: validation.normalizedCount,
      size,
      outputQuality: outputQualityOptions.requestedOutputQuality,
      effectiveOutputQuality: outputQualityOptions.effectiveOutputQuality,
      outputQualityDowngraded: outputQualityOptions.downgraded,
      promptLength: finalPrompt.length,
    });

    if (
      isAPIMartImg2ResolvedModel(resolvedModel) &&
      shouldUseAPIMartImg2AsyncForUser(req.user?.id)
    ) {
      const job = await enqueueAPIMartImg2Job({
        userId: req.user?.id,
        tenantId: req.user?.tenantId,
        requestId,
        frontendTaskId,
        businessType: 'image_generation',
        taskType: 'text-to-image',
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        modelKey: resolvedModel.modelKey,
        payload: {
          taskType: 'text-to-image',
          prompt: finalPrompt,
          platform,
          imageType,
          aspectRatio,
          size,
          imageSize: outputQualityOptions.imageSize,
          width: outputQualityOptions.width,
          height: outputQualityOptions.height,
          resolution: outputQualityOptions.resolution,
          outputQuality: outputQualityOptions.requestedOutputQuality,
          effectiveOutputQuality: outputQualityOptions.effectiveOutputQuality,
          count: validation.normalizedCount,
        },
      });

      stage = 'queued';
      return res.status(202).json({
        state: 'queued',
        status: job.status,
        internalTaskId: job.internalTaskId,
        submittedToProvider: job.submittedToProvider,
        modelKey: resolvedModel.modelKey,
        model: resolvedModel.model,
        provider: resolvedModel.provider,
        size,
        outputQuality: outputQualityOptions.requestedOutputQuality,
        effectiveOutputQuality: outputQualityOptions.effectiveOutputQuality,
        requestId,
        deduplicated: Boolean(job.deduplicated),
      });
    }

    const imageEgressRolloutMode =
      validation.normalizedCount === 1 && isImageEgressAsyncResolvedModel(resolvedModel)
        ? shouldUseImageEgressAsyncForUser({ userId: req.user?.id })
        : null;
    if (resolvedModel.asyncOnly && !imageEgressRolloutMode) {
      const error = new Error('该模型仅在 durable async rollout 启用时可用。');
      error.code = 'IMAGE_EGRESS_ASYNC_DISABLED';
      error.statusCode = 400;
      throw error;
    }
    if (imageEgressRolloutMode) {
      const { job, created } = await findOrStageAndEnqueueImageEgressJob({
        req,
        userId: req.user?.id,
        tenantId: req.user?.tenantId,
        frontendTaskId,
        requestId,
        businessType: 'image_generation',
        taskType: 'text-to-image',
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        modelKey: resolvedModel.modelKey,
        payload: {
          taskType: 'text-to-image',
          prompt: finalPrompt,
          platform,
          imageType,
          aspectRatio,
          size,
          imageSize: outputQualityOptions.imageSize,
          width: outputQualityOptions.width,
          height: outputQualityOptions.height,
          resolution: outputQualityOptions.resolution,
          outputQuality: outputQualityOptions.requestedOutputQuality,
          effectiveOutputQuality: outputQualityOptions.effectiveOutputQuality,
          count: validation.normalizedCount,
        },
        imageInputs: [],
        inputMetadata: [],
        rolloutMode: imageEgressRolloutMode,
      });
      return res.status(202).json({
        state: 'queued',
        status: job.status,
        internalTaskId: job.internalTaskId,
        submittedToProvider: Boolean(job.submittedToProvider),
        modelKey: resolvedModel.modelKey,
        model: resolvedModel.model,
        provider: resolvedModel.provider,
        size,
        requestId,
        deduplicated: !created,
      });
    }

    req.usageContext = await admitImageUsage({
      reservationScope: 'request',
      req,
      requestId,
      ...resolvedModel,
      taskType: 'text-to-image',
    });
    const result =
      resolvedModel.provider === 'siliconflow'
        ? await generateTextToImage({
            prompt: finalPrompt,
            negativePrompt: NEGATIVE_PROMPT,
            size,
            count: validation.normalizedCount,
          })
        : await generateImageByResolvedModel(resolvedModel, {
            taskType: 'text-to-image',
            prompt: finalPrompt,
            platform,
            imageType,
            aspectRatio,
            size,
            imageSize: outputQualityOptions.imageSize,
            width: outputQualityOptions.width,
            height: outputQualityOptions.height,
            resolution: outputQualityOptions.resolution,
            outputQuality: outputQualityOptions.requestedOutputQuality,
            effectiveOutputQuality: outputQualityOptions.effectiveOutputQuality,
            count: validation.normalizedCount,
          });
    stage = 'provider_success';

    stage = 'proxy_register_start';
    const images =
      resolvedModel.provider === 'siliconflow'
        ? decorateImagesWithProxy(result.images, resolvedModel.provider, requestId)
        : buildResultImages(result, resolvedModel.provider, requestId).images;

    stage = 'response_sent';
    logger.info('[ImageGeneration] text-to-image response sent', {
      requestId,
      stage,
      state: 'success',
      provider: resolvedModel.provider,
      modelKey: resolvedModel.modelKey,
      model: resolvedModel.model,
      taskType: 'text-to-image',
      outputCount: images.length,
    });
    await recordImageUsage({
      req,
      requestId,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      modelKey: resolvedModel.modelKey,
      taskType: 'text-to-image',
      status: 'succeeded',
      imageCount: images.length,
      providerTaskId: result.taskId || null,
      metadata: getImageProviderBillingMetadata(resolvedModel.provider, result),
    });
    return res.status(200).json({
      state: 'success',
      images,
      modelKey: resolvedModel.modelKey,
      model: resolvedModel.model,
      provider: resolvedModel.provider,
      size,
      outputQuality: outputQualityOptions.requestedOutputQuality,
      effectiveOutputQuality: outputQualityOptions.effectiveOutputQuality,
      requestId,
      providerTaskId: result.taskId || null,
    });
  } catch (error) {
    const errorCode = error?.code || error?.statusCode || 'TEXT_TO_IMAGE_FAILED';
    const state = getGenerationStateFromError(errorCode);
    logger.error(
      '[ImageGeneration] text-to-image failed',
      getErrorLog(error, {
        requestId,
        stage,
        state,
        provider: resolvedModel?.provider || null,
        modelKey: resolvedModel?.modelKey || null,
        model: resolvedModel?.model || null,
        taskType: 'text-to-image',
        errorCode,
      }),
    );
    if (resolvedModel) {
      await recordImageUsage({
        req,
        requestId,
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        modelKey: resolvedModel.modelKey,
        taskType: 'text-to-image',
        status: 'failed',
        imageCount: 0,
      });
    }
    return res
      .status(error.statusCode || 500)
      .json(
        getClientErrorPayload(error, '图片生成失败，请稍后重试。', { errorCode, requestId, state }),
      );
  }
});

router.post('/image-to-image', configMiddleware, (req, res) => {
  const requestReceivedAt = new Date().toISOString();
  const requestId = createRequestId();
  uploadWhiteBackgroundImage(req, res, async (uploadError) => {
    if (uploadError) {
      const isSizeError = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        message: isSizeError ? '图片不能超过 8MB。' : uploadError.message,
      });
    }

    let generationRecord = null;
    let generationStartedAt = null;
    let stagedAsyncInputRefs = null;
    let asyncJobQueued = false;
    let stage = 'route_received';

    try {
      const {
        platform = '通用',
        imageType = '通用营销图',
        modelKey,
        mode,
        model,
        prompt = '',
        aspectRatio = '1:1',
        outputQuality,
        frontendTaskId,
      } = req.body ?? {};
      const count = 1;

      logger.info('[ImageGeneration] image-to-image request received', {
        requestId,
        stage,
        state: 'waiting',
        userHash: getUserHash(req.user?.id),
        taskType: 'single-image-edit',
      });

      if (!req.file) {
        return res.status(400).json({ message: '请先上传白底图。' });
      }

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ message: '请先填写改图需求。' });
      }

      const resolvedModel = resolveImageGenerationModel({
        modelKey,
        mode,
        model,
        taskType: 'single-image-edit',
      });
      stage = 'model_resolved';

      const validation = validateGenerationFields({ platform, imageType, aspectRatio, count });
      if (validation.message) {
        return res.status(400).json({ message: validation.message });
      }

      const finalPrompt = buildWhiteBackgroundScenePrompt({
        prompt,
        platform,
        imageType,
        aspectRatio,
      });
      const baseSize = getImageSize(aspectRatio);
      const outputQualityOptions = resolveSingleImageOutputQuality({
        outputQuality,
        aspectRatio,
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        fallbackSize: baseSize,
      });
      const size = outputQualityOptions.size;
      const preparedImage = await prepareImageToImageInput(
        req.file,
        getDebugImagePath(requestId, 'single-image-edit-1'),
      );
      const startedAt = Date.now();
      generationStartedAt = startedAt;
      generationRecord = {
        userId: req.user?.id || null,
        requestId,
        modelKey: resolvedModel.modelKey,
        model: resolvedModel.model,
        taskType: 'single-image-edit',
        provider: resolvedModel.provider,
        durationMs: null,
      };

      stage = 'provider_start';
      logger.info('[ImageGeneration] image-to-image request summary', {
        requestId,
        stage,
        state: 'running',
        userHash: getUserHash(req.user?.id),
        provider: resolvedModel.provider,
        modelKey: resolvedModel.modelKey,
        model: resolvedModel.model,
        platform,
        imageType,
        aspectRatio,
        count: 1,
        size,
        outputQuality: outputQualityOptions.requestedOutputQuality,
        effectiveOutputQuality: outputQualityOptions.effectiveOutputQuality,
        outputQualityDowngraded: outputQualityOptions.downgraded,
        taskType: 'single-image-edit',
        promptLength: finalPrompt.length,
        inputImageCount: 1,
        alphaFlattened: preparedImage.alphaFlattened,
        debugImageSaved: Boolean(preparedImage.debugPath),
      });

      if (
        isAPIMartImg2ResolvedModel(resolvedModel) &&
        shouldUseAPIMartImg2AsyncForUser(req.user?.id)
      ) {
        stagedAsyncInputRefs = await stageAPIMartImg2ImageInputs({
          req,
          requestId,
          taskType: 'single-image-edit',
          imageInputs: [preparedImage.image],
          metadata: [preparedImage.processed],
        });
        const job = await enqueueAPIMartImg2Job({
          userId: req.user?.id,
          tenantId: req.user?.tenantId,
          requestId,
          frontendTaskId,
          businessType: 'product_replacement',
          taskType: 'single-image-edit',
          provider: resolvedModel.provider,
          model: resolvedModel.model,
          modelKey: resolvedModel.modelKey,
          payload: {
            taskType: 'single-image-edit',
            prompt: finalPrompt,
            imageInputRefs: stagedAsyncInputRefs,
            platform,
            imageType,
            aspectRatio,
            size,
            imageSize: outputQualityOptions.imageSize,
            width: outputQualityOptions.width,
            height: outputQualityOptions.height,
            resolution: outputQualityOptions.resolution,
            outputQuality: outputQualityOptions.requestedOutputQuality,
            effectiveOutputQuality: outputQualityOptions.effectiveOutputQuality,
            count: 1,
          },
        });
        const jobCreatedAt = job.deduplicated ? null : new Date().toISOString();
        if (job.deduplicated) {
          await cleanupAPIMartImg2InputRefs({ req, refs: stagedAsyncInputRefs });
          stagedAsyncInputRefs = null;
        } else {
          asyncJobQueued = true;
        }

        stage = 'queued';
        logSuccessfulHttpResponse({
          requestId,
          route: '/image-to-image',
          requestReceivedAt,
          jobCreatedAt,
          internalTaskId: job.internalTaskId,
          statusCode: 202,
        });
        return res.status(202).json({
          state: 'queued',
          status: job.status,
          internalTaskId: job.internalTaskId,
          submittedToProvider: job.submittedToProvider,
          modelKey: resolvedModel.modelKey,
          model: resolvedModel.model,
          provider: resolvedModel.provider,
          size,
          outputQuality: outputQualityOptions.requestedOutputQuality,
          effectiveOutputQuality: outputQualityOptions.effectiveOutputQuality,
          requestId,
          deduplicated: Boolean(job.deduplicated),
        });
      }

      const imageEgressRolloutMode = isImageEgressAsyncResolvedModel(resolvedModel)
        ? shouldUseImageEgressAsyncForUser({ userId: req.user?.id })
        : null;
      if (resolvedModel.asyncOnly && !imageEgressRolloutMode) {
        const error = new Error('该模型仅在 durable async rollout 启用时可用。');
        error.code = 'IMAGE_EGRESS_ASYNC_DISABLED';
        error.statusCode = 400;
        throw error;
      }
      if (imageEgressRolloutMode) {
        const { job, created } = await findOrStageAndEnqueueImageEgressJob({
          req,
          userId: req.user?.id,
          tenantId: req.user?.tenantId,
          frontendTaskId,
          requestId,
          businessType: 'product_replacement',
          taskType: 'single-image-edit',
          provider: resolvedModel.provider,
          model: resolvedModel.model,
          modelKey: resolvedModel.modelKey,
          payload: {
            taskType: 'single-image-edit',
            prompt: finalPrompt,
            platform,
            imageType,
            aspectRatio,
            size,
            imageSize: outputQualityOptions.imageSize,
            width: outputQualityOptions.width,
            height: outputQualityOptions.height,
            resolution: outputQualityOptions.resolution,
            outputQuality: outputQualityOptions.requestedOutputQuality,
            effectiveOutputQuality: outputQualityOptions.effectiveOutputQuality,
            count: 1,
          },
          imageInputs: [preparedImage.image],
          inputMetadata: [preparedImage.processed],
          rolloutMode: imageEgressRolloutMode,
        });
        const jobCreatedAt = created ? new Date().toISOString() : null;
        logSuccessfulHttpResponse({
          requestId,
          route: '/image-to-image',
          requestReceivedAt,
          jobCreatedAt,
          internalTaskId: job.internalTaskId,
          statusCode: 202,
        });
        return res.status(202).json({
          state: 'queued',
          status: job.status,
          internalTaskId: job.internalTaskId,
          submittedToProvider: Boolean(job.submittedToProvider),
          modelKey: resolvedModel.modelKey,
          model: resolvedModel.model,
          provider: resolvedModel.provider,
          size,
          requestId,
          deduplicated: !created,
        });
      }

      req.usageContext = await admitImageUsage({
        reservationScope: 'request',
        req,
        requestId,
        ...resolvedModel,
        taskType: 'single-image-edit',
      });
      let result = await generateImageByResolvedModel(resolvedModel, {
        taskType: 'single-image-edit',
        prompt: finalPrompt,
        imageInputs: [preparedImage.image],
        platform,
        imageType,
        aspectRatio,
        size,
        imageSize: outputQualityOptions.imageSize,
        width: outputQualityOptions.width,
        height: outputQualityOptions.height,
        resolution: outputQualityOptions.resolution,
        outputQuality: outputQualityOptions.requestedOutputQuality,
        effectiveOutputQuality: outputQualityOptions.effectiveOutputQuality,
        count: 1,
      });
      result = await normalizeFalGPTImage2Result({
        result,
        resolvedModel,
        aspectRatio,
        size,
        requestId,
        taskType: 'single-image-edit',
      });
      stage = 'provider_success';
      const durationMs = Date.now() - startedAt;

      stage = 'proxy_register_start';
      const { images, outputCount, resultHost } = buildResultImages(
        result,
        resolvedModel.provider,
        requestId,
      );

      stage = 'response_sent';
      logger.info('[ImageGeneration] image-to-image response received', {
        requestId,
        stage,
        state: 'success',
        userHash: getUserHash(req.user?.id),
        provider: resolvedModel.provider,
        modelKey: resolvedModel.modelKey,
        model: resolvedModel.model,
        status: 'success',
        durationMs,
        outputCount,
        resultHost,
      });

      await recordImageGenerationResult({
        ...generationRecord,
        durationMs,
        status: 'success',
        outputCount,
        resultHost,
      });
      await recordImageUsage({
        req,
        requestId,
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        modelKey: resolvedModel.modelKey,
        taskType: 'single-image-edit',
        status: 'succeeded',
        imageCount: outputCount,
        providerTaskId: result.taskId || null,
        durationMs,
        metadata: getImageProviderBillingMetadata(resolvedModel.provider, result),
      });

      logSuccessfulHttpResponse({
        requestId,
        route: '/image-to-image',
        requestReceivedAt,
        statusCode: 200,
      });
      return res.status(200).json({
        state: 'success',
        images,
        modelKey: resolvedModel.modelKey,
        model: resolvedModel.model,
        provider: resolvedModel.provider,
        size,
        outputQuality: outputQualityOptions.requestedOutputQuality,
        effectiveOutputQuality: outputQualityOptions.effectiveOutputQuality,
        requestId,
        providerTaskId: result.taskId || null,
      });
    } catch (error) {
      const durationMs = generationStartedAt ? Date.now() - generationStartedAt : null;
      const errorCode = error.code || error.statusCode || 'IMAGE_TO_IMAGE_FAILED';
      const state = getGenerationStateFromError(errorCode);
      logger.error(
        '[ImageGeneration] image-to-image failed',
        getErrorLog(error, {
          requestId,
          stage: stage === 'provider_start' ? 'provider_failed' : stage,
          state,
          taskType: generationRecord?.taskType || 'single-image-edit',
          provider: generationRecord?.provider || null,
          modelKey: generationRecord?.modelKey || null,
          model: generationRecord?.model || null,
          durationMs,
          errorCode,
        }),
      );

      if (stagedAsyncInputRefs && !asyncJobQueued) {
        await cleanupAPIMartImg2InputRefs({ req, refs: stagedAsyncInputRefs });
      }
      if (generationRecord) {
        await recordImageGenerationResult({
          ...generationRecord,
          durationMs,
          status: 'failed',
          errorCode,
        }).catch((recordError) => {
          logger.error(
            '[ImageGeneration] failed to record image-to-image error',
            getErrorLog(recordError),
          );
        });
        await recordImageUsage({
          req,
          requestId,
          provider: generationRecord.provider,
          model: generationRecord.model,
          modelKey: generationRecord.modelKey,
          taskType: generationRecord.taskType,
          status: 'failed',
          imageCount: 0,
          durationMs,
        });
      }

      return res.status(error.statusCode || 500).json(
        getClientErrorPayload(error, '图片改图失败，请稍后重试。', {
          errorCode,
          requestId,
          state,
        }),
      );
    }
  });
});

router.post('/multi-reference', configMiddleware, (req, res) => {
  const requestReceivedAt = new Date().toISOString();
  const requestId = createRequestId();
  uploadReferenceImages(req, res, async (uploadError) => {
    if (uploadError) {
      const isSizeError = uploadError.code === 'LIMIT_FILE_SIZE';
      const isCountError =
        uploadError.code === 'LIMIT_FILE_COUNT' || uploadError.code === 'LIMIT_UNEXPECTED_FILE';
      let message = uploadError.message;
      if (isSizeError) {
        message = '单张图片不能超过 8MB。';
      } else if (isCountError) {
        message = '多图商品替换最多上传 3 张图片。';
      }
      return res.status(400).json({ message });
    }

    let generationRecord = null;
    let generationStartedAt = null;
    let stagedAsyncInputRefs = null;
    let asyncJobQueued = false;
    let stage = 'route_received';

    try {
      const {
        platform = '通用',
        imageType = '通用营销图',
        modelKey,
        mode,
        model,
        prompt = '',
        aspectRatio = '1:1',
        subMode = 'dual-product-replace',
        frontendTaskId,
      } = req.body ?? {};
      const count = 1;
      const files = req.files ?? [];
      const inputImageRoles = parseInputImageRoles(req.body?.inputImageRoles);

      logger.info('[ImageGeneration] multi-reference request received', {
        requestId,
        stage,
        state: 'waiting',
        userHash: getUserHash(req.user?.id),
        taskType: 'multi-reference',
        inputImageCount: files.length,
      });

      if (!MULTI_REFERENCE_SUB_MODES.includes(subMode)) {
        return res.status(400).json({ message: '多图参考生成子模式不正确。' });
      }

      const resolvedModel = resolveImageGenerationModel({ modelKey, mode, model });
      stage = 'model_resolved';

      if (!resolvedModel.capabilities.includes('multi-reference')) {
        const error = new Error(
          '当前模型不支持多图商品替换，请切换 GPT Image 2、fal GPT Image 2 Edit 或 Seedream 5.0 Pro。',
        );
        error.statusCode = 400;
        error.code = 'MODEL_NOT_SUPPORT_MULTI_REFERENCE';
        throw error;
      }

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ message: '请先填写生成需求。' });
      }

      if (subMode === 'dual-product-replace' && (files.length < 2 || files.length > 3)) {
        return res.status(400).json({
          message: '多图商品替换需要上传 1 张商品图和 1-2 张对标/参考图，最多 3 张图片。',
        });
      }

      if (subMode === 'multi-reference' && (files.length < 1 || files.length > 3)) {
        return res.status(400).json({ message: '多图参考生成需要上传 1 到 3 张参考图。' });
      }

      const validation = validateGenerationFields({ platform, imageType, aspectRatio, count });
      if (validation.message) {
        return res.status(400).json({ message: validation.message });
      }

      const normalizedRoles =
        subMode === 'dual-product-replace'
          ? files.map((_, index) =>
              index === 1 ? '白底商品图' : `对标/参考图 ${index === 0 ? 1 : index}`,
            )
          : files.map((_, index) => inputImageRoles[index] || `参考图 ${index + 1}`);
      const finalPrompt =
        subMode === 'dual-product-replace'
          ? buildDualReferencePrompt({ prompt, platform, imageType, aspectRatio })
          : buildMultiReferencePrompt({
              prompt,
              platform,
              imageType,
              aspectRatio,
              inputImageRoles: normalizedRoles,
            });
      const size = getImageSize(aspectRatio);
      const preparedImages = await Promise.all(
        files.map((file, index) =>
          prepareImageToImageInput(
            file,
            getDebugImagePath(requestId, `multi-reference-${index + 1}`),
          ),
        ),
      );
      const startedAt = Date.now();
      generationStartedAt = startedAt;
      generationRecord = {
        userId: req.user?.id || null,
        requestId,
        modelKey: resolvedModel.modelKey,
        model: resolvedModel.model,
        taskType: 'multi-reference',
        subMode,
        provider: resolvedModel.provider,
        durationMs: null,
      };

      stage = 'provider_start';
      logger.info('[ImageGeneration] multi-reference request prepared', {
        requestId,
        stage,
        state: 'running',
        userHash: getUserHash(req.user?.id),
        provider: resolvedModel.provider,
        modelKey: resolvedModel.modelKey,
        model: resolvedModel.model,
        subMode,
        platform,
        imageType,
        aspectRatio,
        count: 1,
        size,
        promptLength: finalPrompt.length,
        inputImageCount: preparedImages.length,
        debugImageSaved: preparedImages.some((image) => Boolean(image.debugPath)),
        alphaFlattenedCount: preparedImages.filter((image) => image.alphaFlattened).length,
      });

      if (
        isAPIMartImg2ResolvedModel(resolvedModel) &&
        shouldUseAPIMartImg2AsyncForUser(req.user?.id)
      ) {
        stagedAsyncInputRefs = await stageAPIMartImg2ImageInputs({
          req,
          requestId,
          taskType: 'multi-reference',
          imageInputs: preparedImages.map((image) => image.image),
          metadata: preparedImages.map((image) => image.processed),
        });
        const job = await enqueueAPIMartImg2Job({
          userId: req.user?.id,
          tenantId: req.user?.tenantId,
          requestId,
          frontendTaskId,
          businessType:
            subMode === 'dual-product-replace'
              ? 'product_replacement'
              : 'multi_reference_generation',
          taskType: 'multi-reference',
          subMode,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
          modelKey: resolvedModel.modelKey,
          payload: {
            taskType: 'multi-reference',
            subMode,
            prompt: finalPrompt,
            imageInputRefs: stagedAsyncInputRefs,
            platform,
            imageType,
            aspectRatio,
            size,
            count: 1,
          },
        });
        const jobCreatedAt = job.deduplicated ? null : new Date().toISOString();
        if (job.deduplicated) {
          await cleanupAPIMartImg2InputRefs({ req, refs: stagedAsyncInputRefs });
          stagedAsyncInputRefs = null;
        } else {
          asyncJobQueued = true;
        }

        stage = 'queued';
        logSuccessfulHttpResponse({
          requestId,
          route: '/multi-reference',
          requestReceivedAt,
          jobCreatedAt,
          internalTaskId: job.internalTaskId,
          statusCode: 202,
        });
        return res.status(202).json({
          state: 'queued',
          status: job.status,
          internalTaskId: job.internalTaskId,
          submittedToProvider: job.submittedToProvider,
          modelKey: resolvedModel.modelKey,
          model: resolvedModel.model,
          provider: resolvedModel.provider,
          subMode,
          size,
          requestId,
          deduplicated: Boolean(job.deduplicated),
        });
      }

      const imageEgressRolloutMode = isImageEgressAsyncResolvedModel(resolvedModel)
        ? shouldUseImageEgressAsyncForUser({ userId: req.user?.id })
        : null;
      if (resolvedModel.asyncOnly && !imageEgressRolloutMode) {
        const error = new Error('该模型仅在 durable async rollout 启用时可用。');
        error.code = 'IMAGE_EGRESS_ASYNC_DISABLED';
        error.statusCode = 400;
        throw error;
      }
      if (imageEgressRolloutMode) {
        const businessType =
          subMode === 'dual-product-replace' ? 'product_replacement' : 'multi_reference_generation';
        const { job, created } = await findOrStageAndEnqueueImageEgressJob({
          req,
          userId: req.user?.id,
          tenantId: req.user?.tenantId,
          frontendTaskId,
          requestId,
          businessType,
          taskType: 'multi-reference',
          subMode,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
          modelKey: resolvedModel.modelKey,
          payload: {
            taskType: 'multi-reference',
            subMode,
            prompt: finalPrompt,
            platform,
            imageType,
            aspectRatio,
            size,
            count: 1,
          },
          imageInputs: preparedImages.map((image) => image.image),
          inputMetadata: preparedImages.map((image) => image.processed),
          rolloutMode: imageEgressRolloutMode,
        });
        const jobCreatedAt = created ? new Date().toISOString() : null;
        logSuccessfulHttpResponse({
          requestId,
          route: '/multi-reference',
          requestReceivedAt,
          jobCreatedAt,
          internalTaskId: job.internalTaskId,
          statusCode: 202,
        });
        return res.status(202).json({
          state: 'queued',
          status: job.status,
          internalTaskId: job.internalTaskId,
          submittedToProvider: Boolean(job.submittedToProvider),
          modelKey: resolvedModel.modelKey,
          model: resolvedModel.model,
          provider: resolvedModel.provider,
          subMode,
          size,
          requestId,
          deduplicated: !created,
        });
      }

      req.usageContext = await admitImageUsage({
        reservationScope: 'request',
        req,
        requestId,
        ...resolvedModel,
        taskType: 'multi-reference',
        subMode,
      });
      let result = await generateImageByResolvedModel(resolvedModel, {
        taskType: 'multi-reference',
        subMode,
        prompt: finalPrompt,
        imageInputs: preparedImages.map((image) => image.image),
        platform,
        imageType,
        aspectRatio,
        size,
        count: 1,
      });
      result = await normalizeFalGPTImage2Result({
        result,
        resolvedModel,
        aspectRatio,
        size,
        requestId,
        taskType: 'multi-reference',
      });
      stage = 'provider_success';
      const durationMs = Date.now() - startedAt;

      stage = 'proxy_register_start';
      const { images, outputCount, resultHost } = buildResultImages(
        result,
        resolvedModel.provider,
        requestId,
      );

      stage = 'response_sent';
      logger.info('[ImageGeneration] multi-reference response received', {
        requestId,
        stage,
        state: 'success',
        userHash: getUserHash(req.user?.id),
        provider: resolvedModel.provider,
        modelKey: resolvedModel.modelKey,
        model: resolvedModel.model,
        subMode,
        status: 'success',
        durationMs,
        outputCount,
        resultHost,
      });

      await recordImageGenerationResult({
        ...generationRecord,
        durationMs,
        status: 'success',
        outputCount,
        resultHost,
      });
      await recordImageUsage({
        req,
        requestId,
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        modelKey: resolvedModel.modelKey,
        taskType: 'multi-reference',
        subMode,
        status: 'succeeded',
        imageCount: outputCount,
        providerTaskId: result.taskId || null,
        durationMs,
        metadata: getImageProviderBillingMetadata(resolvedModel.provider, result),
      });

      logSuccessfulHttpResponse({
        requestId,
        route: '/multi-reference',
        requestReceivedAt,
        statusCode: 200,
      });
      return res.status(200).json({
        state: 'success',
        images,
        modelKey: resolvedModel.modelKey,
        model: resolvedModel.model,
        provider: resolvedModel.provider,
        subMode,
        size,
        requestId,
        providerTaskId: result.taskId || null,
      });
    } catch (error) {
      const durationMs = generationStartedAt ? Date.now() - generationStartedAt : null;
      const errorCode = error.code || error.statusCode || 'MULTI_REFERENCE_FAILED';
      const state = getGenerationStateFromError(errorCode);
      logger.error(
        '[ImageGeneration] multi-reference failed',
        getErrorLog(error, {
          requestId,
          stage: stage === 'provider_start' ? 'provider_failed' : stage,
          state,
          taskType: generationRecord?.taskType || 'multi-reference',
          provider: generationRecord?.provider || null,
          modelKey: generationRecord?.modelKey || null,
          model: generationRecord?.model || null,
          durationMs,
          errorCode,
        }),
      );

      if (stagedAsyncInputRefs && !asyncJobQueued) {
        await cleanupAPIMartImg2InputRefs({ req, refs: stagedAsyncInputRefs });
      }
      if (generationRecord) {
        await recordImageGenerationResult({
          ...generationRecord,
          durationMs,
          status: 'failed',
          errorCode,
        }).catch((recordError) => {
          logger.error(
            '[ImageGeneration] failed to record multi-reference error',
            getErrorLog(recordError),
          );
        });
        await recordImageUsage({
          req,
          requestId,
          provider: generationRecord.provider,
          model: generationRecord.model,
          modelKey: generationRecord.modelKey,
          taskType: generationRecord.taskType,
          subMode: generationRecord.subMode,
          status: 'failed',
          imageCount: 0,
          durationMs,
        });
      }

      return res
        .status(error.statusCode || 500)
        .json(
          getClientErrorPayload(
            error,
            generationRecord?.subMode === 'dual-product-replace'
              ? '多图商品替换失败，请稍后重试。'
              : '多图参考生成失败，请稍后重试。',
            { errorCode, requestId, state },
          ),
        );
    }
  });
});

const WHITE_BACKGROUND_PROMPT =
  '请将图片中的核心商品主体保留下来，生成一张干净的白色背景电商商品图。' +
  '去除原图中的营销文案、装饰元素、复杂背景和多余物体。' +
  '尽量保持商品包装、品牌标识、主要文字、颜色、形状和结构不变。' +
  '商品主体需要完整露出，不要裁切品牌名、包装文字和商品边缘。' +
  '输出适合电商使用的 1:1 白底商品图。';

function getWhiteBackgroundTimeoutMs() {
  const value = Number.parseInt(
    process.env.SILICONFLOW_IMAGE_TIMEOUT_MS || process.env.IMAGE_GENERATION_TIMEOUT_MS || '',
    10,
  );
  return Number.isFinite(value) && value > 0 ? value : 120000;
}

function buildWhiteBackgroundImages(images) {
  return images.map((image) => {
    if (image?.url) {
      const registered = registerResultImage({ resultUrl: image.url, provider: 'siliconflow' });
      if (registered) {
        return {
          url: null,
          b64_json: null,
          proxiedUrl: registered.proxyPath,
          downloadUrl: registered.downloadPath,
        };
      }
      return { url: image.url, b64_json: null, proxiedUrl: null, downloadUrl: null };
    }
    return { url: null, b64_json: image?.b64_json ?? null, proxiedUrl: null, downloadUrl: null };
  });
}

router.post('/white-background', (req, res) => {
  const requestReceivedAt = new Date().toISOString();
  const requestId = createRequestId();
  uploadWhiteBackgroundImage(req, res, async (uploadError) => {
    if (uploadError) {
      const isSizeError = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        message: isSizeError ? '图片不能超过 8MB。' : uploadError.message,
      });
    }

    let stage = 'route_received';
    let startedAt = null;

    try {
      logger.info('[ImageGeneration] white-background request received', {
        requestId,
        stage,
        state: 'waiting',
        userHash: getUserHash(req.user?.id),
        taskType: 'white-background',
      });

      if (!req.file) {
        return res.status(400).json({ message: '请先上传需要生成白底图的商品图。', requestId });
      }

      if (!process.env.SILICONFLOW_API_KEY) {
        return res.status(500).json({
          message: '白底图生成服务未配置，请联系管理员。',
          errorCode: 'SILICONFLOW_API_KEY_MISSING',
          requestId,
        });
      }

      stage = 'model_resolved';
      const size = getImageSize('1:1');
      const preparedImage = await prepareImageToImageInput(
        req.file,
        getDebugImagePath(requestId, 'white-background-1'),
      );

      startedAt = Date.now();
      stage = 'provider_start';
      logger.info('[ImageGeneration] white-background request summary', {
        requestId,
        stage,
        state: 'running',
        userHash: getUserHash(req.user?.id),
        provider: 'siliconflow',
        model: IMAGE_TO_IMAGE_MODEL,
        taskType: 'white-background',
        size,
        inputImageCount: 1,
        promptLength: WHITE_BACKGROUND_PROMPT.length,
      });

      req.usageContext = await admitImageUsage({
        reservationScope: 'request',
        req,
        requestId,
        provider: 'siliconflow',
        model: IMAGE_TO_IMAGE_MODEL,
        taskType: 'white-background',
      });
      const result = await generateImageToImage({
        image: preparedImage.image,
        prompt: WHITE_BACKGROUND_PROMPT,
        negativePrompt: NEGATIVE_PROMPT,
        size,
        count: 1,
        timeoutMs: getWhiteBackgroundTimeoutMs(),
      });
      stage = 'provider_success';
      const durationMs = Date.now() - startedAt;

      stage = 'proxy_register_start';
      const resultHost = extractHostname(result.images?.[0]?.url);
      const images = buildWhiteBackgroundImages(result.images || []);

      stage = 'response_sent';
      logger.info('[ImageGeneration] white-background response sent', {
        requestId,
        stage,
        state: 'success',
        userHash: getUserHash(req.user?.id),
        provider: 'siliconflow',
        model: IMAGE_TO_IMAGE_MODEL,
        taskType: 'white-background',
        durationMs,
        outputCount: images.length,
        resultHost,
      });
      await recordImageUsage({
        req,
        requestId,
        provider: 'siliconflow',
        model: IMAGE_TO_IMAGE_MODEL,
        taskType: 'white-background',
        businessType: 'white_background',
        status: 'succeeded',
        imageCount: images.length,
        durationMs,
      });

      logSuccessfulHttpResponse({
        requestId,
        route: '/white-background',
        requestReceivedAt,
        statusCode: 200,
      });
      return res.status(200).json({
        state: 'success',
        images,
        provider: 'siliconflow',
        model: IMAGE_TO_IMAGE_MODEL,
        taskType: 'white-background',
        size,
        requestId,
      });
    } catch (error) {
      const durationMs = startedAt ? Date.now() - startedAt : null;
      const errorCode =
        error.code ||
        (error.statusCode === 401 || error.statusCode === 403 ? 'SILICONFLOW_AUTH_FAILED' : null) ||
        'SILICONFLOW_WHITE_BACKGROUND_FAILED';
      const state = getGenerationStateFromError(errorCode);
      logger.error(
        '[ImageGeneration] white-background failed',
        getErrorLog(error, {
          requestId,
          stage: stage === 'provider_start' ? 'provider_failed' : stage,
          state,
          provider: 'siliconflow',
          model: IMAGE_TO_IMAGE_MODEL,
          taskType: 'white-background',
          durationMs,
          errorCode,
        }),
      );
      await recordImageUsage({
        req,
        requestId,
        provider: 'siliconflow',
        model: IMAGE_TO_IMAGE_MODEL,
        taskType: 'white-background',
        businessType: 'white_background',
        status: 'failed',
        imageCount: 0,
        durationMs,
      });

      return res.status(error.statusCode || 500).json(
        getClientErrorPayload(error, '白底图生成失败，请稍后重试。', {
          errorCode,
          requestId,
          state,
        }),
      );
    }
  });
});

module.exports = router;
