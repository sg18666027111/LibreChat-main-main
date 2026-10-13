import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ImageGeneration from './ImageGeneration';
import { createImageGenerationJobFingerprint } from './ImageGeneration/queueLiveness';
import { request } from 'librechat-data-provider';

const mockShowToast = jest.fn();
let mockToastCallback = mockShowToast;
const mockUploadSkuFile = jest.fn();
const mockLoadSkuFileObjectUrl = jest.fn();

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockToastCallback }),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { role: 'USER', permissions: {} } }),
  useLocalize: () => (key: string) =>
    jest.requireActual('~/locales/en/translation.json')[key] ?? key,
}));

jest.mock('librechat-data-provider', () => ({
  request: {
    get: jest.fn(),
    post: jest.fn(),
    postMultiPart: jest.fn(),
    getResponse: jest.fn(),
  },
  SystemRoles: {
    ADMIN: 'ADMIN',
  },
}));

jest.mock('./SkuGeneration/api', () => ({
  loadSkuFileObjectUrl: (...args: unknown[]) => mockLoadSkuFileObjectUrl(...args),
  uploadSkuFile: (...args: unknown[]) => mockUploadSkuFile(...args),
}));

const mockRequest = request as jest.Mocked<typeof request>;
const IMAGE_GENERATION_SOFT_WAIT_MS = 5 * 60 * 1000;
const APIMART_MULTI_REFERENCE_HARD_WAIT_MS = 11 * 60 * 1000;
const DEFAULT_IMAGE_GENERATION_HARD_WAIT_MS = 6 * 60 * 1000;
const IMAGE_GENERATION_LEASE_STORAGE_KEY = 'jingjicang_image_generation_active_lease';
const IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY = 'jingjicang_image_generation_async_tasks';
const IMAGE_GENERATION_LEASE_CHANNEL_NAME = 'jingjicang_image_generation_lease';
const IMAGE_GENERATION_LEASE_UPDATED_MESSAGE = 'image_generation_lease_updated';
const IMAGE_GENERATION_LEASE_CLEARED_MESSAGE = 'image_generation_lease_cleared';
const IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT = 7;
const IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE =
  '当前已有 7 个任务正在生成，请等待任一任务完成后继续。';
const IMAGE_GENERATION_CROSS_TAB_DUPLICATE_MESSAGE =
  '另一个页面正在生成相同内容，继续提交可能产生重复图片和额外费用。';

type TestGenerationLease = {
  tabSessionId: string;
  localTaskId: string;
  taskType: string;
  jobFingerprint?: string;
  startedAt: number;
  leaseExpiresAt: number;
  status: 'running' | 'status_unknown';
};

type StoredAsyncImageTask = {
  taskId: string;
  taskType: 'text-to-image' | 'image-to-image' | 'dual-product-replace' | 'white-background';
  modelKey?: string;
  platform: string;
  imageType: string;
  model: string;
  prompt: string;
  aspectRatio: string;
  outputQuality?: string;
  count: number;
  createdAt: string;
  status: string;
  state: string;
  internalTaskId: string;
  requestId?: string | null;
};

class FakeBroadcastChannel {
  static channels: FakeBroadcastChannel[] = [];

  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.channels.push(this);
  }

  postMessage(data: unknown) {
    FakeBroadcastChannel.emit(data, this.name, this);
  }

  close() {
    FakeBroadcastChannel.channels = FakeBroadcastChannel.channels.filter(
      (channel) => channel !== this,
    );
  }

  static emit(
    data: unknown,
    name = IMAGE_GENERATION_LEASE_CHANNEL_NAME,
    sender?: FakeBroadcastChannel,
  ) {
    FakeBroadcastChannel.channels
      .filter((channel) => channel.name === name && channel !== sender)
      .forEach((channel) => {
        channel.onmessage?.({ data } as MessageEvent);
      });
  }

  static reset() {
    FakeBroadcastChannel.channels = [];
  }
}

const originalBroadcastChannel = globalThis.BroadcastChannel;

if (!URL.createObjectURL) {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: jest.fn(),
  });
}

if (!URL.revokeObjectURL) {
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: jest.fn(),
  });
}

function imageFile(name: string, type = 'image/png') {
  return new File([name], name, { type });
}

function textFile(name: string) {
  return new File(['plain text'], name, { type: 'text/plain' });
}

function clipboardData(files: File[]) {
  return {
    files,
    items: files.map((file) => ({
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
    })),
  } as unknown as DataTransfer;
}

function lastToastMessage() {
  return mockShowToast.mock.calls.at(-1)?.[0]?.message;
}

async function renderDualProductReplace() {
  const createObjectURL = jest.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    const file = value as File;
    return `blob:${file.name || 'generated'}`;
  });
  const revokeObjectURL = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(jest.fn());

  mockRequest.get.mockResolvedValue({
    platforms: ['通用'],
    imageTypes: ['通用营销图'],
    aspectRatios: ['1:1', '4:5'],
    counts: [1, 2, 4],
    models: [{ label: '快速生图', value: 'Qwen/Qwen-Image' }],
    editModels: [
      {
        label: 'GPT Image 2（高质量）',
        value: 'apimart_gpt_image_2',
        model: 'gpt-image-2',
        capabilities: ['single-image-edit', 'multi-reference'],
      },
      {
        label: 'GPT Image 2.5 Sunburst',
        value: 'apimart_gpt_image_2_5_sunburst',
        model: 'gpt-image-2.5-sunburst',
        capabilities: ['single-image-edit', 'multi-reference'],
      },
    ],
    defaultAspectRatios: { 通用营销图: '4:5' },
    platformTypeAspectRatios: {},
    outputQualities: [],
    defaultOutputQuality: 'standard',
  });
  mockRequest.postMultiPart.mockResolvedValue({
    images: [{ url: 'https://example.test/result.png' }],
  });

  const view = renderImageGeneration();
  fireEvent.click(screen.getByRole('button', { name: '多图商品替换' }));

  await waitFor(() => {
    expect(screen.getByText('上传参考图')).toBeInTheDocument();
  });

  return { ...view, createObjectURL, revokeObjectURL };
}

async function renderSingleTextToImage(
  images: Array<
    Partial<{ url: string; downloadUrl: string; proxiedUrl: string; b64_json: string }>
  > = [{ url: 'https://example.test/result.png' }],
) {
  mockRequest.get.mockResolvedValue({
    platforms: ['通用'],
    imageTypes: ['通用营销图'],
    aspectRatios: ['1:1', '4:5'],
    counts: [1, 2, 4],
    models: [
      {
        label: 'GPT Image 2.5 Flare（FAL）',
        value: 'fal_gpt_image_2_5_flare_text',
        modelKey: 'fal_gpt_image_2_5_flare_text',
        model: 'openai/gpt-image-2.5/flare/text-to-image',
        provider: 'fal',
        capabilities: ['text-to-image'],
        supportedCounts: [1],
      },
      {
        label: 'GPT Image 2.5 Flare',
        value: 'apimart_gpt_image_2_5_flare',
        modelKey: 'apimart_gpt_image_2_5_flare',
        model: 'gpt-image-2.5-flare',
        provider: 'apimart',
        capabilities: ['text-to-image'],
      },
      { label: '快速生图', value: 'Qwen/Qwen-Image', provider: 'siliconflow' },
      {
        label: 'GPT Image 2（高清）',
        value: 'apimart_gpt_image_2_text',
        modelKey: 'apimart_gpt_image_2_text',
        model: 'gpt-image-2',
        capabilities: ['text-to-image'],
      },
    ],
    editModels: [
      {
        label: 'GPT Image 2（高质量）',
        value: 'apimart_gpt_image_2',
        model: 'gpt-image-2',
        capabilities: ['single-image-edit', 'multi-reference'],
      },
    ],
    defaultAspectRatios: { 通用营销图: '4:5' },
    platformTypeAspectRatios: {},
    outputQualities: [],
    defaultOutputQuality: 'standard',
  });
  mockRequest.post.mockResolvedValue({ images });

  const view = renderImageGeneration();

  await waitFor(() => {
    expect(screen.getByLabelText('提示词')).toBeInTheDocument();
  });

  return view;
}

function advanceSoftWait(extraMs = 0) {
  act(() => {
    jest.advanceTimersByTime(IMAGE_GENERATION_SOFT_WAIT_MS + extraMs);
  });
}

function advancePastApimartMultiReferenceHardWait() {
  act(() => {
    jest.advanceTimersByTime(APIMART_MULTI_REFERENCE_HARD_WAIT_MS + 1000);
  });
}

function createForeignLease(overrides: Partial<TestGenerationLease> = {}): TestGenerationLease {
  const startedAt = Date.now();
  const localTaskId = overrides.localTaskId ?? 'foreign-task';
  return {
    tabSessionId: overrides.tabSessionId ?? 'foreign-tab',
    localTaskId,
    taskType: 'text-to-image',
    jobFingerprint: overrides.jobFingerprint ?? `foreign-job-${localTaskId}`,
    startedAt,
    leaseExpiresAt: startedAt + DEFAULT_IMAGE_GENERATION_HARD_WAIT_MS,
    status: 'running',
    ...overrides,
  };
}

function getTestLeaseId(lease: Pick<TestGenerationLease, 'tabSessionId' | 'localTaskId'>) {
  return `${lease.tabSessionId}:${lease.localTaskId}`;
}

function readStoredLeaseRegistry() {
  const raw = localStorage.getItem(IMAGE_GENERATION_LEASE_STORAGE_KEY);
  if (!raw) {
    return {};
  }
  const stored = JSON.parse(raw) as
    | TestGenerationLease
    | { leases?: Record<string, TestGenerationLease> };
  if ('leases' in stored && stored.leases) {
    return stored.leases;
  }
  if ('tabSessionId' in stored && 'localTaskId' in stored) {
    return {
      [getTestLeaseId(stored)]: stored,
    };
  }
  return {};
}

function writeStoredLeaseRegistry(leases: TestGenerationLease[]) {
  localStorage.setItem(
    IMAGE_GENERATION_LEASE_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      leases: Object.fromEntries(leases.map((lease) => [getTestLeaseId(lease), lease])),
    }),
  );
}

