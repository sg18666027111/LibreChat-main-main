const SKU_TEMPLATE_V1 = Object.freeze({
  key: 'sku_red_delivery_label_v1',
  assetVersion: 2,
  width: 800,
  height: 800,
  background: { r: 255, g: 255, b: 255, alpha: 1 },
  sourceArea: Object.freeze({ x: 0, y: 0, width: 800, height: 800 }),
  sourceFit: 'cover',
  assetSlots: Object.freeze({
    leftIcon: 'sku-red-delivery-left.png',
    rightIcon: 'sku-red-delivery-right.png',
  }),
  leftIconArea: Object.freeze({ x: 24, y: 20, width: 144, height: 220 }),
  rightIconArea: Object.freeze({ x: 520, y: 20, width: 256, height: 90 }),
  badge: Object.freeze({
    x: 0,
    y: 728,
    height: 72,
    minWidth: 168,
    maxWidth: 776,
    maxTextWidth: 740,
    radius: 36,
    paddingX: 16,
    fontFamily: 'Arial, sans-serif',
    fontSize: 26,
    fontWeight: 700,
    background: '#d71920',
    textColor: '#ffffff',
  }),
  maxTextRows: 6,
});

const SKU_TEMPLATES = Object.freeze({
  [SKU_TEMPLATE_V1.key]: SKU_TEMPLATE_V1,
});

function createSkuValidationError(message, code, field) {
  const error = new Error(message);
  error.code = code;
  error.field = field;
  error.statusCode = 400;
  return error;
}

function getSkuTemplate(templateKey = SKU_TEMPLATE_V1.key) {
  const template = SKU_TEMPLATES[templateKey];
  if (!template) {
    throw createSkuValidationError(
      `不支持的 SKU 模板：${templateKey}`,
      'SKU_TEMPLATE_UNKNOWN',
      'templateKey',
    );
  }
  return template;
}

function isCjkCharacter(character) {
  const codePoint = character.codePointAt(0);
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x2fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff)
  );
}

function estimateCharacterWidth(character, template) {
  if (isCjkCharacter(character)) {
    return template.badge.fontSize;
  }
  if (/\s/u.test(character)) {
    return template.badge.fontSize * 0.32;
  }
  if ((character.codePointAt(0) ?? 0) > 0x7f) {
    return template.badge.fontSize * 0.85;
  }
  return template.badge.fontSize * 0.58;
}

function estimateSkuTextWidth(text, template = SKU_TEMPLATE_V1) {
  return Array.from(String(text)).reduce(
    (total, character) => total + estimateCharacterWidth(character, template),
    0,
  );
}

function assertSkuTextFits(text, template, field = 'text') {
  if (typeof text !== 'string' || !text.trim()) {
    throw createSkuValidationError('文字不能为空。', 'SKU_TEXT_EMPTY', field);
  }
  const normalized = text.trim();
  if (normalized.includes('\n') || normalized.includes('\r')) {
    throw createSkuValidationError('文字必须保持单行。', 'SKU_TEXT_MULTILINE', field);
  }
  const textWidth = estimateSkuTextWidth(normalized, template);
  const maxTextWidth = template.badge.maxWidth - template.badge.paddingX * 2;
  if (textWidth > maxTextWidth) {
    throw createSkuValidationError(
      '文字过长，无法在模板安全区域内保持单行。',
      'SKU_TEXT_TOO_LONG',
      field,
    );
  }
  return { text: normalized, textWidth };
}

function validateSkuInput({ textRows, templateKey = SKU_TEMPLATE_V1.key } = {}) {
  const template = getSkuTemplate(templateKey);
  if (!Array.isArray(textRows)) {
    throw createSkuValidationError('文字行必须是数组。', 'SKU_TEXT_ROWS_INVALID', 'textRows');
  }

  const normalizedRows = textRows
    .map((row) => (typeof row === 'string' ? row.trim() : ''))
    .filter(Boolean);
  if (!normalizedRows.length) {
    throw createSkuValidationError('至少填写一条文字。', 'SKU_TEXT_ROWS_EMPTY', 'textRows');
  }
  if (normalizedRows.length > template.maxTextRows) {
    throw createSkuValidationError(
      `文字行不能超过 ${template.maxTextRows} 条。`,
      'SKU_TEXT_ROWS_TOO_MANY',
      'textRows',
    );
  }
  normalizedRows.forEach((row, index) => {
    assertSkuTextFits(row, template, `textRows[${index}]`);
  });

  return { textRows: normalizedRows, template };
}

module.exports = {
  SKU_TEMPLATE_V1,
  SKU_TEMPLATES,
  assertSkuTextFits,
  createSkuValidationError,
  estimateSkuTextWidth,
  getSkuTemplate,
  validateSkuInput,
};
