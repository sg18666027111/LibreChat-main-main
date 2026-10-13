import { createImagePromptTemplateMethods } from './imagePromptTemplate';
import imagePromptTemplateSchema from '../schema/imagePromptTemplate';

type TemplateRecord = Record<string, unknown>;
type TemplateDocument = TemplateRecord & {
  save: jest.Mock<Promise<TemplateDocument>, []>;
  toObject: jest.Mock<TemplateRecord, []>;
};

function createTemplateDocument(store: TemplateDocument[], input: TemplateRecord) {
  const doc = {
    _id: input._id || `template_${store.length + 1}`,
    ...input,
    save: jest.fn(async function save(this: TemplateRecord) {
      return this as TemplateDocument;
    }),
    toObject: jest.fn(function toObject(this: TemplateRecord) {
      const { save: _save, toObject: _toObject, ...plain } = this;
      return plain;
    }),
  } as TemplateDocument;
  store.push(doc);
  return doc;
}

function createQueryResult(result: TemplateDocument[]) {
  return {
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn(async () => result.map((item) => item.toObject())),
  };
}

function createMockMongoose() {
  const store: TemplateDocument[] = [];
  const ImagePromptTemplate = {
    create: jest.fn(async (input: TemplateRecord) => createTemplateDocument(store, input)),
    find: jest.fn((query: TemplateRecord) => {
      const result = store.filter((item) =>
        Object.entries(query).every(([key, value]) => item[key] === value),
      );
      return createQueryResult(result);
    }),
    findOne: jest.fn((query: TemplateRecord) => {
      const result = store.find((item) =>
        Object.entries(query).every(([key, value]) => String(item[key]) === String(value)),
      );
      return {
        lean: jest.fn(async () => result?.toObject() || null),
        then: (resolve: (value: TemplateRecord | null) => void) => resolve(result || null),
      };
    }),
    deleteOne: jest.fn(async (query: TemplateRecord) => {
      const index = store.findIndex((item) => String(item._id) === String(query._id));
      if (index >= 0) {
        store.splice(index, 1);
      }
      return { deletedCount: index >= 0 ? 1 : 0 };
    }),
  };

  return {
    mongoose: { models: { ImagePromptTemplate } } as unknown as typeof import('mongoose'),
    store,
  };
}

describe('imagePromptTemplate methods', () => {
  test('persists one optional example, copies it and clears it without changing the prompt', async () => {
    const { mongoose } = createMockMongoose();
    const methods = createImagePromptTemplateMethods(mongoose);
    const created = await methods.createImagePromptTemplate({
      key: 'example',
      name: 'Example',
      category: 'batch_packaging',
      templateRole: 'packaging_style',
      prompt: 'Original prompt',
    });
    expect(imagePromptTemplateSchema.path('exampleImage')).toBeDefined();
    await methods.updateImagePromptTemplate({
      templateId: created.key,
      updates: {
        exampleImage: {
          id: 'file-1',
          source: 'local',
          filepath: '/images/example.png',
          type: 'image/png',
        },
      },
    });
    const copy = await methods.duplicateImagePromptTemplate({
      templateId: created.key,
      templateRole: 'packaging_style',
    });
    expect(copy.exampleImage?.id).toBe('file-1');
    await methods.updateImagePromptTemplate({
      templateId: created.key,
      updates: { exampleImage: null },
    });
    expect(await methods.getImagePromptTemplateById(created.key)).toMatchObject({
      exampleImage: null,
      prompt: 'Original prompt',
    });
    expect(copy.exampleImage?.id).toBe('file-1');
  });

  test('defines explicit template roles without a schema default', () => {
    const templateRole = imagePromptTemplateSchema.path('templateRole') as unknown as {
      options: { enum?: string[]; default?: unknown; index?: unknown };
    };

    expect(templateRole.options.enum).toEqual(['global_business', 'packaging_style']);
    expect(templateRole.options.default).toBeUndefined();
    expect(templateRole.options.index).toBeUndefined();
  });

  test('creates and lists batch packaging prompt templates', async () => {
    const { mongoose } = createMockMongoose();
    const methods = createImagePromptTemplateMethods(mongoose);

    await methods.createImagePromptTemplate({
      key: 'batch_default',
      name: '默认模板',
      category: 'batch_packaging',
      templateRole: 'global_business',
      prompt: '业务提示词',
      defaultPrompt: '业务提示词',
      isSystem: true,
      isEnabled: true,
    });

    const templates = await methods.getImagePromptTemplates({ category: 'batch_packaging' });

    expect(templates).toHaveLength(1);
    expect(templates[0].key).toBe('batch_default');
    expect(templates[0].templateRole).toBe('global_business');
    expect(templates[0].prompt).toBe('业务提示词');
  });

  test('does not hard delete system templates', async () => {
    const { mongoose } = createMockMongoose();
    const methods = createImagePromptTemplateMethods(mongoose);
    const template = await methods.createImagePromptTemplate({
      key: 'system_template',
      name: '系统模板',
      category: 'batch_packaging',
      prompt: '系统提示词',
      defaultPrompt: '系统提示词',
      isSystem: true,
      isEnabled: true,
    });

    await expect(methods.deleteImagePromptTemplate({ templateId: template.key })).rejects.toThrow(
      '系统模板不能删除',
    );
  });

  test('restores system templates to default prompt', async () => {
    const { mongoose } = createMockMongoose();
    const methods = createImagePromptTemplateMethods(mongoose);
    const template = await methods.createImagePromptTemplate({
      key: 'system_template',
      name: '系统模板',
      category: 'batch_packaging',
      prompt: '运营修改',
      defaultPrompt: '默认提示词',
      isSystem: true,
      isEnabled: true,
    });

    const restored = await methods.restoreImagePromptTemplateDefault({
      templateId: template.key,
    });

    expect(restored.prompt).toBe('默认提示词');
  });

  test('stores formatted prompt metadata without replacing original prompt', async () => {
    const { mongoose } = createMockMongoose();
    const methods = createImagePromptTemplateMethods(mongoose);
    await methods.createImagePromptTemplate({
      key: 'custom_template',
      name: '自定义模板',
      category: 'batch_packaging',
      prompt: '运营原始提示词',
      isSystem: false,
      isEnabled: true,
    });

    const updated = await methods.updateImagePromptTemplate({
      templateId: 'custom_template',
      updates: {
        formattedPrompt: '格式整理版提示词',
        activePromptSource: 'formatted',
        formatWarnings: ['检测到具体商品标题，建议确认是否应改为【商品标题】变量。'],
        formattedBy: 'user-1',
      },
    });

    expect(updated.prompt).toBe('运营原始提示词');
    expect(updated.formattedPrompt).toBe('格式整理版提示词');
    expect(updated.activePromptSource).toBe('formatted');
    expect(updated.formatWarnings).toHaveLength(1);
  });
});
