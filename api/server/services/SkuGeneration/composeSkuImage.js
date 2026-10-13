const sharp = require('sharp');
const {
  assertSkuTextFits,
  createSkuValidationError,
  estimateSkuTextWidth,
  getSkuTemplate,
  SKU_TEMPLATE_V1,
  validateSkuInput,
} = require('./skuTemplate');

function escapeSvgText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getBadgeWidth(textWidth, template) {
  return Math.max(template.badge.minWidth, Math.ceil(textWidth + template.badge.paddingX * 2));
}

function createBadgePath({ width, template }) {
  const { x, y, height, radius } = template.badge;
  const right = x + width;
  const bottom = y + height;
  const capRadius = Math.min(radius, height / 2);
  return [
    `M ${x} ${y}`,
    `H ${right - capRadius}`,
    `A ${capRadius} ${capRadius} 0 0 1 ${right} ${y + capRadius}`,
    `V ${bottom - capRadius}`,
    `A ${capRadius} ${capRadius} 0 0 1 ${right - capRadius} ${bottom}`,
    `H ${x}`,
    'Z',
  ].join(' ');
}

function createTextSvg({ text, template = SKU_TEMPLATE_V1 }) {
  const { text: normalized, textWidth } = assertSkuTextFits(text, template, 'text');
  const badgeWidth = getBadgeWidth(textWidth, template);
  const baseline =
    template.badge.y +
    (template.badge.height - template.badge.fontSize) / 2 +
    template.badge.fontSize * 0.82;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${template.width}" height="${template.height}"><style>text { font-family: ${template.badge.fontFamily}; font-size: ${template.badge.fontSize}px; font-weight: ${template.badge.fontWeight}; fill: ${template.badge.textColor}; }</style><path d="${createBadgePath({ width: badgeWidth, template })}" fill="${template.badge.background}"/><text x="${template.badge.x + template.badge.paddingX}" y="${baseline}">${escapeSvgText(normalized)}</text></svg>`;
}

function imageInvalidError(field, cause) {
  return (
    createSkuValidationError('图片格式无效或无法读取。', 'SKU_IMAGE_INVALID', field).withCause?.(
      cause,
    ) ||
    Object.assign(
      createSkuValidationError('图片格式无效或无法读取。', 'SKU_IMAGE_INVALID', field),
      { cause },
    )
  );
}

async function fitImage(buffer, area, field, fit = 'contain') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw imageInvalidError(field);
  }
  try {
    return await sharp(buffer)
      .rotate()
      .resize(area.width, area.height, {
        fit,
        position: 'centre',
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      })
      .png({ compressionLevel: 9, adaptiveFiltering: false, force: true })
      .toBuffer();
  } catch (error) {
    throw imageInvalidError(field, error);
  }
}

async function composeSkuImage({
  sourceBuffer,
  leftIconBuffer,
  rightIconBuffer,
  text,
  templateKey = SKU_TEMPLATE_V1.key,
}) {
  const template = getSkuTemplate(templateKey);
  assertSkuTextFits(text, template, 'text');

  const [source, leftIcon, rightIcon] = await Promise.all([
    fitImage(sourceBuffer, template.sourceArea, 'sourceBuffer', template.sourceFit),
    fitImage(leftIconBuffer, template.leftIconArea, 'leftIconBuffer'),
    fitImage(rightIconBuffer, template.rightIconArea, 'rightIconBuffer'),
  ]);
  const textSvg = Buffer.from(createTextSvg({ text: String(text).trim(), template }));
  const { data, info } = await sharp({
    create: {
      width: template.width,
      height: template.height,
      channels: 4,
      background: template.background,
    },
  })
    .composite([
      { input: source, left: template.sourceArea.x, top: template.sourceArea.y },
      { input: leftIcon, left: template.leftIconArea.x, top: template.leftIconArea.y },
      { input: rightIcon, left: template.rightIconArea.x, top: template.rightIconArea.y },
      { input: textSvg, left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9, adaptiveFiltering: false, force: true })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    mimeType: 'image/png',
    width: info.width,
    height: info.height,
    templateKey: template.key,
  };
}

module.exports = {
  composeSkuImage,
  createTextSvg,
  createBadgePath,
  escapeSvgText,
  estimateSkuTextWidth,
  getBadgeWidth,
  validateSkuInput,
};
