const mongoose = require('mongoose');
const sharp = require('sharp');
const { randomUUID } = require('crypto');
const { createMethods, logger } = require('@librechat/data-schemas');
const { getStorageMetadata } = require('@librechat/api');
const { resizeImageBuffer } = require('~/server/services/Files/images/resize');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { CATEGORY_BATCH_PACKAGING, serializeTemplate } = require('./promptTemplateStore');

function notFound() {
  return Object.assign(new Error('模板或图例不存在。'), { statusCode: 404 });
}

async function getTemplate(templateId) {
  const template = await createMethods(mongoose).getImagePromptTemplateById(templateId);
  if (!template || template.category !== CATEGORY_BATCH_PACKAGING) throw notFound();
  return template;
}

async function saveExampleImage(req, templateId) {
  await getTemplate(templateId);
  let image;
  let format;
  try {
    const metadata = await sharp(req.file.buffer, { limitInputPixels: 40000000 }).metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format)) throw new Error('Unsupported image');
    format = metadata.format;
    image = await resizeImageBuffer(req.file.buffer, { px: 1024 });
  } catch {
    throw Object.assign(new Error('请上传有效的 PNG、JPG/JPEG 或 WebP 图片。'), {
      statusCode: 400,
    });
  }
  // Reuse the configured storage adapter, but let the shared template own its image.
  // A personal File record would allow its uploader to delete it after template access is revoked.
  const source = getFileStrategy(req.config, { isImage: true });
  const strategy = getStrategyFunctions(source);
  const id = randomUUID();
  const filepath = await strategy.saveBuffer({
    userId: req.user.id,
    tenantId: req.user.tenantId,
    fileName: `${id}-template-example.${format}`,
    buffer: image.buffer,
  });
  if (typeof filepath !== 'string' || !filepath.trim()) throw new Error('图例存储失败。');
  const { storageKey } = getStorageMetadata({ filepath, source });
  const exampleImage = { id, source, filepath, storageKey, type: `image/${format}` };
  try {
    const updated = await createMethods(mongoose).updateImagePromptTemplate({
      templateId,
      updates: { exampleImage, updatedBy: req.user.id },
    });
    return serializeTemplate(updated);
  } catch (error) {
    try {
      await strategy.deleteFile(req, { ...exampleImage, file_id: id });
    } catch {
      logger.warn('[PromptTemplateExample] Unattached upload cleanup failed');
    }
    throw error;
  }
}

async function removeExampleImage(req, templateId) {
  await getTemplate(templateId);
  const updated = await createMethods(mongoose).updateImagePromptTemplate({
    templateId,
    updates: { exampleImage: null, updatedBy: req.user.id },
  });
  // Duplicated templates can share this file; clearing one reference must not break the others.
  return serializeTemplate(updated);
}

async function readExampleImage(req, templateId, canManage) {
  const template = await getTemplate(templateId);
  const image = template.exampleImage;
  if ((!canManage && template.isEnabled === false) || !image) throw notFound();
  const { getDownloadStream } = getStrategyFunctions(image.source);
  return {
    stream: await getDownloadStream(req, image.storageKey || image.filepath),
    contentType: image.type,
  };
}

module.exports = { saveExampleImage, removeExampleImage, readExampleImage };