function storeAsyncImageTasks(tasks: Partial<StoredAsyncImageTask>[]) {
  const storedTasks = tasks.map((task, index) => ({
    taskId: task.taskId ?? `frontend-task-${index + 1}`,
    taskType: task.taskType ?? 'text-to-image',
    modelKey: task.modelKey ?? 'apimart_gpt_image_2_text',
    platform: task.platform ?? '通用',
    imageType: task.imageType ?? '通用营销图',
    model: task.model ?? 'gpt-image-2',
    prompt: task.prompt ?? `测试提示词 ${index + 1}`,
    aspectRatio: task.aspectRatio ?? '4:5',
    outputQuality: task.outputQuality ?? 'standard',
    count: task.count ?? 1,
    createdAt: task.createdAt ?? `2026-08-07T07:5${index}:00.000Z`,
    status: task.status ?? 'running',
    state: task.state ?? 'polling',
    internalTaskId: task.internalTaskId ?? `internal-task-${index + 1}`,
    requestId: task.requestId ?? `request-${index + 1}`,
  }));

  localStorage.setItem(
    IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY,
    JSON.stringify({ version: 1, tasks: storedTasks }),
  );
}

function imageGenerationConfigResponse() {
  return {
    platforms: ['通用'],
    imageTypes: ['通用营销图'],
    aspectRatios: ['1:1', '4:5'],
    counts: [1],
    models: [],
    editModels: [],
    defaultAspectRatios: { 通用营销图: '4:5' },
    platformTypeAspectRatios: {},
    outputQualities: [],
    defaultOutputQuality: 'standard',
  };
}

function storeForeignLease(overrides: Partial<TestGenerationLease> = {}) {
  const lease = createForeignLease(overrides);
  writeStoredLeaseRegistry([...Object.values(readStoredLeaseRegistry()), lease]);
  return lease;
}

function crossTabAvailabilityMessage(activeCount: number) {
  return `其他页面有 ${activeCount} 个任务正在生成，当前还可并行 ${
    IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT - activeCount
  } 个任务。`;
}

async function textToImageFingerprint(prompt: string) {
  return await createImageGenerationJobFingerprint({
    entry: 'standalone-image-generation',
    generationTab: 'single',
    taskType: 'text-to-image',
    modelKey: null,
    model: 'Qwen/Qwen-Image',
    platform: '通用',
    imageType: '通用营销图',
    prompt,
    aspectRatio: '4:5',
    outputQuality: 'hd',
    count: 1,
    inputImages: [],
  });
}

function storeForeignLeases(count: number, overrides: Partial<TestGenerationLease> = {}) {
  const leases = Array.from({ length: count }, (_, index) =>
    createForeignLease({
      tabSessionId: `foreign-tab-${index}`,
      localTaskId: `foreign-task-${index}`,
      jobFingerprint: `foreign-job-${index}`,
      startedAt: Date.now() + index,
      ...overrides,
    }),
  );
  writeStoredLeaseRegistry(leases);
  return leases;
}

function uploadSlot(label: string, file: File) {
  const slot = screen.getByText(label).closest('label');
  if (!slot) {
    throw new Error(`Missing upload slot: ${label}`);
  }
  const input = slot.querySelector('input[type="file"]');
  if (!input) {
    throw new Error(`Missing file input for slot: ${label}`);
  }
  fireEvent.change(input, { target: { files: [file] } });
}

function pasteImages(files: File[]) {
  const panel = screen.getByText('任务类型').closest('section');
  if (!panel) {
    throw new Error('Missing generation panel');
  }
  fireEvent.paste(panel, {
    clipboardData: clipboardData(files),
  });
}

async function fillThreeImages() {
  uploadSlot('上传参考图 1', imageFile('ref-1.png'));
  uploadSlot('上传商品图', imageFile('product.png'));
  uploadSlot('上传参考图 2', imageFile('ref-2.png'));

  await screen.findByText('参考图 1：ref-1.png');
  expect(screen.getByText('商品图：product.png')).toBeInTheDocument();
  expect(screen.getByText('参考图 2：ref-2.png')).toBeInTheDocument();
}

function enqueueDualProductReplaceTask() {
  fireEvent.change(screen.getByLabelText('生成需求'), { target: { value: '融合参考图风格' } });
  fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));
}

function slot(slotId: 'benchmark' | 'product' | 'extraReference') {
  return screen.getByTestId(`multi-reference-slot-${slotId}`);
}

function renderImageGeneration(
  ui: React.ReactElement = <ImageGeneration />,
  initialEntries: string[] = ['/image-generation'],
) {
  return render(<MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>);
}

