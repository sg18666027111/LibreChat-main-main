const mongoose = require('mongoose');
const { createMethods, logger } = require('@librechat/data-schemas');
const {
  PACKAGING_TEMPLATES,
} = require('~/server/services/ImageGeneration/packagingPromptTemplates');
const {
  formatPromptTemplateText,
} = require('~/server/services/ImageGeneration/promptTemplateFormatter');

const CATEGORY_BATCH_PACKAGING = 'batch_packaging';
const DEFAULT_BATCH_PROMPT_TEMPLATE_KEY = 'batch_packaging_default';
const MAX_PACKAGING_STYLES_PER_BATCH = 8;
const MAX_NORMALIZED_PACKAGING_TEMPLATE_IDENTIFIERS = 16;
const TEMPLATE_ROLE_GLOBAL_BUSINESS = 'global_business';
const TEMPLATE_ROLE_PACKAGING_STYLE = 'packaging_style';
const TEMPLATE_ROLES = Object.freeze([
  TEMPLATE_ROLE_GLOBAL_BUSINESS,
  TEMPLATE_ROLE_PACKAGING_STYLE,
]);
const SYSTEM_PACKAGING_TEMPLATE_KEYS = new Set(PACKAGING_TEMPLATES.map((template) => template.id));

let seedPromise = null;

function getDbMethods() {
  return createMethods(mongoose);
}

function normalizeUserId(userId) {
  return typeof userId === 'string' && userId.trim() ? userId.trim() : '';
}

function createSystemTemplateSeed(template, index) {
  return {
    key: template.id,
    name: template.name,
    description: '系统内置批量包装主图模板',
    category: CATEGORY_BATCH_PACKAGING,
    templateRole: TEMPLATE_ROLE_PACKAGING_STYLE,
    taskType: 'batch_packaging',
    prompt: template.prompt,
    defaultPrompt: template.prompt,
    platform: '通用',
    imageType: '商品主图',
    isSystem: true,
    isEnabled: true,
    sortOrder: index + 10,
  };
}

function createDefaultBusinessTemplateSeed() {
  const defaultPrompt = [
    '电商包装主图业务提示词。',
    '请根据商品标题 "{{title}}" 生成适合电商平台展示的包装主图，突出商品包装质感、品类特征、清晰卖点和干净商业摄影效果。',
    '包装文字需从标题中提炼核心产品名和简短卖点，排版清晰自然，不要拥挤。',
  ].join('\n');

  return {
    key: DEFAULT_BATCH_PROMPT_TEMPLATE_KEY,
    name: '默认批量包装主图提示词',
    description: '批量包装主图默认业务提示词',
    category: CATEGORY_BATCH_PACKAGING,
    templateRole: TEMPLATE_ROLE_GLOBAL_BUSINESS,
    taskType: 'batch_packaging',
    prompt: defaultPrompt,
    defaultPrompt,
    platform: '通用',
    imageType: '商品主图',
    isSystem: true,
    isEnabled: true,
    sortOrder: 0,
  };
}

function getSystemTemplateSeeds() {
  return [
    createDefaultBusinessTemplateSeed(),
    ...PACKAGING_TEMPLATES.map(createSystemTemplateSeed),
  ];
}

function getEffectiveTemplateRole(template) {
  if (TEMPLATE_ROLES.includes(template?.templateRole)) {
    return template.templateRole;
  }
  if (template?.key === DEFAULT_BATCH_PROMPT_TEMPLATE_KEY) {
    return TEMPLATE_ROLE_GLOBAL_BUSINESS;
  }
  if (SYSTEM_PACKAGING_TEMPLATE_KEYS.has(template?.key)) {
    return TEMPLATE_ROLE_PACKAGING_STYLE;
  }
  return TEMPLATE_ROLE_GLOBAL_BUSINESS;
}

async function ensureBatchPackagingPromptTemplatesSeeded() {
  if (!seedPromise) {
    seedPromise = (async () => {
      const dbMethods = getDbMethods();
      const existing = await dbMethods.getImagePromptTemplates({
        category: CATEGORY_BATCH_PACKAGING,
      });
      const seeds = getSystemTemplateSeeds();

      if (!existing.length) {
        await dbMethods.seedImagePromptTemplates(seeds);
        return;
      }

      const existingKeys = new Set(existing.map((template) => template.key));
      const missingSeeds = seeds.filter((template) => !existingKeys.has(template.key));
      if (missingSeeds.length) {
        await dbMethods.seedImagePromptTemplates(missingSeeds);
      }
    })().catch((error) => {
      seedPromise = null;
      logger.error('[ImageGeneration] prompt template seed failed', {
        errorCode: error?.code || 'PROMPT_TEMPLATE_SEED_FAILED',
        message: error?.message,
      });
      throw error;
    });
  }

  return seedPromise;
}

