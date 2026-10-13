const loadStore = (mockDbMethods) => {
  jest.resetModules();
  jest.doMock('@librechat/data-schemas', () => ({
    createMethods: jest.fn(() => mockDbMethods),
    logger: {
      error: jest.fn(),
    },
  }));
  return require('./promptTemplateStore');
};

const createPackagingStyleTemplates = (count, { isSystem = false } = {}) =>
  Array.from({ length: count }, (_, index) => ({
    _id: `507f1f77bcf86cd7994390${String(index + 1).padStart(2, '0')}`,
    key: `packaging_style_${index + 1}`,
    name: `Packaging style ${index + 1}`,
    category: 'batch_packaging',
    templateRole: 'packaging_style',
    prompt: `packaging style prompt ${index + 1}`,
    isEnabled: true,
    isSystem,
  }));

const createPackagingStyleDbMethods = (templates) => ({
  getImagePromptTemplates: jest.fn(async () => templates),
  getImagePromptTemplateById: jest.fn(async (templateId) =>
    templates.find(
      (template) => template.key === templateId || String(template._id) === String(templateId),
    ),
  ),
  seedImagePromptTemplates: jest.fn(async () => undefined),
});

describe('promptTemplateStore batch prompt resolution', () => {
  afterEach(() => {
    jest.dontMock('@librechat/data-schemas');
  });

  test('uses formatted prompt from default enabled template when no template id is provided', async () => {
    const defaultTemplate = {
      _id: 'default-template-id',
      key: 'batch_packaging_default',
      name: '默认批量包装主图提示词',
      category: 'batch_packaging',
      prompt: '原始默认提示词',
      formattedPrompt: '格式整理后的默认提示词',
      activePromptSource: 'formatted',
      isSystem: true,
      isEnabled: true,
    };
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => [defaultTemplate]),
      getImagePromptTemplateById: jest.fn(async (templateId) =>
        templateId === 'batch_packaging_default' ? defaultTemplate : null,
      ),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { getPromptTemplateForBatch } = loadStore(mockDbMethods);

    const template = await getPromptTemplateForBatch();

    expect(template.key).toBe('batch_packaging_default');
    expect(template.prompt).toBe('格式整理后的默认提示词');
  });

  test('fails closed when the database has no enabled global business template', async () => {
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => []),
      getImagePromptTemplateById: jest.fn(async () => null),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { getPromptTemplateForBatch } = loadStore(mockDbMethods);

    await expect(getPromptTemplateForBatch()).rejects.toMatchObject({
      message: '全局提示词模板不可用。',
      statusCode: 400,
    });
  });

  test('rejects disabled selected templates', async () => {
    const disabledTemplate = {
      _id: 'disabled-template-id',
      key: 'custom_disabled',
      name: '停用模板',
      category: 'batch_packaging',
      prompt: '停用提示词',
      isEnabled: false,
    };
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => [disabledTemplate]),
      getImagePromptTemplateById: jest.fn(async () => disabledTemplate),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { getPromptTemplateForBatch } = loadStore(mockDbMethods);

    await expect(getPromptTemplateForBatch('disabled-template-id')).rejects.toMatchObject({
      message: '提示词模板不可用。',
      statusCode: 400,
    });
  });

  test.each([
    [{ key: 'batch_packaging_default' }, 'global_business'],
    [{ key: 'white_box_1' }, 'packaging_style'],
    [{ key: 'white_box_2' }, 'packaging_style'],
    [{ key: 'white_box_3' }, 'packaging_style'],
    [{ key: 'kraft_standup_pouch' }, 'packaging_style'],
    [{ key: 'eight_side_standup_pouch' }, 'packaging_style'],
    [{ key: 'three_side_sachet' }, 'packaging_style'],
    [{ key: 'white_jar' }, 'packaging_style'],
    [{ key: 'white_gift_box' }, 'packaging_style'],
    [{ key: 'custom_batch_packaging_legacy', isSystem: false }, 'global_business'],
    [
      {
        key: 'custom_explicit_style',
        isSystem: false,
        templateRole: 'packaging_style',
      },
      'packaging_style',
    ],
  ])('resolves the effective role for %j', (template, expectedRole) => {
    const { getEffectiveTemplateRole } = loadStore({});

    expect(getEffectiveTemplateRole(template)).toBe(expectedRole);
  });

  test('seeds one global and eight packaging styles with explicit roles', async () => {
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => []),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { ensureBatchPackagingPromptTemplatesSeeded } = loadStore(mockDbMethods);

    await ensureBatchPackagingPromptTemplatesSeeded();

    const [seeds] = mockDbMethods.seedImagePromptTemplates.mock.calls[0];
    expect(seeds).toHaveLength(9);
    expect(seeds.filter((template) => template.templateRole === 'global_business')).toHaveLength(1);
    expect(seeds.filter((template) => template.templateRole === 'packaging_style')).toHaveLength(8);
    expect(seeds.find((template) => template.key === 'batch_packaging_default')).toMatchObject({
      templateRole: 'global_business',
      sortOrder: 0,
    });
    expect(seeds.find((template) => template.key === 'white_box_1')).toMatchObject({
      templateRole: 'packaging_style',
      sortOrder: 10,
    });
  });

  test('does not write back roles or overwrite fields on existing system templates', async () => {
    const existing = [
      {
        key: 'batch_packaging_default',
        prompt: 'operator-edited-global',
        isEnabled: false,
        sortOrder: 91,
      },
      ...[
        'white_box_1',
        'white_box_2',
        'white_box_3',
        'kraft_standup_pouch',
        'eight_side_standup_pouch',
        'three_side_sachet',
        'white_jar',
        'white_gift_box',
      ].map((key, index) => ({
        key,
        prompt: `operator-edited-${key}`,
        isEnabled: index !== 0,
        sortOrder: 200 + index,
      })),
    ];
    const snapshot = JSON.parse(JSON.stringify(existing));
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => existing),
      seedImagePromptTemplates: jest.fn(async () => undefined),
      updateImagePromptTemplate: jest.fn(),
    };
    const { ensureBatchPackagingPromptTemplatesSeeded } = loadStore(mockDbMethods);

    await ensureBatchPackagingPromptTemplatesSeeded();

    expect(mockDbMethods.seedImagePromptTemplates).not.toHaveBeenCalled();
    expect(mockDbMethods.updateImagePromptTemplate).not.toHaveBeenCalled();
    expect(existing).toEqual(snapshot);
  });

  test('lists templates by effective role without mixing legacy documents', async () => {
    const templates = [
      {
        _id: 'global-id',
        key: 'batch_packaging_default',
        category: 'batch_packaging',
        prompt: 'global',
        isEnabled: true,
      },
      {
        _id: 'style-id',
        key: 'white_box_1',
        category: 'batch_packaging',
        prompt: 'style',
        isEnabled: true,
      },
      {
        _id: 'legacy-custom-id',
        key: 'custom_batch_packaging_legacy',
        category: 'batch_packaging',
        prompt: 'legacy global',
        isEnabled: true,
      },
    ];
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => templates),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { listPromptTemplates } = loadStore(mockDbMethods);

    const globalTemplates = await listPromptTemplates({ templateRole: 'global_business' });
    const packagingTemplates = await listPromptTemplates({ templateRole: 'packaging_style' });

    expect(globalTemplates.map((template) => template.key)).toEqual([
      'batch_packaging_default',
      'custom_batch_packaging_legacy',
    ]);
    expect(packagingTemplates.map((template) => template.key)).toEqual(['white_box_1']);
  });

  test.each(['global_business', 'packaging_style'])(
    'creates an explicit %s template and returns its role',
    async (templateRole) => {
      const mockDbMethods = {
        getImagePromptTemplates: jest.fn(async () => [
          { key: 'batch_packaging_default' },
          { key: 'white_box_1' },
          { key: 'white_box_2' },
          { key: 'white_box_3' },
          { key: 'kraft_standup_pouch' },
          { key: 'eight_side_standup_pouch' },
          { key: 'three_side_sachet' },
          { key: 'white_jar' },
          { key: 'white_gift_box' },
        ]),
        seedImagePromptTemplates: jest.fn(async () => undefined),
        createImagePromptTemplate: jest.fn(async (input) => ({ _id: 'new-id', ...input })),
      };
      const { createPromptTemplate } = loadStore(mockDbMethods);

      const created = await createPromptTemplate(
        { name: 'Explicit role', prompt: 'role prompt', templateRole },
        'operator-1',
      );

      expect(created.templateRole).toBe(templateRole);
      expect(mockDbMethods.createImagePromptTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ templateRole }),
      );
    },
  );

  test('rejects create without an explicit role', async () => {
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => []),
      seedImagePromptTemplates: jest.fn(async () => undefined),
      createImagePromptTemplate: jest.fn(),
    };
    const { createPromptTemplate } = loadStore(mockDbMethods);

    await expect(
      createPromptTemplate({ name: 'Missing role', prompt: 'prompt' }, 'operator-1'),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockDbMethods.createImagePromptTemplate).not.toHaveBeenCalled();
  });

  test('rejects attempts to mutate templateRole', async () => {
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => []),
      seedImagePromptTemplates: jest.fn(async () => undefined),
      updateImagePromptTemplate: jest.fn(),
    };
    const { updatePromptTemplate } = loadStore(mockDbMethods);

    await expect(
      updatePromptTemplate('template-id', { templateRole: 'global_business' }, 'operator-1'),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockDbMethods.updateImagePromptTemplate).not.toHaveBeenCalled();
  });

  test('duplicates a legacy template with its effective role persisted explicitly', async () => {
    const legacyTemplate = {
      _id: 'legacy-template-id',
      key: 'custom_batch_packaging_legacy',
      category: 'batch_packaging',
      prompt: 'legacy prompt',
      isEnabled: true,
      isSystem: false,
    };
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => []),
      getImagePromptTemplateById: jest.fn(async () => legacyTemplate),
      seedImagePromptTemplates: jest.fn(async () => undefined),
      duplicateImagePromptTemplate: jest.fn(async ({ templateRole }) => ({
        ...legacyTemplate,
        _id: 'legacy-copy-id',
        key: 'custom_batch_packaging_legacy_copy',
        templateRole,
      })),
    };
    const { duplicatePromptTemplate } = loadStore(mockDbMethods);

    const duplicate = await duplicatePromptTemplate('legacy-template-id', 'operator-1');

    expect(mockDbMethods.duplicateImagePromptTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateRole: 'global_business' }),
    );
    expect(duplicate.templateRole).toBe('global_business');
  });

  test('rejects a packaging style used as the global business prompt', async () => {
    const packagingTemplate = {
      _id: 'style-id',
      key: 'white_box_1',
      category: 'batch_packaging',
      prompt: 'style prompt',
      isEnabled: true,
    };
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => [packagingTemplate]),
      getImagePromptTemplateById: jest.fn(async () => packagingTemplate),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { getPromptTemplateForBatch } = loadStore(mockDbMethods);

    await expect(getPromptTemplateForBatch('white_box_1')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('resolves packaging styles by key or Mongo id and canonicalizes to key in request order', async () => {
    const templates = [
      {
        _id: '507f1f77bcf86cd799439011',
        key: 'custom_test_style',
        name: 'Custom style',
        category: 'batch_packaging',
        templateRole: 'packaging_style',
        prompt: 'original style prompt',
        formattedPrompt: 'formatted style prompt',
        activePromptSource: 'formatted',
        isEnabled: true,
        isSystem: false,
      },
      {
        _id: '507f1f77bcf86cd799439012',
        key: 'white_box_1',
        name: 'DB system style',
        category: 'batch_packaging',
        prompt: 'DB MODIFIED SYSTEM PROMPT',
        isEnabled: true,
        isSystem: true,
      },
    ];
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => templates),
      getImagePromptTemplateById: jest.fn(async (templateId) =>
        templates.find(
          (template) => template.key === templateId || String(template._id) === String(templateId),
        ),
      ),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    const resolved = await resolvePackagingStyleTemplates([
      '507f1f77bcf86cd799439011',
      'white_box_1',
    ]);

    expect(resolved.map((template) => template.key)).toEqual(['custom_test_style', 'white_box_1']);
    expect(resolved[0].prompt).toBe('formatted style prompt');
    expect(resolved[1].prompt).toBe('DB MODIFIED SYSTEM PROMPT');
  });

  test('resolves key and Mongo id aliases for the same packaging template only once', async () => {
    const template = {
      _id: '507f1f77bcf86cd799439011',
      key: 'custom_test_style',
      name: 'Custom style',
      category: 'batch_packaging',
      templateRole: 'packaging_style',
      prompt: 'custom style prompt',
      isEnabled: true,
      isSystem: false,
    };
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => [template]),
      getImagePromptTemplateById: jest.fn(async (templateId) =>
        template.key === templateId || String(template._id) === String(templateId)
          ? template
          : null,
      ),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    const resolved = await resolvePackagingStyleTemplates([
      'custom_test_style',
      '507f1f77bcf86cd799439011',
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved.map((packagingTemplate) => packagingTemplate.key)).toEqual([
      'custom_test_style',
    ]);
  });

  test('resolves Mongo id and key aliases for the same packaging template only once', async () => {
    const template = {
      _id: '507f1f77bcf86cd799439011',
      key: 'custom_test_style',
      name: 'Custom style',
      category: 'batch_packaging',
      templateRole: 'packaging_style',
      prompt: 'custom style prompt',
      isEnabled: true,
      isSystem: false,
    };
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => [template]),
      getImagePromptTemplateById: jest.fn(async (templateId) =>
        template.key === templateId || String(template._id) === String(templateId)
          ? template
          : null,
      ),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    const resolved = await resolvePackagingStyleTemplates([
      '507f1f77bcf86cd799439011',
      'custom_test_style',
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved.map((packagingTemplate) => packagingTemplate.key)).toEqual([
      'custom_test_style',
    ]);
  });

  test('deduplicates repeated raw packaging template ids', async () => {
    const template = {
      _id: '507f1f77bcf86cd799439011',
      key: 'custom_test_style',
      category: 'batch_packaging',
      templateRole: 'packaging_style',
      prompt: 'custom style prompt',
      isEnabled: true,
    };
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => [template]),
      getImagePromptTemplateById: jest.fn(async () => template),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    const resolved = await resolvePackagingStyleTemplates([
      'custom_test_style',
      'custom_test_style',
    ]);

    expect(resolved.map((packagingTemplate) => packagingTemplate.key)).toEqual([
      'custom_test_style',
    ]);
  });

  test('accepts eight distinct canonical packaging styles', async () => {
    const templates = createPackagingStyleTemplates(8);
    const mockDbMethods = createPackagingStyleDbMethods(templates);
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    const resolved = await resolvePackagingStyleTemplates(
      templates.map((template) => template.key),
    );

    expect(resolved.map((template) => template.key)).toEqual(
      templates.map((template) => template.key),
    );
  });

  test('rejects nine distinct canonical packaging styles', async () => {
    const templates = createPackagingStyleTemplates(9);
    const mockDbMethods = createPackagingStyleDbMethods(templates);
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    await expect(
      resolvePackagingStyleTemplates(templates.map((template) => template.key)),
    ).rejects.toMatchObject({
      message: '每批最多选择 8 个包装样式。',
      statusCode: 400,
    });
  });

  test('accepts eight canonical packaging styles represented by key and Mongo id aliases', async () => {
    const templates = createPackagingStyleTemplates(8);
    const mockDbMethods = createPackagingStyleDbMethods(templates);
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);
    const aliases = templates.flatMap((template) => [template.key, template._id]);

    const resolved = await resolvePackagingStyleTemplates(aliases);

    expect(resolved.map((template) => template.key)).toEqual(
      templates.map((template) => template.key),
    );
  });

  test('fails closed when eight valid packaging styles are followed by an invalid identifier', async () => {
    const templates = createPackagingStyleTemplates(8);
    const mockDbMethods = createPackagingStyleDbMethods(templates);
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    await expect(
      resolvePackagingStyleTemplates([
        ...templates.map((template) => template.key),
        'invalid-packaging-style',
      ]),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects seventeen distinct normalized identifiers before any DB lookup', async () => {
    const mockDbMethods = createPackagingStyleDbMethods([]);
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    await expect(
      resolvePackagingStyleTemplates(
        Array.from({ length: 17 }, (_, index) => `raw-packaging-id-${index + 1}`),
      ),
    ).rejects.toMatchObject({
      message: '请求中的包装模板标识过多。',
      statusCode: 400,
    });
    expect(mockDbMethods.seedImagePromptTemplates).not.toHaveBeenCalled();
    expect(mockDbMethods.getImagePromptTemplateById).not.toHaveBeenCalled();
  });

  test('deduplicates seventeen identical raw identifiers before applying the sanity limit', async () => {
    const templates = createPackagingStyleTemplates(1);
    const mockDbMethods = createPackagingStyleDbMethods(templates);
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    const resolved = await resolvePackagingStyleTemplates(Array(17).fill(templates[0].key));

    expect(resolved.map((template) => template.key)).toEqual([templates[0].key]);
    expect(mockDbMethods.getImagePromptTemplateById).toHaveBeenCalledTimes(1);
  });

  test('fails closed when duplicate aliases are followed by an invalid template id', async () => {
    const template = {
      _id: '507f1f77bcf86cd799439011',
      key: 'custom_test_style',
      category: 'batch_packaging',
      templateRole: 'packaging_style',
      prompt: 'custom style prompt',
      isEnabled: true,
    };
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => [template]),
      getImagePromptTemplateById: jest.fn(async (templateId) =>
        template.key === templateId || String(template._id) === String(templateId)
          ? template
          : null,
      ),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    await expect(
      resolvePackagingStyleTemplates([
        'custom_test_style',
        '507f1f77bcf86cd799439011',
        'invalid-id',
      ]),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('defaults a missing selection to enabled system packaging styles only', async () => {
    const templates = [
      {
        _id: 'system-id',
        key: 'white_box_1',
        category: 'batch_packaging',
        prompt: 'system',
        isSystem: true,
        isEnabled: true,
      },
      {
        _id: 'custom-id',
        key: 'custom_style',
        category: 'batch_packaging',
        templateRole: 'packaging_style',
        prompt: 'custom',
        isSystem: false,
        isEnabled: true,
      },
      {
        _id: 'disabled-system-id',
        key: 'white_box_2',
        category: 'batch_packaging',
        prompt: 'disabled',
        isSystem: true,
        isEnabled: false,
      },
    ];
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => templates),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    const resolved = await resolvePackagingStyleTemplates(undefined);

    expect(resolved.map((template) => template.key)).toEqual(['white_box_1']);
  });

  test('rejects nine enabled system packaging styles for a missing selection', async () => {
    const templates = createPackagingStyleTemplates(9, { isSystem: true });
    const mockDbMethods = createPackagingStyleDbMethods(templates);
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    await expect(resolvePackagingStyleTemplates(undefined)).rejects.toMatchObject({
      message: '每批最多选择 8 个包装样式。',
      statusCode: 400,
    });
  });

  test('accepts eight enabled system packaging styles for a missing selection', async () => {
    const templates = createPackagingStyleTemplates(8, { isSystem: true });
    const mockDbMethods = createPackagingStyleDbMethods(templates);
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    const resolved = await resolvePackagingStyleTemplates(undefined);

    expect(resolved.map((template) => template.key)).toEqual(
      templates.map((template) => template.key),
    );
  });

  test('rejects an explicit empty packaging selection', async () => {
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => []),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    await expect(resolvePackagingStyleTemplates([])).rejects.toMatchObject({ statusCode: 400 });
  });

  test.each([
    ['unknown', null],
    [
      'disabled',
      {
        _id: 'disabled-id',
        key: 'disabled',
        category: 'batch_packaging',
        templateRole: 'packaging_style',
        prompt: 'disabled',
        isEnabled: false,
      },
    ],
    [
      'wrong-role',
      {
        _id: 'wrong-role-id',
        key: 'wrong-role',
        category: 'batch_packaging',
        templateRole: 'global_business',
        prompt: 'global',
        isEnabled: true,
      },
    ],
  ])('fails closed for a %s packaging template', async (templateId, template) => {
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => []),
      getImagePromptTemplateById: jest.fn(async () => template),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    await expect(resolvePackagingStyleTemplates([templateId])).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('fails the whole mixed selection instead of dropping an invalid id', async () => {
    const validTemplate = {
      _id: 'valid-id',
      key: 'white_box_1',
      category: 'batch_packaging',
      prompt: 'valid',
      isEnabled: true,
    };
    const mockDbMethods = {
      getImagePromptTemplates: jest.fn(async () => [validTemplate]),
      getImagePromptTemplateById: jest.fn(async (templateId) =>
        templateId === 'white_box_1' ? validTemplate : null,
      ),
      seedImagePromptTemplates: jest.fn(async () => undefined),
    };
    const { resolvePackagingStyleTemplates } = loadStore(mockDbMethods);

    await expect(
      resolvePackagingStyleTemplates(['white_box_1', 'unknown', 'white_box_1']),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('prompt template example metadata', () => {
  afterEach(() => jest.dontMock('@librechat/data-schemas'));
  test('lists the shared example URL and preserves legacy templates and active prompts', async () => {
    const templates = createPackagingStyleTemplates(2);
    templates[0].exampleImage = {
      id: 'image-1',
      source: 'local',
      filepath: '/images/example.png',
      type: 'image/png',
    };
    const store = loadStore(createPackagingStyleDbMethods(templates));
    const listed = await store.listPromptTemplates({ includeDisabled: false });
    expect(listed[0].exampleImageUrl).toBe(
      '/api/image-generation/prompt-templates/507f1f77bcf86cd799439001/example-image?v=image-1',
    );
    expect(listed[1].exampleImageUrl).toBe('');
    expect(listed[0].prompt).toBe('packaging style prompt 1');
  });
});
