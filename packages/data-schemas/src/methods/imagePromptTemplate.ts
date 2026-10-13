import type { Model } from 'mongoose';
import type {
  CreateImagePromptTemplateInput,
  IImagePromptTemplateDocument,
  ImagePromptTemplateCategory,
  ImagePromptTemplateRole,
  UpdateImagePromptTemplateInput,
} from '~/types/imagePromptTemplate';
import { isValidObjectIdString } from '~/utils/objectId';

function normalizeRequiredText(value: unknown, fieldName: string) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`${fieldName}不能为空`);
  }
  return normalized;
}

function normalizeActivePromptSource(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return 'original';
  }
  if (value === 'original' || value === 'formatted') {
    return value;
  }
  throw new Error('提示词来源参数不正确');
}

function getImagePromptTemplateModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.ImagePromptTemplate as Model<IImagePromptTemplateDocument>;
}

function buildTemplateQuery(templateId: string) {
  if (isValidObjectIdString(templateId)) {
    return { _id: templateId };
  }
  return { key: templateId };
}

export type SeedImagePromptTemplateInput = CreateImagePromptTemplateInput & {
  defaultPrompt: string;
  isSystem: true;
};

export function createImagePromptTemplateMethods(mongoose: typeof import('mongoose')) {
  async function getImagePromptTemplates({
    category,
    includeDisabled = true,
  }: {
    category?: ImagePromptTemplateCategory;
    includeDisabled?: boolean;
  } = {}) {
    const ImagePromptTemplate = getImagePromptTemplateModel(mongoose);
    const query: Record<string, unknown> = {};
    if (category) {
      query.category = category;
    }
    if (!includeDisabled) {
      query.isEnabled = true;
    }

    return ImagePromptTemplate.find(query).sort({ sortOrder: 1, createdAt: 1, _id: 1 }).lean();
  }

  async function getImagePromptTemplateById(templateId: string) {
    const ImagePromptTemplate = getImagePromptTemplateModel(mongoose);
    return ImagePromptTemplate.findOne(buildTemplateQuery(templateId)).lean();
  }

  async function createImagePromptTemplate(input: CreateImagePromptTemplateInput) {
    const ImagePromptTemplate = getImagePromptTemplateModel(mongoose);
    const name = normalizeRequiredText(input.name, '模板名称');
    const prompt = normalizeRequiredText(input.prompt, '提示词');
    const key = normalizeRequiredText(input.key, '模板 key');

    return ImagePromptTemplate.create({
      ...input,
      key,
      name,
      prompt,
      defaultPrompt: input.defaultPrompt?.trim() || '',
      formattedPrompt: input.formattedPrompt || '',
      activePromptSource: normalizeActivePromptSource(input.activePromptSource),
      formatWarnings: Array.isArray(input.formatWarnings) ? input.formatWarnings : [],
      formattedAt: input.formattedAt,
      formattedBy: input.formattedBy?.trim() || '',
      isSystem: Boolean(input.isSystem),
      isEnabled: input.isEnabled !== false,
    });
  }

  async function updateImagePromptTemplate({
    templateId,
    updates,
  }: {
    templateId: string;
    updates: UpdateImagePromptTemplateInput;
  }) {
    const ImagePromptTemplate = getImagePromptTemplateModel(mongoose);
    const existing = await ImagePromptTemplate.findOne(buildTemplateQuery(templateId));
    if (!existing) {
      throw new Error('提示词模板不存在');
    }

    const nextUpdates: UpdateImagePromptTemplateInput = { ...updates };
    if (Object.prototype.hasOwnProperty.call(nextUpdates, 'name')) {
      nextUpdates.name = normalizeRequiredText(nextUpdates.name, '模板名称');
    }
    if (Object.prototype.hasOwnProperty.call(nextUpdates, 'prompt')) {
      nextUpdates.prompt = normalizeRequiredText(nextUpdates.prompt, '提示词');
    }
    if (Object.prototype.hasOwnProperty.call(nextUpdates, 'activePromptSource')) {
      nextUpdates.activePromptSource = normalizeActivePromptSource(nextUpdates.activePromptSource);
    }
    if (
      Object.prototype.hasOwnProperty.call(nextUpdates, 'formatWarnings') &&
      !Array.isArray(nextUpdates.formatWarnings)
    ) {
      nextUpdates.formatWarnings = [];
    }

    Object.assign(existing, nextUpdates);
    await existing.save();
    return existing.toObject();
  }

  async function duplicateImagePromptTemplate({
    templateId,
    createdBy,
    templateRole,
  }: {
    templateId: string;
    createdBy?: string;
    templateRole: ImagePromptTemplateRole;
  }) {
    const ImagePromptTemplate = getImagePromptTemplateModel(mongoose);
    const source = await ImagePromptTemplate.findOne(buildTemplateQuery(templateId)).lean();
    if (!source) {
      throw new Error('提示词模板不存在');
    }

    const copyKey = `${source.key}_copy_${Date.now().toString(36)}`;
    return createImagePromptTemplate({
      key: copyKey,
      name: `${source.name} 副本`,
      description: source.description || '',
      exampleImage: source.exampleImage || null,
      category: source.category,
      templateRole,
      taskType: source.taskType,
      prompt: source.prompt,
      defaultPrompt: '',
      formattedPrompt: source.formattedPrompt || '',
      activePromptSource: source.activePromptSource || 'original',
      formatWarnings: Array.isArray(source.formatWarnings) ? source.formatWarnings : [],
      formattedAt: source.formattedAt,
      formattedBy: source.formattedBy || '',
      platform: source.platform || '',
      imageType: source.imageType || '',
      isSystem: false,
      isEnabled: true,
      sortOrder: Number(source.sortOrder || 0) + 1,
      createdBy,
      updatedBy: createdBy,
    });
  }

  async function restoreImagePromptTemplateDefault({ templateId }: { templateId: string }) {
    const ImagePromptTemplate = getImagePromptTemplateModel(mongoose);
    const existing = await ImagePromptTemplate.findOne(buildTemplateQuery(templateId));
    if (!existing) {
      throw new Error('提示词模板不存在');
    }
    if (!existing.isSystem) {
      throw new Error('只有系统模板可以恢复默认');
    }
    const defaultPrompt = normalizeRequiredText(existing.defaultPrompt, '默认提示词');
    existing.prompt = defaultPrompt;
    existing.formattedPrompt = '';
    existing.activePromptSource = 'original';
    existing.formatWarnings = [];
    existing.formattedAt = undefined;
    existing.formattedBy = '';
    await existing.save();
    return existing.toObject();
  }

  async function deleteImagePromptTemplate({ templateId }: { templateId: string }) {
    const ImagePromptTemplate = getImagePromptTemplateModel(mongoose);
    const existing = await ImagePromptTemplate.findOne(buildTemplateQuery(templateId));
    if (!existing) {
      throw new Error('提示词模板不存在');
    }
    if (existing.isSystem) {
      throw new Error('系统模板不能删除');
    }
    await ImagePromptTemplate.deleteOne({ _id: existing._id });
    return { deleted: true };
  }

  async function seedImagePromptTemplates(templates: SeedImagePromptTemplateInput[]) {
    const ImagePromptTemplate = getImagePromptTemplateModel(mongoose);
    const seeded = [];

    for (const template of templates) {
      const existing = await ImagePromptTemplate.findOne({ key: template.key });
      if (existing) {
        seeded.push(existing.toObject());
        continue;
      }

      const created = await createImagePromptTemplate({
        ...template,
        prompt: template.prompt,
        defaultPrompt: template.defaultPrompt,
        isSystem: true,
        isEnabled: template.isEnabled !== false,
      });
      seeded.push(created.toObject());
    }

    return seeded;
  }

  return {
    createImagePromptTemplate,
    deleteImagePromptTemplate,
    duplicateImagePromptTemplate,
    getImagePromptTemplateById,
    getImagePromptTemplates,
    restoreImagePromptTemplateDefault,
    seedImagePromptTemplates,
    updateImagePromptTemplate,
  };
}

export type ImagePromptTemplateMethods = ReturnType<typeof createImagePromptTemplateMethods>;