function serializeTemplate(template) {
  if (!template) {
    return null;
  }

  const source = typeof template.toObject === 'function' ? template.toObject() : template;
  return {
    _id: source._id?.toString?.() || source._id,
    id: source._id?.toString?.() || source._id,
    key: source.key,
    name: source.name,
    description: source.description || '',
    exampleImageUrl: source.exampleImage?.id
      ? `/api/image-generation/prompt-templates/${encodeURIComponent(String(source._id || source.key))}/example-image?v=${encodeURIComponent(source.exampleImage?.id)}`
      : '',
    category: source.category,
    templateRole: getEffectiveTemplateRole(source),
    taskType: source.taskType || 'batch_packaging',
    prompt: source.prompt,
    defaultPrompt: source.defaultPrompt || '',
    formattedPrompt: source.formattedPrompt || '',
    activePromptSource: source.activePromptSource || 'original',
    formatWarnings: Array.isArray(source.formatWarnings) ? source.formatWarnings : [],
    formattedAt: source.formattedAt,
    formattedBy: source.formattedBy || '',
    platform: source.platform || '',
    imageType: source.imageType || '',
    isSystem: Boolean(source.isSystem),
    isEnabled: source.isEnabled !== false,
    sortOrder: source.sortOrder || 0,
    createdBy: source.createdBy || '',
    updatedBy: source.updatedBy || '',
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function getActivePromptForBatch(template) {
  if (
    template?.activePromptSource === 'formatted' &&
    typeof template.formattedPrompt === 'string' &&
    template.formattedPrompt.trim()
  ) {
    return template.formattedPrompt;
  }

  return template?.prompt || '';
}

function serializeBatchTemplate(template) {
  const serialized = serializeTemplate(template);
  if (!serialized) {
    return null;
  }

  return {
    ...serialized,
    prompt: getActivePromptForBatch(serialized),
  };
}

function sanitizeText(value) {
  return typeof value === 'string'
    ? value.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '').trim()
    : '';
}

function omitUndefinedFields(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  );
}

function getTemplatePayload(body = {}, userId = '') {
  const payload = {
    category: CATEGORY_BATCH_PACKAGING,
    updatedBy: normalizeUserId(userId),
  };

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    payload.name = sanitizeText(body.name);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'description')) {
    payload.description = sanitizeText(body.description);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'taskType')) {
    payload.taskType = body.taskType || 'batch_packaging';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'prompt')) {
    payload.prompt = sanitizeText(body.prompt);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'formattedPrompt')) {
    payload.formattedPrompt = sanitizeText(body.formattedPrompt);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'activePromptSource')) {
    payload.activePromptSource = body.activePromptSource === 'formatted' ? 'formatted' : 'original';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'formatWarnings')) {
    payload.formatWarnings = Array.isArray(body.formatWarnings)
      ? body.formatWarnings.map(sanitizeText)
      : [];
  }
  if (Object.prototype.hasOwnProperty.call(body, 'platform')) {
    payload.platform = sanitizeText(body.platform);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'imageType')) {
    payload.imageType = sanitizeText(body.imageType);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'isEnabled')) {
    payload.isEnabled = body.isEnabled !== false;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
    payload.sortOrder = Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 100;
  }

  return omitUndefinedFields(payload);
}

async function listPromptTemplates({
  category = CATEGORY_BATCH_PACKAGING,
  includeDisabled = true,
  templateRole,
} = {}) {
  if (templateRole && !TEMPLATE_ROLES.includes(templateRole)) {
    const error = new Error('提示词模板角色不正确。');
    error.statusCode = 400;
    throw error;
  }
  await ensureBatchPackagingPromptTemplatesSeeded();
  const templates = await getDbMethods().getImagePromptTemplates({ category, includeDisabled });
  return templates
    .map(serializeTemplate)
    .filter((template) => !templateRole || template.templateRole === templateRole);
}