describe('ImageGeneration multi-reference upload slots', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

  function imageDownloadResponse(body: Blob | BlobPart, contentType: string) {
    const blob = body instanceof Blob ? body : new Blob([body], { type: contentType });
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
      },
      blob: async () => blob,
    } as Response;
  }

  beforeEach(() => {
    mockToastCallback = mockShowToast;
    originalFetch = globalThis.fetch;
    jest.clearAllMocks();
    mockRequest.get.mockReset();
    mockRequest.post.mockReset();
    mockRequest.postMultiPart.mockReset();
    mockRequest.getResponse.mockReset();
    mockUploadSkuFile.mockReset();
    mockLoadSkuFileObjectUrl.mockReset();
    mockUploadSkuFile.mockResolvedValue({
      fileId: 'sku-source-1',
      filename: 'source.png',
      contentType: 'image/png',
    });
    localStorage.removeItem(IMAGE_GENERATION_LEASE_STORAGE_KEY);
    localStorage.removeItem(IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY);
    sessionStorage.clear();
    FakeBroadcastChannel.reset();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: FakeBroadcastChannel,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    localStorage.removeItem(IMAGE_GENERATION_LEASE_STORAGE_KEY);
    localStorage.removeItem(IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY);
    sessionStorage.clear();
    FakeBroadcastChannel.reset();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: originalBroadcastChannel,
    });
  });

  it('defaults new edits to FAL across task switches while keeping quick text generation', async () => {
    jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    jest.spyOn(URL, 'revokeObjectURL').mockImplementation(jest.fn());
    mockRequest.get.mockResolvedValue({
      platforms: ['通用'],
      imageTypes: ['通用营销图'],
      aspectRatios: ['1:1', '4:5'],
      counts: [1, 2, 4],
      models: [
        {
          label: 'GPT Image 2（FAL）',
          value: 'apimart_gpt_image_2_text',
          model: 'openai/gpt-image-2',
          provider: 'fal',
          supportedCounts: [1],
          capabilities: ['text-to-image'],
        },
        { label: '快速生图', value: 'Qwen/Qwen-Image', provider: 'siliconflow' },
      ],
      editModels: [
        {
          label: 'GPT Image 2 Edit（FAL）',
          value: 'fal_gpt_image_2_edit',
          model: 'openai/gpt-image-2/edit',
          provider: 'fal',
          capabilities: ['single-image-edit', 'multi-reference'],
        },
        {
          label: 'GPT Image 2（APIMart）',
          value: 'apimart_gpt_image_2',
          model: 'gpt-image-2',
          provider: 'apimart',
          capabilities: ['single-image-edit', 'multi-reference'],
        },
      ],
      defaultAspectRatios: { 通用营销图: '4:5' },
      platformTypeAspectRatios: {},
      outputQualities: [],
      defaultOutputQuality: 'standard',
    });
    mockRequest.postMultiPart.mockResolvedValue({
      images: [{ url: 'https://example.test/result.png' }],
    });
    renderImageGeneration();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'GPT Image 2（FAL）' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('combobox', { name: '模型选择' })).toHaveValue('Qwen/Qwen-Image');
    fireEvent.click(screen.getByRole('button', { name: '单图改图' }));
    expect(screen.getByRole('combobox', { name: '模型选择' })).toHaveValue('fal_gpt_image_2_edit');
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    expect(screen.getByRole('combobox', { name: '模型选择' })).toHaveValue('Qwen/Qwen-Image');
    fireEvent.click(screen.getByRole('button', { name: '图生图' }));
    expect(screen.getByRole('combobox', { name: '模型选择' })).toHaveValue('fal_gpt_image_2_edit');
    fireEvent.click(screen.getByRole('button', { name: '单次生成' }));
    fireEvent.click(screen.getByRole('button', { name: '多图商品替换' }));
    expect(screen.getByRole('combobox', { name: '模型选择' })).toHaveValue('fal_gpt_image_2_edit');
    fireEvent.change(screen.getByRole('combobox', { name: '模型选择' }), {
      target: { value: 'apimart_gpt_image_2' },
    });
    fireEvent.click(screen.getByRole('button', { name: '文生图' }));
    expect(screen.getByRole('combobox', { name: '模型选择' })).toHaveValue('Qwen/Qwen-Image');
    fireEvent.click(screen.getByRole('button', { name: '多图商品替换' }));
    expect(screen.getByRole('combobox', { name: '模型选择' })).toHaveValue('fal_gpt_image_2_edit');
    await fillThreeImages();
    fireEvent.change(screen.getByLabelText('生成需求'), {
      target: { value: 'Synthetic product edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));
    await waitFor(() => expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1));
    const submitted = mockRequest.postMultiPart.mock.calls[0][1] as FormData;
    expect(submitted.get('modelKey')).toBe('fal_gpt_image_2_edit');
    expect(submitted.get('model')).toBe('openai/gpt-image-2/edit');
  });

  it('submits fal Flare text with one output and exposes it in batch text mode', async () => {
    await renderSingleTextToImage();
    fireEvent.click(screen.getByRole('button', { name: '生成 4 张' }));
    fireEvent.change(screen.getByRole('combobox', { name: '模型选择' }), {
      target: { value: 'fal_gpt_image_2_5_flare_text' },
    });
    expect(screen.getByRole('button', { name: '生成 4 张' })).toBeDisabled();
    expect(screen.getByText('GPT Image 2.5 Flare（FAL）每次生成 1 张')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: 'Synthetic box' } });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));
    await waitFor(() => expect(mockRequest.post).toHaveBeenCalledTimes(1));
    expect(mockRequest.post.mock.calls[0][1]).toMatchObject({
      modelKey: 'fal_gpt_image_2_5_flare_text',
      model: 'openai/gpt-image-2.5/flare/text-to-image',
      count: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: '批量包装生成' }));
    expect(screen.getByRole('option', { name: 'GPT Image 2.5 Flare（FAL）' })).toHaveValue(
      'fal_gpt_image_2_5_flare_text',
    );
  });

  it('submits the independently selected Flare text model with all four requested outputs', async () => {
    await renderSingleTextToImage();
    const selector = screen.getByRole('combobox', { name: '模型选择' });
    expect(selector).toHaveValue('Qwen/Qwen-Image');
    fireEvent.change(selector, { target: { value: 'apimart_gpt_image_2_5_flare' } });
    expect(screen.getByText('文生图模型，按生成数量和尺寸计费')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: 'Synthetic blue box' } });
    fireEvent.click(screen.getByRole('button', { name: '生成 4 张' }));
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));
    await waitFor(() => expect(mockRequest.post).toHaveBeenCalledTimes(1));
    expect(mockRequest.post.mock.calls[0][1]).toMatchObject({
      modelKey: 'apimart_gpt_image_2_5_flare',
      model: 'gpt-image-2.5-flare',
      count: 4,
    });
  });

  it('keeps IMG2 selected by default and shows the Sunburst fee note only after selection', async () => {
    await renderDualProductReplace();
    const selector = screen.getByRole('combobox', { name: '模型选择' });
    expect(selector).toHaveValue('apimart_gpt_image_2');
    expect(screen.queryByText('编辑模型，费用较高')).not.toBeInTheDocument();
    fireEvent.change(selector, { target: { value: 'apimart_gpt_image_2_5_sunburst' } });
    expect(selector).toHaveValue('apimart_gpt_image_2_5_sunburst');
    expect(screen.getByText('编辑模型，费用较高')).toBeInTheDocument();
  });

  it('keeps the three-image limit and guides paste replacement when full without a selected slot', async () => {
    await renderDualProductReplace();
    await fillThreeImages();

    pasteImages([imageFile('overflow.png')]);

    expect(screen.queryByText(/overflow\.png/)).not.toBeInTheDocument();
    expect(lastToastMessage()).toBe('已使用 3/3 张图。请选择一张图片进行替换，或删除后继续粘贴。');
    expect(screen.getByText('参考图 1：ref-1.png')).toBeInTheDocument();
    expect(screen.getByText('商品图：product.png')).toBeInTheDocument();
    expect(screen.getByText('参考图 2：ref-2.png')).toBeInTheDocument();
  });

  it('replaces the selected product slot on paste and keeps reference slots unchanged', async () => {
    await renderDualProductReplace();
    await fillThreeImages();

    fireEvent.click(screen.getByRole('button', { name: /选择商品图作为粘贴替换目标/ }));
    pasteImages([imageFile('product-next.png')]);

    expect(screen.getByText('商品图：product-next.png')).toBeInTheDocument();
    expect(screen.getByText('参考图 1：ref-1.png')).toBeInTheDocument();
    expect(screen.getByText('参考图 2：ref-2.png')).toBeInTheDocument();
    expect(screen.queryByText(/当前替换目标/)).not.toBeInTheDocument();
  });

  it('replaces the selected reference slot on paste and keeps its slot identity', async () => {
    await renderDualProductReplace();
    await fillThreeImages();

    fireEvent.click(screen.getByRole('button', { name: /选择参考图 2作为粘贴替换目标/ }));
    pasteImages([imageFile('ref-2-next.png')]);

    expect(screen.getByText('参考图 2：ref-2-next.png')).toBeInTheDocument();
    expect(screen.getByText('参考图 1：ref-1.png')).toBeInTheDocument();
    expect(screen.getByText('商品图：product.png')).toBeInTheDocument();
  });

  it('deletes a reference slot and immediately pastes into the released slot', async () => {
    await renderDualProductReplace();
    await fillThreeImages();

    fireEvent.click(screen.getByRole('button', { name: '删除参考图 1' }));
    expect(screen.queryByText(/参考图 1：ref-1\.png/)).not.toBeInTheDocument();

    pasteImages([imageFile('ref-1-next.png')]);

    expect(screen.getByText('参考图 1：ref-1-next.png')).toBeInTheDocument();
    expect(screen.getByText('商品图：product.png')).toBeInTheDocument();
    expect(screen.getByText('参考图 2：ref-2.png')).toBeInTheDocument();
  });

  it('keeps product and second reference positions stable after deleting the first reference slot', async () => {
    await renderDualProductReplace();
    await fillThreeImages();

    fireEvent.click(screen.getByRole('button', { name: '删除参考图 1' }));

    expect(within(slot('benchmark')).getByText('上传参考图 1')).toBeInTheDocument();
    expect(within(slot('benchmark')).queryByText(/商品图：/)).not.toBeInTheDocument();
    expect(within(slot('product')).getByText('商品图：product.png')).toBeInTheDocument();
    expect(within(slot('extraReference')).getByText('参考图 2：ref-2.png')).toBeInTheDocument();
  });

  it('keeps both reference positions stable after deleting the product slot', async () => {
    await renderDualProductReplace();
    await fillThreeImages();

    fireEvent.click(screen.getByRole('button', { name: '删除商品图' }));

    expect(within(slot('benchmark')).getByText('参考图 1：ref-1.png')).toBeInTheDocument();
    expect(within(slot('product')).getByText('上传商品图')).toBeInTheDocument();
    expect(within(slot('product')).queryByText(/参考图/)).not.toBeInTheDocument();
    expect(within(slot('extraReference')).getByText('参考图 2：ref-2.png')).toBeInTheDocument();
  });

  it('keeps first reference and product positions stable after deleting the second reference slot', async () => {
    await renderDualProductReplace();
    await fillThreeImages();

    fireEvent.click(screen.getByRole('button', { name: '删除参考图 2' }));

    expect(within(slot('benchmark')).getByText('参考图 1：ref-1.png')).toBeInTheDocument();
    expect(within(slot('product')).getByText('商品图：product.png')).toBeInTheDocument();
    expect(within(slot('extraReference')).getByText('上传参考图 2')).toBeInTheDocument();
    expect(within(slot('extraReference')).queryByText(/商品图：/)).not.toBeInTheDocument();
  });

  it('keeps replacement behavior scoped to a slot after another slot was deleted', async () => {
    await renderDualProductReplace();
    await fillThreeImages();

    fireEvent.click(screen.getByRole('button', { name: '删除商品图' }));
    fireEvent.click(screen.getByRole('button', { name: /选择参考图 2作为粘贴替换目标/ }));
    pasteImages([imageFile('ref-2-next.png')]);

    expect(within(slot('benchmark')).getByText('参考图 1：ref-1.png')).toBeInTheDocument();
    expect(within(slot('product')).getByText('上传商品图')).toBeInTheDocument();
    expect(
      within(slot('extraReference')).getByText('参考图 2：ref-2-next.png'),
    ).toBeInTheDocument();
  });

  it('clears reference images or all images without resetting non-image form state', async () => {
    await renderDualProductReplace();
    await fillThreeImages();

    fireEvent.change(screen.getByLabelText('生成需求'), {
      target: { value: '保持商品主体，换成夏日场景' },
    });

    fireEvent.click(screen.getByRole('button', { name: '清空参考图' }));
    expect(screen.queryByText(/参考图 1：/)).not.toBeInTheDocument();
    expect(screen.queryByText(/参考图 2：/)).not.toBeInTheDocument();
    expect(screen.getByText('商品图：product.png')).toBeInTheDocument();
    expect(screen.getByLabelText('生成需求')).toHaveValue('保持商品主体，换成夏日场景');

    fireEvent.click(screen.getByRole('button', { name: '清空全部' }));
    expect(screen.queryByText(/商品图：/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('生成需求')).toHaveValue('保持商品主体，换成夏日场景');
  });

  it('submits only the current files after replacing and deleting old images', async () => {
    await renderDualProductReplace();
    await fillThreeImages();

    fireEvent.click(screen.getByRole('button', { name: /选择商品图作为粘贴替换目标/ }));
    pasteImages([imageFile('product-next.png')]);
    fireEvent.click(screen.getByRole('button', { name: '删除参考图 2' }));
    fireEvent.change(screen.getByLabelText('生成需求'), { target: { value: '融合参考图风格' } });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));

    await waitFor(() => {
      expect(mockRequest.postMultiPart).toHaveBeenCalledWith(
        '/api/image-generation/multi-reference',
        expect.any(FormData),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    const formData = mockRequest.postMultiPart.mock.calls[0][1] as FormData;
    const images = formData.getAll('images') as File[];
    expect(images.map((file) => file.name)).toEqual(['ref-1.png', 'product-next.png']);
    expect(images.map((file) => file.name)).not.toContain('product.png');
    expect(images.map((file) => file.name)).not.toContain('ref-2.png');
  });

  it('downloads a JSON-wrapped generated image URL as a real image file', async () => {
    jest.useFakeTimers();
    const createObjectURL = jest
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:downloaded-image');
    const revokeObjectURL = jest.spyOn(URL, 'revokeObjectURL').mockImplementation();
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation();
    mockRequest.getResponse.mockResolvedValueOnce({
      data: new Blob([JSON.stringify({ url: '/api/image-generation/result-image/actual' })], {
        type: 'application/json',
      }),
      headers: { 'content-type': 'application/json' },
      status: 200,
    } as never);
    const fetchSpy = jest
      .fn()
      .mockResolvedValueOnce(
        imageDownloadResponse(new Blob([pngBytes], { type: 'image/png' }), 'image/png'),
      );
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchSpy,
    });

    await renderSingleTextToImage([
      {
        url: 'https://example.test/display.png',
        downloadUrl: '/api/image-generation/result-image/meta?download=1',
      },
    ]);

    fireEvent.change(screen.getByLabelText('提示词'), {
      target: { value: '白色保温杯，办公室场景' },
    });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));

    await screen.findByAltText(/AI 生图结果 1/);
    fireEvent.click(screen.getByRole('link', { name: '下载' }));

    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png' }));
    });
    expect(mockRequest.getResponse).toHaveBeenCalledWith(
      '/api/image-generation/result-image/meta?download=1',
      expect.objectContaining({ responseType: 'blob' }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/image-generation/result-image/actual',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(clickSpy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:downloaded-image');
  });

  it('keeps a normal single-image task running at the five-minute soft wait reminder', async () => {
    jest.useFakeTimers();
    await renderSingleTextToImage();

    mockRequest.post.mockImplementationOnce(() => new Promise(() => undefined));
    fireEvent.change(screen.getByLabelText('提示词'), {
      target: { value: '白色保温杯，办公室场景' },
    });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));

    await waitFor(() => {
      expect(mockRequest.post).toHaveBeenCalledTimes(1);
    });

    advanceSoftWait(1000);

    await waitFor(() => {
      expect(screen.getByText('生成时间较长，任务仍在处理中')).toBeInTheDocument();
    });
    expect(screen.getByText('AI 正在生成图片，请稍等')).toBeInTheDocument();
    expect(
      screen.queryByText(/当前无法确认任务是否已被后端或 Provider 接收/),
    ).not.toBeInTheDocument();
    expect(mockRequest.post).toHaveBeenCalledTimes(1);
  });

  it('keeps an APIMart multi-reference task running after the five-minute soft wait reminder', async () => {
    jest.useFakeTimers();
    await renderDualProductReplace();
    await fillThreeImages();

    mockRequest.postMultiPart.mockImplementationOnce(() => new Promise(() => undefined));
    enqueueDualProductReplaceTask();

    await waitFor(() => {
      expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);
    });

    advanceSoftWait();

    await waitFor(() => {
      expect(screen.getByText('生成时间较长，任务仍在处理中')).toBeInTheDocument();
    });
    expect(screen.getByText('AI 正在生成图片，请稍等')).toBeInTheDocument();
    expect(
      screen.queryByText(/当前无法确认任务是否已被后端或 Provider 接收/),
    ).not.toBeInTheDocument();
    expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);
  });

  it('releases local waiting and keeps an unknown task without recovering late success', async () => {
    jest.useFakeTimers();
    await renderDualProductReplace();
    await fillThreeImages();

    let resolveLateSuccess: (value: { images: Array<{ url: string }> }) => void = () => undefined;
    mockRequest.postMultiPart.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLateSuccess = resolve;
        }),
    );
    enqueueDualProductReplaceTask();

    await waitFor(() => {
      expect(screen.getByText('AI 正在生成图片，请稍等')).toBeInTheDocument();
    });

    advancePastApimartMultiReferenceHardWait();

    await waitFor(() => {
      expect(screen.queryByText('AI 正在生成图片，请稍等')).not.toBeInTheDocument();
    });
    expect(
      screen.getByText(/等待响应超时，当前无法确认任务是否已被后端或 Provider 接收/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLateSuccess({ images: [{ url: 'https://example.test/late.png' }] });
      await Promise.resolve();
    });

    expect(screen.queryByAltText(/AI 生图结果/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/等待响应超时，当前无法确认任务是否已被后端或 Provider 接收/),
    ).toBeInTheDocument();
    expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);
  });

  it('pauses waiting tasks after a frontend wait timeout until the user confirms risk', async () => {
    jest.useFakeTimers();
    await renderDualProductReplace();
    await fillThreeImages();

    mockRequest.postMultiPart
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({ images: [{ url: 'https://example.test/second.png' }] });

    enqueueDualProductReplaceTask();
    fireEvent.change(screen.getByLabelText('生成需求'), { target: { value: '第二个任务' } });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));

    await waitFor(() => {
      expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);
    });

    advancePastApimartMultiReferenceHardWait();

    await waitFor(() => {
      expect(screen.queryByText('AI 正在生成图片，请稍等')).not.toBeInTheDocument();
    });
    expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/队列已暂停/)).toBeInTheDocument();
    expect(screen.getByText(/继续提交可能产生重复任务和额外费用/)).toBeInTheDocument();

    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '确认风险并继续队列' }));

    expect(confirm).toHaveBeenCalledWith(
      '当前任务状态无法确认，远端可能仍在生成。继续提交可能产生重复任务和额外费用。',
    );
    await waitFor(() => {
      expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(2);
    });
    expect(
      screen.getByText(/等待响应超时，当前无法确认任务是否已被后端或 Provider 接收/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/已停止本地等待/)).not.toBeInTheDocument();
    expect(screen.queryByText('生成失败，请稍后重试。')).not.toBeInTheDocument();
    expect(await screen.findByAltText(/AI 生图结果 1/)).toBeInTheDocument();
  });

  it('blocks ordinary enqueue while an unknown task is unresolved', async () => {
    jest.useFakeTimers();
    await renderDualProductReplace();
    await fillThreeImages();

    mockRequest.postMultiPart.mockImplementationOnce(() => new Promise(() => undefined));
    enqueueDualProductReplaceTask();

    await waitFor(() => {
      expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);
    });

    advancePastApimartMultiReferenceHardWait();

    await waitFor(() => {
      expect(screen.getByText(/队列已暂停/)).toBeInTheDocument();
    });

    const enqueueButton = screen.getByRole('button', { name: /加入生成队列/ });
    expect(enqueueButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('生成需求'), { target: { value: '继续生成新图' } });
    fireEvent.click(enqueueButton);
    expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);
  });

  it('allows ordinary enqueue in another tab when a different running lease is broadcast below the limit', async () => {
    await renderSingleTextToImage();

    fireEvent.change(screen.getByLabelText('提示词'), {
      target: { value: '白色保温杯，办公室场景' },
    });
    const enqueueButton = screen.getByRole('button', { name: /加入生成队列/ });
    expect(enqueueButton).not.toBeDisabled();

    const lease = storeForeignLease();
    act(() => {
      FakeBroadcastChannel.emit({
        type: IMAGE_GENERATION_LEASE_UPDATED_MESSAGE,
        lease,
      });
    });

    await waitFor(() => {
      expect(screen.getByText(crossTabAvailabilityMessage(1))).toBeInTheDocument();
    });
    expect(enqueueButton).not.toBeDisabled();
    fireEvent.click(enqueueButton);
    await waitFor(() => {
      expect(mockRequest.post).toHaveBeenCalledTimes(1);
    });
  });

  it('does not submit the same fingerprint when the user cancels the duplicate risk confirmation', async () => {
    const prompt = '白色保温杯，办公室场景';
    await renderSingleTextToImage();
    fireEvent.click(screen.getByRole('button', { name: /高清/ }));
    const lease = storeForeignLease({ jobFingerprint: await textToImageFingerprint(prompt) });
    act(() => {
      FakeBroadcastChannel.emit({
        type: IMAGE_GENERATION_LEASE_UPDATED_MESSAGE,
        lease,
      });
    });

    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: prompt } });
    await waitFor(() => {
      expect(screen.getByText(IMAGE_GENERATION_CROSS_TAB_DUPLICATE_MESSAGE)).toBeInTheDocument();
    });
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列/ }));

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith(IMAGE_GENERATION_CROSS_TAB_DUPLICATE_MESSAGE);
    });
    expect(mockRequest.post).not.toHaveBeenCalled();
    expect(Object.values(readStoredLeaseRegistry())).toHaveLength(1);
  });

  it('submits the same fingerprint only after the user confirms duplicate risk under the limit', async () => {
    const prompt = '白色保温杯，办公室场景';
    await renderSingleTextToImage();
    fireEvent.click(screen.getByRole('button', { name: /高清/ }));
    const foreignLease = storeForeignLease({
      jobFingerprint: await textToImageFingerprint(prompt),
    });
    act(() => {
      FakeBroadcastChannel.emit({
        type: IMAGE_GENERATION_LEASE_UPDATED_MESSAGE,
        lease: foreignLease,
      });
    });

    mockRequest.post.mockImplementationOnce(() => new Promise(() => undefined));
    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: prompt } });
    await waitFor(() => {
      expect(screen.getByText(IMAGE_GENERATION_CROSS_TAB_DUPLICATE_MESSAGE)).toBeInTheDocument();
    });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列/ }));

    await waitFor(() => {
      expect(mockRequest.post).toHaveBeenCalledTimes(1);
    });
    const registry = readStoredLeaseRegistry();
    expect(registry[getTestLeaseId(foreignLease)]).toEqual(foreignLease);
    expect(Object.values(registry)).toHaveLength(2);
  });

  it('blocks the eighth active task and does not offer a force override', async () => {
    storeForeignLeases(IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT);
    await renderSingleTextToImage();

    fireEvent.change(screen.getByLabelText('提示词'), {
      target: { value: '白色保温杯，办公室场景' },
    });
    await waitFor(() => {
      expect(screen.getByText(IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE)).toBeInTheDocument();
    });
    const enqueueButton = screen.getByRole('button', { name: /加入生成队列/ });
    expect(enqueueButton).toBeDisabled();
    expect(screen.queryByRole('button', { name: /强制继续/ })).not.toBeInTheDocument();
    fireEvent.click(enqueueButton);
    expect(mockRequest.post).not.toHaveBeenCalled();
    expect(Object.values(readStoredLeaseRegistry())).toHaveLength(
      IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT,
    );
  });

  it.each(Array.from({ length: 100 }, (_, index) => index))(
    'clears the browser lease after the current tab succeeds [%i]',
    async () => {
      await renderSingleTextToImage();

      fireEvent.change(screen.getByLabelText('提示词'), {
        target: { value: '白色保温杯，办公室场景' },
      });
      fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));

      await waitFor(() => {
        expect(mockRequest.post).toHaveBeenCalledTimes(1);
      });
      expect(await screen.findByAltText(/AI 生图结果 1/)).toBeInTheDocument();
      expect(localStorage.getItem(IMAGE_GENERATION_LEASE_STORAGE_KEY)).toBeNull();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mockRequest.post).toHaveBeenCalledTimes(1);
    },
  );

  it('allows explicit retry after confirmed failure and still starts the next task', async () => {
    await renderSingleTextToImage();
    mockRequest.post.mockRejectedValueOnce({
      response: { status: 500, data: { state: 'failed', message: 'Confirmed test failure' } },
    });
    fireEvent.change(screen.getByLabelText('提示词'), {
      target: { value: 'first cup' },
    });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));
    expect(await screen.findByText('Confirmed test failure')).toBeInTheDocument();
    expect(mockRequest.post).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByAltText(/AI 生图结果 1/)).toBeInTheDocument();
    expect(mockRequest.post).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText('提示词'), {
      target: { value: 'second cup' },
    });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));
    await waitFor(() => {
      expect(screen.getAllByAltText(/AI 生图结果 1/)).toHaveLength(2);
    });
    expect(mockRequest.post).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem(IMAGE_GENERATION_LEASE_STORAGE_KEY)).toBeNull();
  });

  it('polls an internal APIMart task after a queued response without resubmitting generation', async () => {
    jest.useFakeTimers();
    await renderSingleTextToImage();
    fireEvent.click(screen.getByRole('button', { name: /高清/ }));
    mockRequest.post.mockResolvedValueOnce({
      state: 'queued',
      status: 'waiting',
      internalTaskId: 'internal-task-1',
      submittedToProvider: false,
      provider: 'apimart',
      model: 'gpt-image-2',
    });
    mockRequest.get
      .mockResolvedValueOnce({
        state: 'running',
        status: 'polling',
        internalTaskId: 'internal-task-1',
        submittedToProvider: true,
        provider: 'apimart',
        model: 'gpt-image-2',
        images: [],
      })
      .mockResolvedValueOnce({
        state: 'success',
        status: 'succeeded',
        internalTaskId: 'internal-task-1',
        submittedToProvider: true,
        provider: 'apimart',
        model: 'gpt-image-2',
        images: [{ url: 'https://example.test/async-result.png' }],
      });

    fireEvent.change(screen.getByLabelText('提示词'), {
      target: { value: '白色保温杯，办公室场景' },
    });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));

    await waitFor(() => {
      expect(mockRequest.post).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockRequest.get).toHaveBeenCalledWith(
        '/api/image-generation/tasks/internal-task-1',
        expect.any(Object),
      );
    });
    expect(screen.getByText(/任务 1 状态：结果查询中/)).toBeInTheDocument();
    expect(screen.getByText('AI 正在生成图片，请稍等')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    expect(await screen.findByAltText(/AI 生图结果 1/)).toBeInTheDocument();
    expect(screen.getByText(/状态：已完成/)).toBeInTheDocument();
    expect(mockRequest.post).toHaveBeenCalledTimes(1);
    expect(mockRequest.get).toHaveBeenCalledTimes(3);
    const postPayload = mockRequest.post.mock.calls[0][1] as { frontendTaskId: string };
    const storedTasks = JSON.parse(
      localStorage.getItem(IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY) ?? '{}',
    ) as { tasks?: StoredAsyncImageTask[] };
    expect(storedTasks.tasks).toEqual([
      expect.objectContaining({
        taskId: postPayload.frontendTaskId,
        internalTaskId: 'internal-task-1',
        status: 'success',
      }),
    ]);
  });

  it('keeps an initial POST 524 ambiguous and does not offer a generation retry', async () => {
    await renderSingleTextToImage();
    mockRequest.post.mockRejectedValueOnce({
      response: { status: 524 },
      message: 'Request failed with status code 524',
    });
    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: 'unknown submission' } });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));
    expect(await screen.findByText(/任务 1 状态：状态暂时未知/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(mockRequest.post).toHaveBeenCalledTimes(1);
    expect(Object.values(readStoredLeaseRegistry())).toEqual([
      expect.objectContaining({
        localTaskId: mockRequest.post.mock.calls[0][1].frontendTaskId,
        status: 'status_unknown',
      }),
    ]);
  });

  it('recovers a 524 status query for an accepted task without submitting it again', async () => {
    jest.useFakeTimers();
    await renderSingleTextToImage();
    mockRequest.post.mockResolvedValueOnce({
      status: 'waiting',
      internalTaskId: 'recover-524',
      requestId: 'original-request',
    });
    mockRequest.get
      .mockRejectedValueOnce({
        response: { status: 524 },
        message: 'Request failed with status code 524',
      })
      .mockResolvedValueOnce({
        status: 'succeeded',
        internalTaskId: 'recover-524',
        images: [{ url: 'https://example.test/recovered.png' }],
      });
    fireEvent.change(screen.getByLabelText('提示词'), {
      target: { value: 'recover existing image' },
    });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));
    await waitFor(() =>
      expect(mockRequest.get).toHaveBeenCalledWith(
        '/api/image-generation/tasks/recover-524',
        expect.any(Object),
      ),
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(await screen.findByAltText(/AI 生图结果 1/)).toBeInTheDocument();
    expect(mockRequest.post).toHaveBeenCalledTimes(1);
    expect(mockRequest.postMultiPart).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem(IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY) ?? '{}').tasks,
    ).toEqual([expect.objectContaining({ requestId: 'original-request' })]);
  });

  it('recovers a 524 on the first query after refresh without creating another task', async () => {
    jest.useFakeTimers();
    storeAsyncImageTasks([{ taskId: 'refresh-524', internalTaskId: 'refresh-internal' }]);
    mockRequest.get
      .mockResolvedValueOnce(imageGenerationConfigResponse())
      .mockRejectedValueOnce({
        response: { status: 524 },
        message: 'Request failed with status code 524',
      })
      .mockResolvedValueOnce({
        status: 'succeeded',
        internalTaskId: 'refresh-internal',
        images: [{ url: 'https://example.test/refresh-recovered.png' }],
      });
    renderImageGeneration();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(await screen.findByAltText(/AI 生图结果 1/)).toBeInTheDocument();
    expect(mockRequest.post).not.toHaveBeenCalled();
    expect(mockRequest.postMultiPart).not.toHaveBeenCalled();
  });

  it('stops retrying an unauthorized status query while keeping the existing task recoverable', async () => {
    storeAsyncImageTasks([
      { taskId: 'auth-query', internalTaskId: 'auth-internal', requestId: 'auth-request' },
    ]);
    mockRequest.get
      .mockResolvedValueOnce(imageGenerationConfigResponse())
      .mockRejectedValueOnce({ response: { status: 401 }, message: 'Unauthorized' });
    renderImageGeneration();
    expect(await screen.findByText(/任务 1 状态：状态暂时未知/)).toBeInTheDocument();
    expect(mockRequest.get).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(localStorage.getItem(IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY) ?? '{}').tasks,
    ).toEqual([
      expect.objectContaining({ internalTaskId: 'auth-internal', requestId: 'auth-request' }),
    ]);
    expect(mockRequest.post).not.toHaveBeenCalled();
  });

  it('bounds restored status queries and resumes only the existing task after connectivity returns', async () => {
    jest.useFakeTimers();
    storeAsyncImageTasks([{ taskId: 'offline-query', internalTaskId: 'offline-internal' }]);
    mockRequest.get.mockResolvedValueOnce(imageGenerationConfigResponse()).mockRejectedValue({
      response: { status: 524 },
      message: 'Request failed with status code 524',
    });
    renderImageGeneration();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(DEFAULT_IMAGE_GENERATION_HARD_WAIT_MS);
    });
    expect(await screen.findByText(/任务 1 状态：状态暂时未知/)).toBeInTheDocument();
    const callsAtDeadline = mockRequest.get.mock.calls.length;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10000);
    });
    expect(mockRequest.get).toHaveBeenCalledTimes(callsAtDeadline);
    mockRequest.get.mockResolvedValueOnce({
      status: 'succeeded',
      internalTaskId: 'offline-internal',
      images: [{ url: 'https://example.test/resumed.png' }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resume status check' }));
    expect(await screen.findByAltText(/AI 生图结果 1/)).toBeInTheDocument();
    expect(mockRequest.post).not.toHaveBeenCalled();
    expect(mockRequest.postMultiPart).not.toHaveBeenCalled();
  });

  it('ignores a late restored GET after the local deadline and stops querying on unmount', async () => {
    jest.useFakeTimers();
    let finishQuery: (value: object) => void = () => {};
    storeAsyncImageTasks([
      { taskId: 'late-query', internalTaskId: 'late-internal', requestId: 'old-request' },
    ]);
    mockRequest.get
      .mockResolvedValueOnce(imageGenerationConfigResponse())
      .mockResolvedValueOnce({
        internalTaskId: 'late-internal',
        status: 'polling',
        requestId: 'latest-request',
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishQuery = resolve;
          }),
      );
    const page = renderImageGeneration();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(DEFAULT_IMAGE_GENERATION_HARD_WAIT_MS);
    });
    expect(await screen.findByText(/任务 1 状态：状态暂时未知/)).toBeInTheDocument();
    await act(async () => {
      finishQuery({
        status: 'succeeded',
        internalTaskId: 'late-internal',
        images: [{ url: 'https://example.test/late.png' }],
      });
    });
    expect(screen.queryByAltText(/AI 生图结果 1/)).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY) ?? '{}').tasks,
    ).toEqual([expect.objectContaining({ requestId: 'latest-request' })]);
    const storedAtDeadline = localStorage.getItem(IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY);
    page.unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10000);
    });
    expect(mockRequest.get).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem(IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY)).toBe(storedAtDeadline);
  });

  it('pauses the queue again when a resumed task becomes unknown after a known running state', async () => {
    let finishQuery: (value: object) => void = () => {};
    storeAsyncImageTasks([
      {
        taskId: 'pause-query',
        internalTaskId: 'pause-internal',
        state: 'status_unknown',
        status: 'status_unknown',
      },
    ]);
    mockRequest.get
      .mockResolvedValueOnce(imageGenerationConfigResponse())
      .mockResolvedValueOnce({ internalTaskId: 'pause-internal', status: 'status_unknown' });
    renderImageGeneration();
    await waitFor(() => expect(mockRequest.get).toHaveBeenCalledTimes(2));
    mockRequest.get
      .mockResolvedValueOnce({ internalTaskId: 'pause-internal', status: 'polling' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishQuery = resolve;
          }),
      );
    fireEvent.click(screen.getByRole('button', { name: 'Resume status check' }));
    await waitFor(() => expect(mockRequest.get).toHaveBeenCalledTimes(4));
    expect(screen.queryByText('队列已暂停')).not.toBeInTheDocument();
    await act(async () => {
      finishQuery({
        internalTaskId: 'pause-internal',
        status: 'status_unknown',
        errorCode: 'IMAGE_EGRESS_SUBMIT_RESULT_UNKNOWN',
      });
    });
    expect(await screen.findByText('队列已暂停')).toBeInTheDocument();
    expect(mockRequest.post).not.toHaveBeenCalled();
  });

  it('does not restore a removed local record when its resumed query responds late', async () => {
    let finishQuery: (value: object) => void = () => {};
    storeAsyncImageTasks([
      {
        taskId: 'remove-query',
        internalTaskId: 'remove-internal',
        state: 'status_unknown',
        status: 'status_unknown',
      },
    ]);
    mockRequest.get
      .mockResolvedValueOnce(imageGenerationConfigResponse())
      .mockResolvedValueOnce({ internalTaskId: 'remove-internal', status: 'status_unknown' });
    renderImageGeneration();
    await waitFor(() => expect(mockRequest.get).toHaveBeenCalledTimes(2));
    mockRequest.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishQuery = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume status check' }));
    await waitFor(() => expect(mockRequest.get).toHaveBeenCalledTimes(3));
    jest.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: '移除本地记录' }));
    await act(async () => {
      finishQuery({
        internalTaskId: 'remove-internal',
        status: 'succeeded',
        images: [{ url: 'https://example.test/removed.png' }],
      });
    });
    expect(screen.queryByText(/任务 1 状态/)).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY) ?? '{}').tasks ?? [],
    ).toEqual([]);
    expect(mockRequest.post).not.toHaveBeenCalled();
  });

  it('restores a server-waiting APIMart task after refresh without creating another job', async () => {
    storeAsyncImageTasks([
      {
        taskId: 'frontend-waiting-1',
        internalTaskId: 'internal-waiting-1',
        status: 'waiting',
        state: 'waiting',
      },
    ]);
    mockRequest.get
      .mockResolvedValueOnce(imageGenerationConfigResponse())
      .mockResolvedValueOnce({
        state: 'waiting',
        status: 'waiting',
        internalTaskId: 'internal-waiting-1',
        requestId: 'request-waiting-1',
        submittedToProvider: false,
        provider: 'apimart',
        model: 'gpt-image-2',
        images: [],
      })
      .mockResolvedValueOnce({
        state: 'waiting',
        status: 'waiting',
        internalTaskId: 'internal-waiting-1',
        requestId: 'request-waiting-1',
        submittedToProvider: false,
        provider: 'apimart',
        model: 'gpt-image-2',
        images: [],
      });

    renderImageGeneration();

    expect(await screen.findByText(/任务 1 状态：排队中/)).toBeInTheDocument();
    expect(await screen.findByText(/尚未提交供应商/)).toBeInTheDocument();
    expect(mockRequest.post).not.toHaveBeenCalled();
    expect(mockRequest.postMultiPart).not.toHaveBeenCalled();
    expect(mockRequest.get).toHaveBeenCalledWith(
      '/api/image-generation/tasks/internal-waiting-1',
      expect.any(Object),
    );
  });

  it('replaces the waiting message when the same restored task is accepted and then succeeds', async () => {
    jest.useFakeTimers();
    storeAsyncImageTasks([
      {
        taskId: 'transition-local',
        internalTaskId: 'transition-server',
        status: 'running',
        state: 'server_waiting',
      },
    ]);
    let status = 'waiting';
    mockRequest.get.mockImplementation(async (url) => {
      if (url === '/api/image-generation/config') {
        return imageGenerationConfigResponse();
      }
      return {
        internalTaskId: 'transition-server',
        state: 'running',
        status,
        submittedToProvider: status !== 'waiting',
        images: status === 'succeeded' ? [{ url: 'https://example.test/transition.png' }] : [],
      };
    });
    renderImageGeneration();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText(/尚未提交供应商/)).toBeInTheDocument();
    status = 'polling';
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(screen.queryByText(/尚未提交供应商/)).not.toBeInTheDocument();
    expect(screen.getByText('结果查询中。')).toBeInTheDocument();
    status = 'succeeded';
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByAltText('AI 生图结果 1')).toHaveAttribute(
      'src',
      'https://example.test/transition.png',
    );
    expect(mockRequest.post).not.toHaveBeenCalled();
  });

  it('keeps querying a durable queued task while status reads remain healthy beyond six minutes', async () => {
    jest.useFakeTimers();
    storeAsyncImageTasks([
      {
        taskId: 'long-local',
        internalTaskId: 'long-server',
        status: 'running',
        state: 'server_waiting',
      },
    ]);
    let status = 'waiting';
    mockRequest.get.mockImplementation(async (url) =>
      url === '/api/image-generation/config'
        ? imageGenerationConfigResponse()
        : { internalTaskId: 'long-server', status, images: [] },
    );
    renderImageGeneration();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(DEFAULT_IMAGE_GENERATION_HARD_WAIT_MS + 2000);
    });
    expect(screen.queryByText(/Status checks were interrupted/)).not.toBeInTheDocument();
    status = 'polling';
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText('结果查询中。')).toBeInTheDocument();
    expect(mockRequest.post).not.toHaveBeenCalled();
  });

  it('continues polling a restored APIMart task after refresh without Provider resubmit', async () => {
    storeAsyncImageTasks([
      {
        taskId: 'frontend-polling-1',
        internalTaskId: 'internal-polling-1',
        status: 'running',
        state: 'polling',
      },
    ]);
    mockRequest.get
      .mockResolvedValueOnce(imageGenerationConfigResponse())
      .mockResolvedValueOnce({
        state: 'running',
        status: 'polling',
        internalTaskId: 'internal-polling-1',
        requestId: 'request-polling-1',
        submittedToProvider: true,
        provider: 'apimart',
        model: 'gpt-image-2',
        images: [],
      })
      .mockResolvedValueOnce({
        state: 'running',
        status: 'polling',
        internalTaskId: 'internal-polling-1',
        requestId: 'request-polling-1',
        submittedToProvider: true,
        provider: 'apimart',
        model: 'gpt-image-2',
        images: [],
      });

    renderImageGeneration();

    expect(await screen.findByText(/任务 1 状态：结果查询中/)).toBeInTheDocument();
    await waitFor(() => {
      expect(
        mockRequest.get.mock.calls.filter(
          ([url]) => url === '/api/image-generation/tasks/internal-polling-1',
        ),
      ).toHaveLength(2);
    });
    expect(mockRequest.post).not.toHaveBeenCalled();
    expect(mockRequest.postMultiPart).not.toHaveBeenCalled();
  });

  it('keeps a completed result when the toast context callback changes during a connection failure', async () => {
    storeAsyncImageTasks([{ internalTaskId: 'internal-completed-toast' }]);
    let queries = 0;
    mockRequest.get.mockImplementation(async (url) => {
      if (url === '/api/image-generation/config') {
        return imageGenerationConfigResponse();
      }
      queries += 1;
      if (queries > 1) {
        throw { response: { status: 401 } };
      }
      return {
        internalTaskId: 'internal-completed-toast',
        state: 'success',
        status: 'succeeded',
        images: [{ url: 'https://example.test/completed-toast.png' }],
      };
    });
    const view = renderImageGeneration();
    expect(await screen.findByText(/任务 1 状态：已完成/)).toBeInTheDocument();

    mockToastCallback = jest.fn();
    await act(async () => {
      view.rerender(
        <MemoryRouter initialEntries={['/image-generation']}>
          <ImageGeneration />
        </MemoryRouter>,
      );
    });

    expect(screen.getByText(/任务 1 状态：已完成/)).toBeInTheDocument();
    expect(screen.getByAltText(/AI 生图结果 1/)).toHaveAttribute(
      'src',
      'https://example.test/completed-toast.png',
    );
    expect(queries).toBe(1);
    expect(screen.queryByText(/Status checks were interrupted/)).not.toBeInTheDocument();
  });

  it('restores a cached completed result without restarting status queries after a refresh', async () => {
    storeAsyncImageTasks([{ internalTaskId: 'internal-completed-refresh' }]);
    let queries = 0;
    mockRequest.get.mockImplementation(async (url) => {
      if (url === '/api/image-generation/config') {
        return imageGenerationConfigResponse();
      }
      queries += 1;
      if (queries > 1) {
        throw { response: { status: 401 } };
      }
      return {
        internalTaskId: 'internal-completed-refresh',
        state: 'success',
        status: 'succeeded',
        images: [{ url: 'https://example.test/completed-refresh.png' }],
      };
    });
    const view = renderImageGeneration();
    expect(await screen.findByText(/任务 1 状态：已完成/)).toBeInTheDocument();
    view.unmount();

    await act(async () => {
      renderImageGeneration();
    });

    expect(screen.getByText(/任务 1 状态：已完成/)).toBeInTheDocument();
    expect(queries).toBe(1);
    expect(screen.queryByText(/Status checks were interrupted/)).not.toBeInTheDocument();
    expect(mockRequest.post).not.toHaveBeenCalled();
    expect(mockRequest.postMultiPart).not.toHaveBeenCalled();
  });

  it('restores a succeeded APIMart task and its image after refresh', async () => {
    storeAsyncImageTasks([
      {
        taskId: 'frontend-success-1',
        internalTaskId: 'internal-success-1',
        status: 'success',
        state: 'success',
      },
    ]);
    mockRequest.get.mockResolvedValueOnce(imageGenerationConfigResponse()).mockResolvedValueOnce({
      state: 'success',
      status: 'succeeded',
      internalTaskId: 'internal-success-1',
      requestId: 'request-success-1',
      submittedToProvider: true,
      provider: 'apimart',
      model: 'gpt-image-2',
      images: [{ url: 'https://example.test/restored-success.png' }],
    });

    renderImageGeneration();

    expect(await screen.findByText(/任务 1 状态：已完成/)).toBeInTheDocument();
    expect(screen.queryByText('AI 正在生成图片，请稍等')).not.toBeInTheDocument();
    expect(await screen.findByAltText(/AI 生图结果 1/)).toHaveAttribute(
      'src',
      'https://example.test/restored-success.png',
    );
    expect(mockRequest.post).not.toHaveBeenCalled();
    expect(mockRequest.postMultiPart).not.toHaveBeenCalled();
  });

  it('restores and downloads a durable result through authenticated requests', async () => {
    jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:authenticated-v3-result');
    mockRequest.getResponse.mockResolvedValue({
      data: new Blob([pngBytes], { type: 'image/png' }),
      headers: { 'content-type': 'image/png' },
      status: 200,
    } as never);
    storeAsyncImageTasks([
      {
        taskId: 'frontend-v3-success-1',
        internalTaskId: 'internal-v3-success-1',
        status: 'success',
        state: 'success',
      },
    ]);
    mockRequest.get.mockResolvedValueOnce(imageGenerationConfigResponse()).mockResolvedValueOnce({
      state: 'success',
      status: 'succeeded',
      internalTaskId: 'internal-v3-success-1',
      requestId: 'request-v3-success-1',
      submittedToProvider: true,
      provider: 'fal',
      model: 'openai/gpt-image-2/edit',
      images: [{ url: '/api/image-generation/tasks/internal-v3-success-1/result-image' }],
    });

    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation();
    const fetchSpy = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchSpy,
    });
    renderImageGeneration();

    expect(await screen.findByText(/任务 1 状态：已完成/)).toBeInTheDocument();
    expect(screen.queryByText('AI 正在生成图片，请稍等')).not.toBeInTheDocument();
    expect(await screen.findByAltText(/AI 生图结果 1/)).toBeInTheDocument();
    expect(mockRequest.getResponse).toHaveBeenCalledWith(
      '/api/image-generation/tasks/internal-v3-success-1/result-image',
      expect.objectContaining({ responseType: 'blob' }),
    );
    fireEvent.click(screen.getByRole('link', { name: '下载' }));
    await waitFor(() => expect(mockRequest.getResponse).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['apimart', 'gpt-image-2', 'PROVIDER_FAILED', 'Provider 生成失败', true],
    [
      'fal',
      'openai/gpt-image-2.5/flare/edit',
      'FAL_BALANCE_EXHAUSTED',
      '当前生图服务余额不足，请联系管理员充值后重试。此任务尚未提交生成。',
      false,
    ],
  ])(
    'restores a failed %s task after refresh without automatically resubmitting',
    async (provider, model, errorCode, message, submittedToProvider) => {
      storeAsyncImageTasks([
        {
          taskId: 'frontend-failed-1',
          internalTaskId: 'internal-failed-1',
          status: 'failed',
          state: 'failed',
        },
      ]);
      mockRequest.get.mockResolvedValueOnce(imageGenerationConfigResponse()).mockResolvedValueOnce({
        state: 'failed',
        status: 'failed',
        internalTaskId: 'internal-failed-1',
        requestId: 'request-failed-1',
        submittedToProvider,
        provider,
        model,
        message,
        errorCode,
        images: [],
      });

      renderImageGeneration();

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
      expect(screen.queryByText('AI 正在生成图片，请稍等')).not.toBeInTheDocument();
      expect(mockRequest.post).not.toHaveBeenCalled();
      expect(mockRequest.postMultiPart).not.toHaveBeenCalled();
    },
  );

  it('restores a degraded APIMart task as terminal failure without resuming polling', async () => {
    storeAsyncImageTasks([
      {
        taskId: 'frontend-degraded-1',
        internalTaskId: 'internal-degraded-1',
        status: 'degraded',
        state: 'degraded',
      },
    ]);
    mockRequest.get.mockResolvedValueOnce(imageGenerationConfigResponse()).mockResolvedValueOnce({
      state: 'degraded',
      internalTaskId: 'internal-degraded-1',
      requestId: 'request-degraded-1',
      submittedToProvider: true,
      provider: 'apimart',
      model: 'gpt-image-2',
      message: '生成任务已超时',
      errorCode: 'IMAGE_GENERATION_TIMEOUT',
      images: [],
    });

    renderImageGeneration();

    expect(await screen.findByText('生成超时，本次任务已结束，请重新生成。')).toBeInTheDocument();
    expect(screen.getByText(/任务 1 状态：需要重试/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.queryByText('AI 正在生成图片，请稍等')).not.toBeInTheDocument();
    expect(mockRequest.get).toHaveBeenCalledTimes(2);
    expect(mockRequest.post).not.toHaveBeenCalled();
    expect(mockRequest.postMultiPart).not.toHaveBeenCalled();
  });

  it('restores multiple async APIMart tasks after refresh without mixing results', async () => {
    storeAsyncImageTasks([
      {
        taskId: 'frontend-multi-waiting',
        internalTaskId: 'internal-multi-waiting',
        status: 'running',
        state: 'server_waiting',
      },
      {
        taskId: 'frontend-multi-polling',
        internalTaskId: 'internal-multi-polling',
        status: 'running',
        state: 'polling',
      },
      {
        taskId: 'frontend-multi-success',
        internalTaskId: 'internal-multi-success',
        status: 'success',
        state: 'success',
      },
    ]);
    const statusesByTask = new Map<string, Array<Record<string, unknown>>>([
      [
        'internal-multi-waiting',
        [
          {
            state: 'waiting',
            status: 'waiting',
            internalTaskId: 'internal-multi-waiting',
            requestId: 'request-multi-waiting',
            submittedToProvider: false,
            provider: 'apimart',
            model: 'gpt-image-2',
            images: [],
          },
        ],
      ],
      [
        'internal-multi-polling',
        [
          {
            state: 'running',
            status: 'polling',
            internalTaskId: 'internal-multi-polling',
            requestId: 'request-multi-polling',
            submittedToProvider: true,
            provider: 'apimart',
            model: 'gpt-image-2',
            images: [],
          },
        ],
      ],
      [
        'internal-multi-success',
        [
          {
            state: 'success',
            status: 'succeeded',
            internalTaskId: 'internal-multi-success',
            requestId: 'request-multi-success',
            submittedToProvider: true,
            provider: 'apimart',
            model: 'gpt-image-2',
            images: [{ url: 'https://example.test/restored-third.png' }],
          },
        ],
      ],
    ]);
    mockRequest.get.mockImplementation((url) => {
      if (url === '/api/image-generation/config') {
        return Promise.resolve(imageGenerationConfigResponse());
      }
      const internalTaskId = String(url).split('/').pop() ?? '';
      const statuses = statusesByTask.get(internalTaskId);
      if (!statuses?.length) {
        return Promise.reject(new Error(`unexpected task status request: ${url}`));
      }
      return Promise.resolve(statuses[0]);
    });

    renderImageGeneration();

    expect(await screen.findByText(/任务 1 状态：排队中/)).toBeInTheDocument();
    expect(await screen.findByText(/任务 2 状态：结果查询中/)).toBeInTheDocument();
    expect(await screen.findByText(/任务 3 状态：已完成/)).toBeInTheDocument();
    expect(await screen.findByAltText(/AI 生图结果 1/)).toHaveAttribute(
      'src',
      'https://example.test/restored-third.png',
    );
    expect(mockRequest.post).not.toHaveBeenCalled();
    expect(mockRequest.postMultiPart).not.toHaveBeenCalled();
  });

  it('clears the browser lease after the current tab receives a confirmed failure', async () => {
    await renderSingleTextToImage();

    mockRequest.post.mockRejectedValue({
      response: {
        status: 500,
        data: { message: '生成服务暂时异常，请稍后再试。', errorCode: '500', state: 'failed' },
      },
    });
    fireEvent.change(screen.getByLabelText('提示词'), {
      target: { value: '白色保温杯，办公室场景' },
    });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));

    await waitFor(() => {
      expect(screen.getByText('生成服务暂时异常，请稍后再试。')).toBeInTheDocument();
    });
    expect(localStorage.getItem(IMAGE_GENERATION_LEASE_STORAGE_KEY)).toBeNull();
  });

  it('keeps an unknown browser lease after the current tab reaches the hard wait', async () => {
    jest.useFakeTimers();
    await renderDualProductReplace();
    await fillThreeImages();

    mockRequest.postMultiPart.mockImplementationOnce(() => new Promise(() => undefined));
    enqueueDualProductReplaceTask();

    await waitFor(() => {
      expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);
    });

    advancePastApimartMultiReferenceHardWait();

    await waitFor(() => {
      expect(screen.getByText(/当前无法确认任务是否已被后端或 Provider 接收/)).toBeInTheDocument();
    });
    const unknownLease = Object.values(readStoredLeaseRegistry()).find(
      (lease) => lease.taskType === 'dual-product-replace',
    );
    expect(unknownLease).toEqual(
      expect.objectContaining({
        taskType: 'dual-product-replace',
        status: 'status_unknown',
      }),
    );
    expect(unknownLease?.leaseExpiresAt).toBeGreaterThan(Date.now());
  });

  it('automatically starts an already queued task when a racing foreign lease is released', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    let occupiedLeases: TestGenerationLease[] = [];
    const requestLock = jest.fn(
      async (_name: string, _options: object, callback: () => unknown) => {
        if (requestLock.mock.calls.length === 1) {
          occupiedLeases = storeForeignLeases(IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT);
        }
        return callback();
      },
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: requestLock },
    });
    try {
      storeForeignLeases(IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT - 1);
      await renderSingleTextToImage();
      fireEvent.change(screen.getByLabelText('提示词'), {
        target: { value: 'already queued before lock contention' },
      });
      fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));
      await screen.findAllByText(IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE);
      expect(mockRequest.post).not.toHaveBeenCalled();
      const attemptsWhileFull = requestLock.mock.calls.length;
      await act(async () => {
        await Promise.resolve();
      });
      expect(requestLock).toHaveBeenCalledTimes(attemptsWhileFull);
      const [released, ...remaining] = occupiedLeases;
      writeStoredLeaseRegistry(remaining);
      act(() => {
        FakeBroadcastChannel.emit({
          type: IMAGE_GENERATION_LEASE_CLEARED_MESSAGE,
          localTaskId: released.localTaskId,
          tabSessionId: released.tabSessionId,
        });
      });
      expect(await screen.findByAltText(/AI 生图结果 1/)).toBeInTheDocument();
      expect(mockRequest.post).toHaveBeenCalledTimes(1);
      expect(mockRequest.post.mock.calls[0][1]).toEqual(
        expect.objectContaining({ prompt: 'already queued before lock contention' }),
      );
      expect(screen.getAllByText(/任务 \d+ 状态/)).toHaveLength(1);
    } finally {
      Object.defineProperty(
        navigator,
        'locks',
        originalLocks ?? { configurable: true, value: undefined },
      );
    }
  });

  it('restores ordinary enqueue without refresh after one of seven foreign leases is cleared', async () => {
    const leases = storeForeignLeases(IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT);
    const [clearedLease, ...remainingLeases] = leases;
    await renderSingleTextToImage();

    await waitFor(() => {
      expect(screen.getByText(IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE)).toBeInTheDocument();
    });
    const enqueueButton = screen.getByRole('button', { name: /加入生成队列/ });
    expect(enqueueButton).toBeDisabled();

    writeStoredLeaseRegistry(remainingLeases);
    act(() => {
      FakeBroadcastChannel.emit({
        type: IMAGE_GENERATION_LEASE_CLEARED_MESSAGE,
        localTaskId: clearedLease.localTaskId,
        tabSessionId: clearedLease.tabSessionId,
      });
    });

    await waitFor(() => {
      expect(screen.getByText(crossTabAvailabilityMessage(6))).toBeInTheDocument();
    });
    expect(enqueueButton).not.toBeDisabled();
  });

  it('counts status_unknown leases toward the cross-tab concurrency limit', async () => {
    storeForeignLeases(IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT, { status: 'status_unknown' });
    await renderSingleTextToImage();

    await waitFor(() => {
      expect(screen.getByText(IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /加入生成队列/ })).toBeDisabled();
  });

  it('releases the browser-side concurrency slot when the foreign lease expires', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-28T00:00:00Z'));
    storeForeignLeases(IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT, {
      startedAt: Date.now(),
      leaseExpiresAt: Date.now() + 1000,
    });
    await renderSingleTextToImage();

    await waitFor(() => {
      expect(screen.getByText(IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE)).toBeInTheDocument();
    });
    const enqueueButton = screen.getByRole('button', { name: /加入生成队列/ });
    expect(enqueueButton).toBeDisabled();

    act(() => {
      jest.advanceTimersByTime(1100);
    });

    await waitFor(() => {
      expect(
        screen.queryByText(IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE),
      ).not.toBeInTheDocument();
    });
    expect(enqueueButton).not.toBeDisabled();
  });

  it('uses localStorage as the cross-tab lease fallback when BroadcastChannel is unavailable', async () => {
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    storeForeignLease();

    await renderSingleTextToImage();

    await waitFor(() => {
      expect(screen.getByText(crossTabAvailabilityMessage(1))).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /加入生成队列/ })).not.toBeDisabled();
  });

  it('removes an unknown task only after the user confirms it is a local-only action', async () => {
    jest.useFakeTimers();
    await renderDualProductReplace();
    await fillThreeImages();

    mockRequest.postMultiPart.mockImplementationOnce(() => new Promise(() => undefined));
    enqueueDualProductReplaceTask();

    await waitFor(() => {
      expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);
    });

    advancePastApimartMultiReferenceHardWait();

    await waitFor(() => {
      expect(screen.getByText(/当前无法确认任务是否已被后端或 Provider 接收/)).toBeInTheDocument();
    });
    const enqueueButton = screen.getByRole('button', { name: /加入生成队列/ });
    expect(enqueueButton).toBeDisabled();

    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '移除本地记录' }));

    expect(confirm).toHaveBeenCalledWith(
      '此操作只移除本地任务记录，不会取消可能仍在远端执行的任务。',
    );
    expect(screen.getByText(/当前无法确认任务是否已被后端或 Provider 接收/)).toBeInTheDocument();
    expect(enqueueButton).toBeDisabled();
    expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '移除本地记录' }));

    await waitFor(() => {
      expect(
        screen.queryByText(/当前无法确认任务是否已被后端或 Provider 接收/),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /加入生成队列/ })).not.toBeDisabled();
    expect(screen.queryByText(/已取消/)).not.toBeInTheDocument();
    expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);
  });

  it('does not resume a paused queue when the user cancels the risk confirmation', async () => {
    jest.useFakeTimers();
    await renderDualProductReplace();
    await fillThreeImages();

    mockRequest.postMultiPart
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({ images: [{ url: 'https://example.test/second.png' }] });

    enqueueDualProductReplaceTask();
    fireEvent.change(screen.getByLabelText('生成需求'), { target: { value: '第二个任务' } });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));

    await waitFor(() => {
      expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);
    });

    advancePastApimartMultiReferenceHardWait();

    await waitFor(() => {
      expect(screen.getByText(/队列已暂停/)).toBeInTheDocument();
    });

    jest.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '确认风险并继续队列' }));

    expect(mockRequest.postMultiPart).toHaveBeenCalledTimes(1);
    expect(screen.queryByAltText(/AI 生图结果/)).not.toBeInTheDocument();
    expect(screen.getByText(/队列已暂停/)).toBeInTheDocument();
  });

  it.each([
    [401, '登录状态已过期，请重新登录后再试。'],
    [429, '请求过于频繁，请稍后再试。'],
    [500, '生成服务暂时异常，请稍后再试。'],
  ])('releases the queue when the image request returns %s', async (status, message) => {
    await renderDualProductReplace();
    await fillThreeImages();

    mockRequest.postMultiPart.mockRejectedValue({
      response: {
        status,
        data: { message, errorCode: String(status), state: 'failed', requestId: `req-${status}` },
      },
    });
    enqueueDualProductReplaceTask();

    await waitFor(() => {
      expect(screen.getByText(message)).toBeInTheDocument();
    });
    expect(screen.queryByText('AI 正在生成图片，请稍等')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(
      screen.queryByText(/当前无法确认任务是否已被后端或 Provider 接收/),
    ).not.toBeInTheDocument();
  });

  it.each([
    [
      'degraded timeout',
      'degraded',
      'IMAGE_GENERATION_TIMEOUT',
      '生成超时，本次任务已结束，请重新生成。',
    ],
    ['APIMart submit timeout', 'degraded', 'APIMART_IMAGE_SUBMIT_TIMEOUT', 'APIMart 提交超时'],
    ['output fetch failure', 'degraded', 'IMAGE_OUTPUT_FETCH_FAILED', '结果图片获取失败'],
    ['Fal network failure', 'degraded', 'FAL_NETWORK_ERROR', 'Fal 网络连接失败'],
    ['generic terminal failure', 'failed', 'UPSTREAM_TERMINAL_FAILURE', '上游已明确返回失败'],
  ])(
    'ends loading and enables retry for %s',
    async (_caseName, state, errorCode, expectedMessage) => {
      await renderDualProductReplace();
      await fillThreeImages();

      mockRequest.postMultiPart.mockRejectedValue({
        response: {
          status: 502,
          data: {
            message: expectedMessage,
            errorCode,
            state,
            requestId: `req-${errorCode}`,
          },
        },
      });
      enqueueDualProductReplaceTask();

      await waitFor(() => {
        expect(screen.getByText(expectedMessage)).toBeInTheDocument();
      });
      expect(screen.getByText(/任务 1 状态：需要重试/)).toBeInTheDocument();
      expect(screen.queryByText('AI 正在生成图片，请稍等')).not.toBeInTheDocument();
      expect(screen.queryByText(/生成中（稍慢）/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    },
  );

  it('releases the queue when the image request rejects before a response exists', async () => {
    await renderDualProductReplace();
    await fillThreeImages();

    mockRequest.postMultiPart.mockRejectedValue(new Error('Network Error'));
    enqueueDualProductReplaceTask();

    await waitFor(() => {
      expect(screen.getByText('Network Error')).toBeInTheDocument();
    });
    expect(screen.queryByText('AI 正在生成图片，请稍等')).not.toBeInTheDocument();
  });

  it('ignores non-image paste without showing the image limit warning', async () => {
    await renderDualProductReplace();
    await fillThreeImages();

    const panel = screen.getByText('任务类型').closest('section');
    if (!panel) {
      throw new Error('Missing generation panel');
    }
    fireEvent.paste(panel, {
      clipboardData: clipboardData([textFile('notes.txt')]),
    });

    expect(mockShowToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('3/3') }),
    );
  });

  it('fills only remaining slots on multi-image paste and reports overflow', async () => {
    await renderDualProductReplace();
    uploadSlot('上传商品图', imageFile('product.png'));

    pasteImages([imageFile('ref-1.png'), imageFile('ref-2.png'), imageFile('extra.png')]);

    expect(screen.getByText('参考图 1：ref-1.png')).toBeInTheDocument();
    expect(screen.getByText('商品图：product.png')).toBeInTheDocument();
    expect(screen.getByText('参考图 2：ref-2.png')).toBeInTheDocument();
    expect(screen.queryByText(/extra\.png/)).not.toBeInTheDocument();
    expect(lastToastMessage()).toBe('已使用 3/3 张图，本次有 1 张未加入。');
  });

  it('revokes object URLs when deleting, replacing, clearing, and unmounting', async () => {
    const { revokeObjectURL, unmount } = await renderDualProductReplace();
    uploadSlot('上传参考图 1', imageFile('ref-1.png'));
    await screen.findByText('参考图 1：ref-1.png');

    fireEvent.click(screen.getByRole('button', { name: '删除参考图 1' }));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:ref-1.png'));

    uploadSlot('上传商品图', imageFile('product.png'));
    await screen.findByText('商品图：product.png');
    fireEvent.click(screen.getByRole('button', { name: /选择商品图作为粘贴替换目标/ }));
    pasteImages([imageFile('product-next.png')]);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:product.png'));

    fireEvent.click(screen.getByRole('button', { name: '清空全部' }));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:product-next.png'));

    uploadSlot('上传参考图 2', imageFile('ref-2.png'));
    await screen.findByText('参考图 2：ref-2.png');
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:ref-2.png');
  });

  it('uploads a generated result as a SKU source from the single-image result card', async () => {
    await renderSingleTextToImage([{ b64_json: 'data:image/png;base64,iVBORw0KGgo=' }]);

    fireEvent.click(screen.getByRole('button', { name: '单图改图' }));
    const uploadLabel = screen.getByText('点击上传 / 拖拽图片到这里 / 粘贴图片').closest('label');
    expect(uploadLabel).not.toBeNull();
    fireEvent.change(uploadLabel!.querySelector('input[type="file"]')!, {
      target: { files: [imageFile('source.png')] },
    });
    mockRequest.postMultiPart.mockResolvedValue({
      images: [{ b64_json: 'data:image/png;base64,iVBORw0KGgo=' }],
    });

    fireEvent.change(screen.getByLabelText('生成需求'), {
      target: { value: '白色保温杯，办公室场景' },
    });
    fireEvent.click(screen.getByRole('button', { name: /加入生成队列|开始生成/ }));

    await screen.findByAltText(/AI 生图结果 1/);
    fireEvent.click(screen.getByRole('button', { name: '制作 SKU 图' }));

    await waitFor(() => {
      expect(mockUploadSkuFile).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'image/png' }),
        'source',
      );
    });
  });

  it('hydrates a SKU result into the single-image edit input', async () => {
    mockRequest.get.mockResolvedValue({
      platforms: ['通用'],
      imageTypes: ['通用营销图'],
      aspectRatios: ['1:1', '4:5'],
      counts: [1, 2, 4],
      models: [{ label: '快速生图', value: 'Qwen/Qwen-Image' }],
      editModels: [
        { label: 'GPT Image 2（高质量）', value: 'apimart_gpt_image_2', model: 'gpt-image-2' },
      ],
      defaultAspectRatios: { 通用营销图: '4:5' },
      platformTypeAspectRatios: {},
      outputQualities: [],
      defaultOutputQuality: 'standard',
    });
    mockLoadSkuFileObjectUrl.mockResolvedValue('blob:sku-result');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: jest.fn(() => 'blob:sku-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: true,
        blob: async () => new Blob(['sku'], { type: 'image/png' }),
      }),
    });

    renderImageGeneration(<ImageGeneration />, [
      '/image-generation?sourceFileId=sku-1&sourceType=sku-result',
    ]);

    await waitFor(() => {
      expect(mockToastCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          message: '已带入 SKU 结果，可继续单图改图。',
        }),
      );
    });
    expect(screen.getByRole('button', { name: '单图改图' })).toHaveClass('bg-surface-active-alt');
    expect(await screen.findByAltText('白底图预览')).toHaveAttribute('src', 'blob:sku-preview');
    expect(mockLoadSkuFileObjectUrl).toHaveBeenCalledWith('sku-1');
  });
});
