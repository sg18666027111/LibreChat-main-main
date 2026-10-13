import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import ImageGeneration from './ImageGeneration';

const mockShowToast = jest.fn();
let mockCanManage = true;

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    jest.requireActual('~/locales/en/translation.json')[key] ?? key,
  useAuthContext: () => ({
    user: {
      role: 'USER',
      permissions: { imagePromptTemplates: { manage: mockCanManage } },
    },
  }),
}));

jest.mock('librechat-data-provider', () => ({
  request: {
    delete: jest.fn(),
    get: jest.fn(),
    getResponse: jest.fn(),
    patch: jest.fn(),
    post: jest.fn(),
    postMultiPart: jest.fn(),
  },
  SystemRoles: {
    ADMIN: 'ADMIN',
  },
}));

const mockRequest = request as jest.Mocked<typeof request>;
const promptTemplatesUrl = '/api/image-generation/prompt-templates?category=batch_packaging';
const promptTemplateResponse = (templates: PromptTemplateFixture[], limit = 8) => ({
  templates,
  limits: { maxPackagingStylesPerBatch: limit },
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const existingTemplate = {
  id: 'existing-a',
  key: 'existing_a',
  name: 'Existing A',
  description: 'existing description',
  category: 'batch_packaging' as const,
  templateRole: 'global_business' as const,
  taskType: 'batch_packaging',
  prompt: 'Existing A prompt',
  defaultPrompt: 'Existing A prompt',
  formattedPrompt: '',
  activePromptSource: 'original' as const,
  formatWarnings: [],
  platform: '通用',
  imageType: '商品主图',
  isSystem: false,
  isEnabled: true,
  sortOrder: 1,
};

const createdTemplate = {
  ...existingTemplate,
  id: 'operator-created-template',
  key: 'custom_batch_packaging_operator',
  name: '运营新增测试模板',
  description: '',
  prompt: '运营新增模板测试提示词',
  defaultPrompt: '',
  templateRole: 'packaging_style' as const,
  sortOrder: 100,
};

const systemPackagingTemplateKeys = [
  'white_box_1',
  'white_box_2',
  'white_box_3',
  'kraft_standup_pouch',
  'eight_side_standup_pouch',
  'three_side_sachet',
  'white_jar',
  'white_gift_box',
] as const;

const systemPackagingTemplates = systemPackagingTemplateKeys.map((key, index) => ({
  ...existingTemplate,
  id: `mongo-${key}`,
  key,
  name: `System packaging ${index + 1}`,
  description: 'system packaging style',
  templateRole: 'packaging_style' as const,
  prompt: `DB system packaging prompt ${index + 1}`,
  defaultPrompt: `DB system packaging prompt ${index + 1}`,
  isSystem: true,
  sortOrder: index + 10,
}));

const ninthSystemPackagingTemplate = {
  ...systemPackagingTemplates[0],
  id: 'mongo-system-packaging-9',
  key: 'system_packaging_9',
  name: 'System packaging 9',
  sortOrder: 18,
};

const secondCustomPackagingTemplate = {
  ...createdTemplate,
  id: 'operator-created-template-2',
  key: 'custom_batch_packaging_operator_2',
  name: '运营新增测试模板 2',
  sortOrder: 101,
};

const thirdCustomPackagingTemplate = {
  ...createdTemplate,
  id: 'operator-created-template-3',
  key: 'custom_batch_packaging_operator_3',
  name: '运营新增测试模板 3',
  sortOrder: 102,
};

const disabledPackagingTemplate = {
  ...createdTemplate,
  id: 'disabled-style-id',
  key: 'disabled_style',
  name: 'Disabled packaging style',
  isEnabled: false,
};

type PromptTemplateFixture = Omit<typeof existingTemplate, 'templateRole'> & {
  templateRole: 'global_business' | 'packaging_style';
  exampleImageUrl?: string;
};

const imageGenerationConfig = {
  platforms: ['通用'],
  imageTypes: ['通用营销图'],
  aspectRatios: ['1:1', '4:5'],
  counts: [1, 2, 4],
  models: [
    { label: '快速生图', value: 'Qwen/Qwen-Image' },
    {
      label: 'GPT Image 2.5 Flare',
      value: 'apimart_gpt_image_2_5_flare',
      modelKey: 'apimart_gpt_image_2_5_flare',
      model: 'gpt-image-2.5-flare',
      provider: 'apimart',
      capabilities: ['text-to-image'],
    },
  ],
  editModels: [],
  defaultAspectRatios: { 通用营销图: '4:5' },
  platformTypeAspectRatios: {},
  outputQualities: [],
  defaultOutputQuality: 'standard',
};

describe('ImageGeneration prompt template manager', () => {
  let templates: PromptTemplateFixture[] = [existingTemplate, ...systemPackagingTemplates];

  async function openPromptTemplateManager() {
    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    fireEvent.click(await screen.findByRole('button', { name: '管理模板' }));
  }

  async function createNewPromptTemplate() {
    fireEvent.click(await screen.findByRole('button', { name: '新增模板' }));

    expect(screen.getByLabelText('模板名称')).toHaveValue('');
    expect(screen.getByLabelText(/原始提示词/)).toHaveValue('');

    fireEvent.change(screen.getByLabelText('模板名称'), {
      target: { value: '运营新增测试模板' },
    });
    fireEvent.change(screen.getByLabelText(/原始提示词/), {
      target: { value: '运营新增模板测试提示词' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mockRequest.post).toHaveBeenCalledTimes(1));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanManage = true;
    URL.createObjectURL = jest.fn(() => 'blob:example');
    URL.revokeObjectURL = jest.fn();
    mockRequest.getResponse.mockResolvedValue({
      data: new Blob(['image'], { type: 'image/png' }),
    } as never);
    localStorage.clear();
    templates = [existingTemplate, ...systemPackagingTemplates];

    mockRequest.get.mockImplementation(async (url) => {
      if (url === '/api/image-generation/config') {
        return imageGenerationConfig;
      }
      if (url === promptTemplatesUrl) {
        return promptTemplateResponse(templates);
      }
      throw new Error(`Unexpected GET ${String(url)}`);
    });

    mockRequest.post.mockImplementation(async (url, payload) => {
      if (url !== '/api/image-generation/prompt-templates') {
        throw new Error(`Unexpected POST ${String(url)}`);
      }
      templates = [existingTemplate, ...systemPackagingTemplates, createdTemplate];
      return { template: { ...createdTemplate, ...(payload as object) } };
    });

    mockRequest.patch.mockImplementation(async (url, payload) => {
      const template = String(url).endsWith('/operator-created-template')
        ? createdTemplate
        : existingTemplate;
      return { template: { ...template, ...(payload as object) } };
    });
    mockRequest.postMultiPart.mockResolvedValue({});
  });

  test('ordinary operators see the same global and style examples in both batch modes', async () => {
    mockCanManage = false;
    templates = [
      { ...existingTemplate, exampleImageUrl: '/global-example' },
      { ...systemPackagingTemplates[0], exampleImageUrl: '/style-example' },
    ];
    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    expect(screen.queryByAltText('Existing A 图例')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    expect(await screen.findByAltText('Existing A 图例')).toHaveAttribute('src', 'blob:example');
    expect(await screen.findByAltText('System packaging 1 图例')).toHaveAttribute(
      'src',
      'blob:example',
    );
    expect(screen.queryByRole('button', { name: '管理模板' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '图生图' }));
    expect(screen.getByAltText('Existing A 图例')).toHaveAttribute('src', 'blob:example');
    expect(screen.getByAltText('System packaging 1 图例')).toHaveAttribute('src', 'blob:example');
  });

  test('loads the selected global example immediately but defers style thumbnails off screen', async () => {
    let notifyIntersection!: IntersectionObserverCallback;
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      writable: true,
      value: jest.fn((callback: IntersectionObserverCallback) => {
        notifyIntersection = callback;
        return {
          observe: jest.fn(),
          disconnect: jest.fn(),
          unobserve: jest.fn(),
        };
      }),
    });
    templates = [
      { ...existingTemplate, exampleImageUrl: '/global-example' },
      { ...systemPackagingTemplates[0], exampleImageUrl: '/style-example' },
    ];

    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));

    expect(await screen.findByAltText('Existing A 图例')).toBeInTheDocument();
    expect(mockRequest.getResponse).toHaveBeenCalledWith('/global-example', {
      responseType: 'blob',
    });
    expect(mockRequest.getResponse).not.toHaveBeenCalledWith('/style-example', {
      responseType: 'blob',
    });

    act(() => {
      notifyIntersection(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(await screen.findByAltText('System packaging 1 图例')).toBeInTheDocument();

    Reflect.deleteProperty(window, 'IntersectionObserver');
  });

  test('editor uploads, replaces and deletes an example without saving prompt edits', async () => {
    mockRequest.postMultiPart.mockImplementation(async () => {
      templates = [{ ...existingTemplate, exampleImageUrl: '/saved-example' }];
      return { template: templates[0] };
    });
    mockRequest.delete.mockImplementation(async () => {
      templates = [{ ...existingTemplate, exampleImageUrl: '' }];
      return { template: templates[0] };
    });
    await openPromptTemplateManager();
    fireEvent.change(screen.getByLabelText(/原始提示词/), { target: { value: 'Unsaved prompt' } });
    const file = new File(['image'], 'example.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('上传图例'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('替换图例')).toBeEnabled());
    expect(mockRequest.postMultiPart).toHaveBeenCalledWith(
      '/api/image-generation/prompt-templates/existing-a/example-image',
      expect.any(FormData),
    );
    expect(screen.getByLabelText(/原始提示词/)).toHaveValue('Unsaved prompt');
    fireEvent.change(screen.getByLabelText('替换图例'), { target: { files: [file] } });
    await waitFor(() => expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '删除图例' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '删除图例' }));
    await waitFor(() => expect(screen.getByLabelText('上传图例')).toBeEnabled());
    expect(mockRequest.patch).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/原始提示词/)).toHaveValue('Unsaved prompt');
  });

  test('new template requires a save before an example can be uploaded', async () => {
    await openPromptTemplateManager();
    fireEvent.click(screen.getByRole('button', { name: '新增模板' }));
    expect(screen.getByLabelText('上传图例')).toBeDisabled();
    expect(screen.getByText('请先保存模板，再上传图例。')).toBeInTheDocument();
  });

  test('authorized operator creates a new prompt template without patching Existing A', async () => {
    await openPromptTemplateManager();
    await createNewPromptTemplate();

    expect(mockRequest.post).toHaveBeenCalledWith(
      '/api/image-generation/prompt-templates',
      expect.objectContaining({
        name: '运营新增测试模板',
        prompt: '运营新增模板测试提示词',
        templateRole: 'packaging_style',
      }),
    );
    expect(mockRequest.patch).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByLabelText('模板名称')).toHaveValue('运营新增测试模板');
      expect(screen.getByLabelText('全局提示词模板')).toHaveValue(existingTemplate.key);
    });
    const createdCheckbox = screen.getByRole('checkbox', { name: '运营新增测试模板' });
    expect(createdCheckbox).not.toBeChecked();
  });

  test('keeps the server-created template authoritative when reload returns a stale list', async () => {
    mockRequest.get.mockImplementation(async (url) => {
      if (url === '/api/image-generation/config') {
        return imageGenerationConfig;
      }
      if (url === promptTemplatesUrl) {
        return promptTemplateResponse([existingTemplate, ...systemPackagingTemplates]);
      }
      throw new Error(`Unexpected GET ${String(url)}`);
    });

    await openPromptTemplateManager();
    await createNewPromptTemplate();

    await waitFor(() => {
      expect(screen.getByLabelText('模板名称')).toHaveValue('运营新增测试模板');
      expect(screen.getByLabelText(/原始提示词/)).toHaveValue('运营新增模板测试提示词');
      expect(screen.getByRole('checkbox', { name: '运营新增测试模板' })).not.toBeChecked();
    });
    expect(mockRequest.patch).not.toHaveBeenCalledWith(
      '/api/image-generation/prompt-templates/existing-a',
      expect.anything(),
    );
  });

  test('keeps create success and the created draft when reload fails', async () => {
    let promptTemplateGetCount = 0;
    mockRequest.get.mockImplementation(async (url) => {
      if (url === '/api/image-generation/config') {
        return imageGenerationConfig;
      }
      if (url === promptTemplatesUrl) {
        promptTemplateGetCount += 1;
        if (promptTemplateGetCount === 1) {
          return promptTemplateResponse([existingTemplate]);
        }
        throw new Error('template reload network failure');
      }
      throw new Error(`Unexpected GET ${String(url)}`);
    });

    await openPromptTemplateManager();
    await createNewPromptTemplate();

    await waitFor(() => {
      expect(screen.getByLabelText('模板名称')).toHaveValue('运营新增测试模板');
      expect(screen.getByRole('checkbox', { name: '运营新增测试模板' })).not.toBeChecked();
    });
    expect(mockRequest.post).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'warning',
        message: expect.stringContaining('已保存'),
      }),
    );
    expect(mockShowToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', message: expect.stringContaining('保存失败') }),
    );
  });

  test('ignores an older prompt-template GET that resolves after a newer GET', async () => {
    const staleRequest = createDeferred<ReturnType<typeof promptTemplateResponse>>();
    let promptTemplateGetCount = 0;
    mockRequest.get.mockImplementation(async (url) => {
      if (url === '/api/image-generation/config') {
        return imageGenerationConfig;
      }
      if (url === promptTemplatesUrl) {
        promptTemplateGetCount += 1;
        if (promptTemplateGetCount === 1) {
          return staleRequest.promise;
        }
        return promptTemplateResponse([
          existingTemplate,
          ...systemPackagingTemplates,
          createdTemplate,
        ]);
      }
      throw new Error(`Unexpected GET ${String(url)}`);
    });

    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    await waitFor(() => expect(promptTemplateGetCount).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: '单次生成' }));
    await waitFor(() => {
      expect(screen.queryByText('批量包装主图生成')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    await waitFor(() => expect(promptTemplateGetCount).toBe(2));
    expect(await screen.findByRole('checkbox', { name: '运营新增测试模板' })).toBeInTheDocument();

    await act(async () => {
      staleRequest.resolve(promptTemplateResponse([existingTemplate, ...systemPackagingTemplates]));
      await staleRequest.promise;
    });

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '运营新增测试模板' })).toBeInTheDocument();
    });
  });

  test('second save after a stale reload patches the newly created ID', async () => {
    mockRequest.get.mockImplementation(async (url) => {
      if (url === '/api/image-generation/config') {
        return imageGenerationConfig;
      }
      if (url === promptTemplatesUrl) {
        return promptTemplateResponse([existingTemplate, ...systemPackagingTemplates]);
      }
      throw new Error(`Unexpected GET ${String(url)}`);
    });

    await openPromptTemplateManager();
    await createNewPromptTemplate();
    await waitFor(() => {
      expect(mockRequest.get.mock.calls.filter(([url]) => url === promptTemplatesUrl)).toHaveLength(
        2,
      );
    });

    fireEvent.change(screen.getByLabelText(/原始提示词/), {
      target: { value: '运营新增模板二次编辑提示词' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockRequest.patch).toHaveBeenCalledTimes(1));
    expect(mockRequest.patch).toHaveBeenCalledWith(
      '/api/image-generation/prompt-templates/operator-created-template',
      expect.objectContaining({ prompt: '运营新增模板二次编辑提示词' }),
    );
    expect(mockRequest.patch).not.toHaveBeenCalledWith(
      '/api/image-generation/prompt-templates/existing-a',
      expect.anything(),
    );
    expect(mockRequest.post).toHaveBeenCalledTimes(1);
  });

  test('editing Existing A still patches Existing A without posting a duplicate', async () => {
    await openPromptTemplateManager();
    await waitFor(() => {
      expect(screen.getByLabelText('模板名称')).toHaveValue('Existing A');
    });

    fireEvent.change(screen.getByLabelText(/原始提示词/), {
      target: { value: 'Existing A updated prompt' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockRequest.patch).toHaveBeenCalledTimes(1));
    expect(mockRequest.patch).toHaveBeenCalledWith(
      '/api/image-generation/prompt-templates/existing-a',
      expect.objectContaining({ prompt: 'Existing A updated prompt' }),
    );
    expect(mockRequest.post).not.toHaveBeenCalled();
  });

  test('renders the server limit, keeps eight system defaults, and does not auto-select custom', async () => {
    templates = [
      existingTemplate,
      ...systemPackagingTemplates,
      createdTemplate,
      disabledPackagingTemplate,
    ];

    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));

    const limitButton = await screen.findByRole('button', { name: '已达上限 8/8' });
    expect(limitButton).toBeDisabled();
    expect(screen.getByText('每批最多选择 8 个包装样式。已选 8/8（共 9 个可用）。')).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: 'Existing A' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Disabled packaging style' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Existing A' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'System packaging 1' })).not.toBeInTheDocument();

    for (const template of systemPackagingTemplates) {
      expect(screen.getByRole('checkbox', { name: template.name })).toBeChecked();
    }
    expect(screen.getByRole('checkbox', { name: createdTemplate.name })).not.toBeChecked();
  });

  test('blocks an N+1 checkbox selection at the limit but still allows deselection', async () => {
    templates = [existingTemplate, ...systemPackagingTemplates, createdTemplate];

    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    const customCheckbox = await screen.findByRole('checkbox', { name: createdTemplate.name });
    fireEvent.click(customCheckbox);

    expect(customCheckbox).not.toBeChecked();
    expect(screen.getByText('每批最多选择 8 个，请先取消一个已选模板。')).toBeVisible();

    const selectedSystemCheckbox = screen.getByRole('checkbox', {
      name: systemPackagingTemplates[0].name,
    });
    fireEvent.click(selectedSystemCheckbox);
    expect(selectedSystemCheckbox).not.toBeChecked();
    expect(screen.getByRole('button', { name: '补满至 8 个' })).toBeEnabled();
  });

  test('select-all chooses every available template when the total is within the server limit', async () => {
    const sevenSystemTemplates = systemPackagingTemplates.slice(0, 7);
    templates = [existingTemplate, ...sevenSystemTemplates, createdTemplate];

    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    fireEvent.click(await screen.findByRole('button', { name: '全选 8 个' }));
    fireEvent.change(screen.getByLabelText('商品标题'), { target: { value: '测试商品' } });
    fireEvent.click(screen.getByRole('button', { name: '开始批量生成' }));

    await waitFor(() => expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1));
    const [, formData] = mockRequest.postMultiPart.mock.calls[0] as [string, FormData];
    expect(JSON.parse(String(formData.get('templateIds')))).toEqual([
      ...sevenSystemTemplates.map((template) => template.key),
      createdTemplate.key,
    ]);
    expect(formData.get('promptTemplateId')).toBe(existingTemplate.key);
  });

  test('fills to the server limit in server order without deselecting existing templates', async () => {
    const sixSystemTemplates = systemPackagingTemplates.slice(0, 6);
    templates = [
      existingTemplate,
      ...sixSystemTemplates,
      createdTemplate,
      secondCustomPackagingTemplate,
      thirdCustomPackagingTemplate,
    ];

    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    fireEvent.click(await screen.findByRole('button', { name: '补满至 8 个' }));

    for (const template of sixSystemTemplates) {
      expect(screen.getByRole('checkbox', { name: template.name })).toBeChecked();
    }
    expect(screen.getByRole('checkbox', { name: createdTemplate.name })).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: secondCustomPackagingTemplate.name }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: thirdCustomPackagingTemplate.name }),
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: '已达上限 8/8' })).toBeDisabled();
  });

  test('does not auto-select any system template when system defaults exceed the server limit', async () => {
    templates = [
      existingTemplate,
      ...systemPackagingTemplates,
      ninthSystemPackagingTemplate,
      createdTemplate,
    ];

    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));

    expect(
      await screen.findByText('系统包装样式超过每批上限，未自动选择，请手动选择。'),
    ).toBeVisible();
    for (const template of [...systemPackagingTemplates, ninthSystemPackagingTemplate]) {
      expect(screen.getByRole('checkbox', { name: template.name })).not.toBeChecked();
    }
    expect(screen.getByRole('checkbox', { name: createdTemplate.name })).not.toBeChecked();
  });

  test('preserves an over-limit state, blocks generation, and allows recovery by deselection', async () => {
    const nineSystemTemplates = [...systemPackagingTemplates, ninthSystemPackagingTemplate];
    let promptTemplateGetCount = 0;
    mockRequest.get.mockImplementation(async (url) => {
      if (url === '/api/image-generation/config') {
        return imageGenerationConfig;
      }
      if (url === promptTemplatesUrl) {
        promptTemplateGetCount += 1;
        return promptTemplateResponse(
          [existingTemplate, ...nineSystemTemplates],
          promptTemplateGetCount === 1 ? 9 : 8,
        );
      }
      throw new Error(`Unexpected GET ${String(url)}`);
    });

    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    expect(await screen.findByRole('button', { name: '已达上限 9/9' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '单次生成' }));
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    expect(await screen.findByRole('button', { name: '已超上限 9/8' })).toBeDisabled();
    expect(screen.getByText('每批最多选择 8 个包装样式。已选 9/8（共 9 个可用）。')).toBeVisible();

    fireEvent.change(screen.getByLabelText('商品标题'), { target: { value: '测试商品' } });
    fireEvent.click(screen.getByRole('button', { name: '开始批量生成' }));
    expect(mockRequest.postMultiPart).not.toHaveBeenCalled();
    expect(
      screen.getByText('每批最多选择 8 个包装样式。当前已选 9 个，请先取消超出项。'),
    ).toBeVisible();

    const selectedCheckbox = screen.getByRole('checkbox', {
      name: ninthSystemPackagingTemplate.name,
    });
    fireEvent.click(selectedCheckbox);
    expect(selectedCheckbox).not.toBeChecked();
    expect(screen.getByRole('button', { name: '已达上限 8/8' })).toBeDisabled();
  });

  test.each([
    ['missing', undefined],
    ['invalid', { maxPackagingStylesPerBatch: 0 }],
  ])('fails safe and blocks submission when limit metadata is %s', async (_name, limits) => {
    mockRequest.get.mockImplementation(async (url) => {
      if (url === '/api/image-generation/config') {
        return imageGenerationConfig;
      }
      if (url === promptTemplatesUrl) {
        return { templates: [existingTemplate, ...systemPackagingTemplates], limits };
      }
      throw new Error(`Unexpected GET ${String(url)}`);
    });

    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    expect(await screen.findByText('包装样式选择上限加载失败，请刷新后重试。')).toBeVisible();
    fireEvent.change(screen.getByLabelText('商品标题'), { target: { value: '测试商品' } });
    fireEvent.click(screen.getByRole('button', { name: '开始批量生成' }));

    expect(mockRequest.postMultiPart).not.toHaveBeenCalled();
  });

  test('preserves the selected Flare model when switching from single to batch text generation', async () => {
    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    await screen.findByRole('option', { name: 'GPT Image 2.5 Flare' });
    fireEvent.change(screen.getByRole('combobox', { name: '模型选择' }), {
      target: { value: 'apimart_gpt_image_2_5_flare' },
    });
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    await screen.findByRole('checkbox', { name: systemPackagingTemplates[0].name });
    expect(screen.getByRole('combobox', { name: '模型选择' })).toHaveValue(
      'apimart_gpt_image_2_5_flare',
    );
    expect(screen.getByText('文生图模型，按生成数量和尺寸计费')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('商品标题'), {
      target: { value: 'Synthetic blue box' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始批量生成' }));
    await waitFor(() => expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1));
    const [, form] = mockRequest.postMultiPart.mock.calls[0] as [string, FormData];
    expect(form.get('modelKey')).toBe('apimart_gpt_image_2_5_flare');
    expect(form.get('model')).toBe('gpt-image-2.5-flare');
    expect(form.get('mode')).toBe('t2i');
  });

  test('cleans a selected custom key after the template disappears on reload', async () => {
    templates = [existingTemplate, ...systemPackagingTemplates, createdTemplate];

    render(
      <MemoryRouter initialEntries={['/image-generation']}>
        <ImageGeneration />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    const customCheckbox = await screen.findByRole('checkbox', { name: createdTemplate.name });
    fireEvent.click(screen.getByRole('checkbox', { name: systemPackagingTemplates[0].name }));
    fireEvent.click(customCheckbox);
    expect(customCheckbox).toBeChecked();

    templates = [existingTemplate, ...systemPackagingTemplates];
    fireEvent.click(screen.getByRole('button', { name: '单次生成' }));
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('checkbox', { name: createdTemplate.name }),
      ).not.toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('商品标题'), { target: { value: '测试商品' } });
    fireEvent.click(screen.getByRole('button', { name: '开始批量生成' }));
    await waitFor(() => expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1));
    const [, formData] = mockRequest.postMultiPart.mock.calls[0] as [string, FormData];
    expect(JSON.parse(String(formData.get('templateIds')))).not.toContain(createdTemplate.key);
  });

  test('does not resurrect a just-created packaging template after it is deleted', async () => {
    mockRequest.get.mockImplementation(async (url) => {
      if (url === '/api/image-generation/config') {
        return imageGenerationConfig;
      }
      if (url === promptTemplatesUrl) {
        return promptTemplateResponse([existingTemplate, ...systemPackagingTemplates]);
      }
      throw new Error(`Unexpected GET ${String(url)}`);
    });

    await openPromptTemplateManager();
    await createNewPromptTemplate();
    expect(await screen.findByRole('checkbox', { name: createdTemplate.name })).toBeInTheDocument();

    templates = [existingTemplate, ...systemPackagingTemplates];
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(mockRequest.delete).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(
        screen.queryByRole('checkbox', { name: createdTemplate.name }),
      ).not.toBeInTheDocument();
    });
  });

  test('does not restore stale enabled state after a newly created template is disabled', async () => {
    mockRequest.get.mockImplementation(async (url) => {
      if (url === '/api/image-generation/config') {
        return imageGenerationConfig;
      }
      if (url === promptTemplatesUrl) {
        return promptTemplateResponse([existingTemplate, ...systemPackagingTemplates]);
      }
      throw new Error(`Unexpected GET ${String(url)}`);
    });

    await openPromptTemplateManager();
    await createNewPromptTemplate();
    expect(await screen.findByRole('checkbox', { name: createdTemplate.name })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: '启用模板' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockRequest.patch).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(
        screen.queryByRole('checkbox', { name: createdTemplate.name }),
      ).not.toBeInTheDocument();
    });
  });
});