async function getPromptTemplateForBatch(promptTemplateId) {
  await ensureBatchPackagingPromptTemplatesSeeded();
  const dbMethods = getDbMethods();

  if (promptTemplateId) {
    const template = await dbMethods.getImagePromptTemplateById(String(promptTemplateId));
    if (!template) {
      const error = new Error('提示词模板不存在。');
      error.statusCode = 400;
      throw error;
    }
    if (
      template.category !== CATEGORY_BATCH_PACKAGING ||
      template.isEnabled === false ||
      getEffectiveTemplateRole(template) !== TEMPLATE_ROLE_GLOBAL_BUSINESS
    ) {
      const error = new Error('提示词模板不可用。');
      error.statusCode = 400;
      throw error;
    }
    return serializeBatchTemplate(template);
  }

  const defaultTemplate = await dbMethods.getImagePromptTemplateById(
    DEFAULT_BATCH_PROMPT_TEMPLATE_KEY,
  );
  if (
    defaultTemplate &&
    defaultTemplate.isEnabled !== false &&
    getEffectiveTemplateRole(defaultTemplate) === TEMPLATE_ROLE_GLOBAL_BUSINESS
  ) {
    return serializeBatchTemplate(defaultTemplate);
  }

  const enabledTemplates = await dbMethods.getImagePromptTemplates({
    category: CATEGORY_BATCH_PACKAGING,
    includeDisabled: false,
  });
  const firstEnabled = enabledTemplates.find(
    (template) => getEffectiveTemplateRole(template) === TEMPLATE_ROLE_GLOBAL_BUSINESS,
  );
  const serialized = serializeBatchTemplate(firstEnabled);
  if (!serialized?.prompt?.trim()) {
    const error = new Error('全局提示词模板不可用。');
    error.statusCode = 400;
    throw error;
  }
  return serialized;
}

