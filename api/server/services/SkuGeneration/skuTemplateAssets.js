const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { createSkuValidationError, getSkuTemplate } = require('./skuTemplate');

const ASSET_DIRECTORY = path.join(__dirname, 'assets');

function getAssetContentType(filename) {
  if (filename.endsWith('.png')) {
    return 'image/png';
  }
  if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (filename.endsWith('.webp')) {
    return 'image/webp';
  }
  return null;
}

async function readSkuTemplateAsset({ templateKey, slot }) {
  const template = getSkuTemplate(templateKey);
  const filename = template.assetSlots?.[slot];
  if (!filename) {
    throw createSkuValidationError(
      `不支持的 SKU 模板素材：${slot}`,
      'SKU_TEMPLATE_ASSET_UNKNOWN',
      'slot',
    );
  }

  const contentType = getAssetContentType(filename);
  if (!contentType) {
    throw createSkuValidationError('SKU 模板素材格式无效。', 'SKU_TEMPLATE_ASSET_INVALID', 'slot');
  }

  const assetPath = path.join(ASSET_DIRECTORY, filename);
  try {
    const buffer = await fs.readFile(assetPath);
    const metadata = await sharp(buffer).metadata();
    if (!metadata.width || !metadata.height || metadata.format !== contentType.slice(6)) {
      throw new Error('invalid template asset');
    }
    return { buffer, contentType, filename };
  } catch (cause) {
    throw Object.assign(
      createSkuValidationError('SKU 模板素材读取失败。', 'SKU_TEMPLATE_ASSET_READ_FAILED', 'slot'),
      { cause },
    );
  }
}

module.exports = {
  ASSET_DIRECTORY,
  readSkuTemplateAsset,
};