function createPackagingTemplateError(message = '包装模板不可用。') {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function assertPackagingStyleSelectionLimit(templates) {
  if (templates.length > MAX_PACKAGING_STYLES_PER_BATCH) {
    throw createPackagingTemplateError(
      `每批最多选择 ${MAX_PACKAGING_STYLES_PER_BATCH} 个包装样式。`,
    );
  }
}

async function resolvePackagingStyleTemplates(templateIds) {
  let normalizedIds;
  if (templateIds !== undefined) {
    if (!Array.isArray(templateIds) || templateIds.length === 0) {
      throw createPackagingTemplateError('请至少选择 1 个包装模板。');
    }

    const normalizedTemplateIds = templateIds.map((templateId) => String(templateId).trim());
    if (normalizedTemplateIds.some((templateId) => !templateId)) {
      throw createPackagingTemplateError();
    }
    normalizedIds = [...new Set(normalizedTemplateIds)];
    if (normalizedIds.length > MAX_NORMALIZED_PACKAGING_TEMPLATE_IDENTIFIERS) {
      throw createPackagingTemplateError('请求中的包装模板标识过多。');
    }
  }

  await ensureBatchPackagingPromptTemplatesSeeded();
  const dbMethods = getDbMethods();

  if (templateIds === undefined) {
    const enabledTemplates = await dbMethods.getImagePromptTemplates({
      category: CATEGORY_BATCH_PACKAGING,
      includeDisabled: false,
    });
    const seenTemplateKeys = new Set();
    const defaultTemplates = enabledTemplates
      .filter(
        (template) =>
          template.isSystem === true &&
          template.isEnabled !== false &&
          getEffectiveTemplateRole(template) === TEMPLATE_ROLE_PACKAGING_STYLE,
      )
      .map(serializeBatchTemplate)
      .filter((template) => {
        if (!template?.key || seenTemplateKeys.has(template.key)) {
          return false;
        }
        seenTemplateKeys.add(template.key);
        return true;
      });
    if (!defaultTemplates.length) {
      throw createPackagingTemplateError('请至少选择 1 个包装模板。');
    }
    assertPackagingStyleSelectionLimit(defaultTemplates);
    return defaultTemplates;
  }

  const resolvedTemplates = [];
  const seenTemplateKeys = new Set();
  for (const templateId of normalizedIds) {
    const template = await dbMethods.getImagePromptTemplateById(templateId);
    if (
      !template ||
      template.category !== CATEGORY_BATCH_PACKAGING ||
      template.isEnabled === false ||
      getEffectiveTemplateRole(template) !== TEMPLATE_ROLE_PACKAGING_STYLE
    ) {
      throw createPackagingTemplateError();
    }

    const serialized = serializeBatchTemplate(template);
    if (!serialized?.key || !serialized.prompt?.trim()) {
      throw createPackagingTemplateError();
    }
    if (seenTemplateKeys.has(serialized.key)) {
      continue;
    }
    seenTemplateKeys.add(serialized.key);
    resolvedTemplates.push(serialized);
  }

  assertPackagingStyleSelectionLimit(resolvedTemplates);
  return resolvedTemplates;
}

async function createPromptTemplate(body, userId) {
  await ensureBatchPackagingPromptTemplatesSeeded();
  if (!TEMPLATE_ROLES.includes(body?.templateRole)) {
    const error = new Error('请选择提示词模板类型。');
    error.statusCode = 400;
    throw error;
  }
  const payload = getTemplatePayload(body, userId);
  const key = `custom_batch_packaging_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const created = await getDbMethods().createImagePromptTemplate({
    ...payload,
    key,
    templateRole: body.templateRole,
    defaultPrompt: '',
    isSystem: false,
    createdBy: normalizeUserId(userId),
  });
  return serializeTemplate(created);
}

async function updatePromptTemplate(templateId, body, userId) {
  await ensureBatchPackagingPromptTemplatesSeeded();
  if (Object.prototype.hasOwnProperty.call(body || {}, 'templateRole')) {
    const error = new Error('提示词模板类型创建后不能修改。');
    error.statusCode = 400;
    throw error;
  }
  const payload = getTemplatePayload(body, userId);
  const updated = await getDbMethods().updateImagePromptTemplate({
    templateId,
    updates: payload,
  });
  return serializeTemplate(updated);
}

async function duplicatePromptTemplate(templateId, userId) {
  await ensureBatchPackagingPromptTemplatesSeeded();
  const dbMethods = getDbMethods();
  const source = await dbMethods.getImagePromptTemplateById(String(templateId));
  if (!source) {
    const error = new Error('提示词模板不存在。');
    error.statusCode = 404;
    throw error;
  }
  const duplicated = await dbMethods.duplicateImagePromptTemplate({
    templateId,
    createdBy: normalizeUserId(userId),
    templateRole: getEffectiveTemplateRole(source),
  });
  return serializeTemplate(duplicated);
}

async function formatPromptTemplate(templateId, { save = false, userId = '' } = {}) {
  await ensureBatchPackagingPromptTemplatesSeeded();
  const dbMethods = getDbMethods();
  const template = await dbMethods.getImagePromptTemplateById(String(templateId));
  if (!template) {
    const error = new Error('提示词模板不存在。');
    error.statusCode = 404;
    throw error;
  }

  const result = formatPromptTemplateText(template.prompt);
  if (save) {
    await dbMethods.updateImagePromptTemplate({
      templateId,
      updates: {
        formattedPrompt: result.formattedPrompt,
        formatWarnings: result.warnings,
        formattedAt: new Date(),
        formattedBy: normalizeUserId(userId),
      },
    });
  }

  return result;
}

async function restorePromptTemplateDefault(templateId) {
  await ensureBatchPackagingPromptTemplatesSeeded();
  const restored = await getDbMethods().restoreImagePromptTemplateDefault({ templateId });
  return serializeTemplate(restored);
}

async function deletePromptTemplate(templateId) {
  await ensureBatchPackagingPromptTemplatesSeeded();
  return getDbMethods().deleteImagePromptTemplate({ templateId });
}

module.exports = {
  serializeTemplate,
  CATEGORY_BATCH_PACKAGING,
  DEFAULT_BATCH_PROMPT_TEMPLATE_KEY,
  MAX_NORMALIZED_PACKAGING_TEMPLATE_IDENTIFIERS,
  MAX_PACKAGING_STYLES_PER_BATCH,
  TEMPLATE_ROLES,
  TEMPLATE_ROLE_GLOBAL_BUSINESS,
  TEMPLATE_ROLE_PACKAGING_STYLE,
  createPromptTemplate,
  deletePromptTemplate,
  duplicatePromptTemplate,
  ensureBatchPackagingPromptTemplatesSeeded,
  formatPromptTemplate,
  getEffectiveTemplateRole,
  getPromptTemplateForBatch,
  listPromptTemplates,
  resolvePackagingStyleTemplates,
  restorePromptTemplateDefault,
  updatePromptTemplate,
};
