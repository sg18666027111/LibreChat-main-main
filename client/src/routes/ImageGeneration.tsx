/* eslint-disable i18next/no-literal-string, no-nested-ternary, @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  ImageIcon,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Settings,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { useToastContext } from '@librechat/client';
import { request, SystemRoles } from 'librechat-data-provider';
import PromptTemplateExample from './ImageGeneration/PromptTemplateExample';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ClipboardEvent, DragEvent, MouseEvent } from 'react';
import {
  getBatchItemErrorMessage,
  type BatchResultErrorKind,
} from './ImageGeneration/batchErrorMessages';
import {
  createBatchResultImage,
  getBatchResultRecoveryUrl,
  getBatchRetryAction,
  getBatchStatusPresentation,
  getBatchTaskStatusPresentation,
  isBatchResultFileUrl,
} from './ImageGeneration/batchResultPresentation';
import {
  isProviderSubmitUnknownItem,
  mergePackagingBatchState,
  shouldPollPackagingBatch,
} from './ImageGeneration/batchPollingState';
import {
  getGenerationCountNotice,
  getSupportedGenerationCounts,
  normalizeGenerationCount,
} from './ImageGeneration/counts';
import {
  DEFAULT_OUTPUT_QUALITY,
  OUTPUT_QUALITY_OPTIONS,
  appendOutputQuality,
  buildTextToImagePayload,
  getTaskOutputQuality,
  normalizeOutputQuality,
  shouldAttachOutputQuality,
  type OutputQuality,
} from './ImageGeneration/outputQuality';
import {
  IMAGE_GENERATION_CLIENT_TIMEOUT_ERROR_CODE,
  IMAGE_GENERATION_CLIENT_TIMEOUT_MESSAGE,
  IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE,
  IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT,
  IMAGE_GENERATION_CROSS_TAB_DUPLICATE_MESSAGE,
  IMAGE_GENERATION_LEASE_STORAGE_KEY,
  IMAGE_GENERATION_CLIENT_SOFT_WAIT_MESSAGE,
  IMAGE_GENERATION_LOCAL_ABORT_ERROR_CODE,
  IMAGE_GENERATION_LOCAL_ABORT_MESSAGE,
  claimImageGenerationLease,
  clearImageGenerationLease,
  createImageGenerationJobFingerprint,
  createImageGenerationLease,
  getActiveImageGenerationLeases,
  getImageGenerationClientWaitConfig,
  getImageGenerationTabSessionId,
  type ImageGenerationLease,
  isImageGenerationClientWaitError,
  logImageGenerationLivenessEvent,
  subscribeImageGenerationLease,
  withImageGenerationClientWait,
  writeImageGenerationLease,
} from './ImageGeneration/queueLiveness';
import { useAuthContext, useLocalize } from '~/hooks';
import {
  createImageObjectUrlFromSource,
  downloadImageAsset,
  imageSourceToFile,
  type ImageBlobResponse,
} from '~/utils/downloadFile';
import { loadSkuFileObjectUrl, uploadSkuFile } from './SkuGeneration/api';

type TaskType = 'text-to-image' | 'image-to-image' | 'dual-product-replace' | 'white-background';
type GenerationTab = 'single' | 'batch-packaging';
type PackagingBatchMode = 't2i' | 'i2i';
type PackagingBatchItemStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
type MultiReferenceSlotId = 'benchmark' | 'product' | 'extraReference';

type ImagePromptTemplate = {
  exampleImageUrl?: string;
  id: string;
  _id?: string;
  key: string;
  name: string;
  description?: string;
  category: 'batch_packaging';
  templateRole: 'global_business' | 'packaging_style';
  taskType?: string;
  prompt: string;
  defaultPrompt?: string;
  formattedPrompt?: string;
  activePromptSource?: 'original' | 'formatted';
  formatWarnings?: string[];
  formattedAt?: string;
  formattedBy?: string;
  platform?: string;
  imageType?: string;
  isSystem: boolean;
  isEnabled: boolean;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
};

type ImagePromptTemplateUserPermissions = {
  imagePromptTemplates?: {
    manage?: boolean;
  };
};

type PromptTemplateDraftState = 'existing' | 'new-unsaved' | 'created-pending-list-sync';

type FetchPromptTemplatesOptions = {
  preserveSelectedTemplateId?: string;
};

type GeneratedImage = {
  url?: string | null;
  b64_json?: string | null;
  proxiedUrl?: string | null;
  downloadUrl?: string | null;
  width?: number | null;
  height?: number | null;
};

const IMAGE_GENERATION_CONTINUE_QUEUE_RISK_MESSAGE =
  '当前任务状态无法确认，远端可能仍在生成。继续提交可能产生重复任务和额外费用。';
const IMAGE_GENERATION_REMOVE_UNKNOWN_TASK_MESSAGE =
  '此操作只移除本地任务记录，不会取消可能仍在远端执行的任务。';

function getImageGenerationCrossTabAvailabilityMessage(activeCount: number) {
  return `其他页面有 ${activeCount} 个任务正在生成，当前还可并行 ${
    IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT - activeCount
  } 个任务。`;
}

type QueueTaskStatus =
  | 'waiting'
  | 'server_waiting'
  | 'submitting'
  | 'submitted'
  | 'polling'
  | 'running'
  | 'success'
  | 'degraded'
  | 'failed'
  | 'cancelled'
  | 'status_unknown'
  | 'client_timeout'
  | 'cancelled_local';

type QueueInputImage = {
  role: string;
  name: string;
  previewUrl: string;
  file: File;
};

type ImageQueueTask = {
  taskId: string;
  taskType: TaskType;
  state?: QueueTaskStatus | string | null;
  modelKey?: string;
  platform: string;
  imageType: string;
  model: string;
  prompt: string;
  aspectRatio: string;
  outputQuality?: OutputQuality;
  count: number;
  inputImages: QueueInputImage[];
  sourceImage?: File;
  benchmarkImage?: File;
  extraReferenceImage?: File;
  productImage?: File;
  createdAt: string;
  status: QueueTaskStatus;
  resultImages: GeneratedImage[];
  errorMessage: string;
  waitMessage?: string;
  errorCode?: string | null;
  requestId?: string | null;
  internalTaskId?: string | null;
  jobFingerprint: string;
  forceBrowserLeaseClaim?: boolean;
};

type StoredImageGenerationAsyncTask = {
  taskId: string;
  taskType: TaskType;
  state?: QueueTaskStatus | string | null;
  modelKey?: string;
  platform: string;
  imageType: string;
  model: string;
  prompt: string;
  aspectRatio: string;
  outputQuality?: OutputQuality;
  count: number;
  createdAt: string;
  status: QueueTaskStatus;
  resultImages?: GeneratedImage[];
  errorMessage?: string;
  waitMessage?: string;
  errorCode?: string | null;
  requestId?: string | null;
  internalTaskId: string;
};

type InternalImageGenerationTaskStatus =
  | 'waiting'
  | 'submitting'
  | 'submitted'
  | 'polling'
  | 'succeeded'
  | 'failed'
  | 'status_unknown'
  | 'cancelled';

type InternalImageGenerationTaskResponse = {
  state?: string | null;
  status?: InternalImageGenerationTaskStatus | string | null;
  internalTaskId?: string | null;
  requestId?: string | null;
  provider?: string | null;
  model?: string | null;
  submittedToProvider?: boolean;
  images?: GeneratedImage[];
  message?: string;
  error?: string;
  errorCode?: string | null;
};

type PackagingBatchItem = {
  itemId: string;
  templateId: string;
  templateName: string;
  prompt: string;
  status: PackagingBatchItemStatus;
  resultImages: GeneratedImage[];
  error?: string;
  errorMessage?: string;
  errorKind?: BatchResultErrorKind;
  retryMode?: 'resume_polling' | 'reprocess_result' | 'resubmit_provider';
  retryCount: number;
  provider?: string | null;
  providerStatus?: string | null;
  model?: string | null;
  modelKey?: string | null;
  submitAttempt?: number;
};

type PackagingBatchTask = {
  id: string;
  title: string;
  mode: PackagingBatchMode;
  provider?: string | null;
  modelKey?: string | null;
  model: string;
  outputSize?: string;
  outputWidth?: number;
  outputHeight?: number;
  referenceImage?: string | File;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  cancelRequested?: boolean;
  cancelledAt?: number;
  createdAt: number;
  updatedAt: number;
  items: PackagingBatchItem[];
};

type ImageGenerationConfig = {
  platforms: string[];
  imageTypes: string[];
  aspectRatios: string[];
  counts: number[];
  models: Array<{
    name?: string;
    label: string;
    modelKey?: string;
    value: string;
    provider?: string;
    model?: string;
    capabilities?: string[];
    description?: string;
    supportedCounts?: number[];
  }>;
  editModels: Array<{
    label: string;
    value: string;
    provider?: string;
    model?: string;
    capabilities?: string[];
  }>;
  defaultAspectRatios: Record<string, string>;
  platformTypeAspectRatios: Record<string, string>;
  outputQualities?: Array<{
    value: OutputQuality;
    label: string;
    description: string;
  }>;
  defaultOutputQuality?: OutputQuality;
};

const TEXT_TO_IMAGE_MODEL = 'Qwen/Qwen-Image';
const PACKAGING_BATCH_STORAGE_KEY = 'jingjicang_packaging_batch_id';
const IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY = 'jingjicang_image_generation_async_tasks';
const IMAGE_GENERATION_ASYNC_TASK_STORAGE_VERSION = 1;
const MAX_STORED_IMAGE_GENERATION_ASYNC_TASKS = 20;
const DEFAULT_EDIT_MODEL_KEY = 'fal_gpt_image_2_edit';
const SINGLE_IMAGE_EDIT_TASK = 'single-image-edit';
const MULTI_REFERENCE_TASK = 'multi-reference';
const IMAGE_GENERATION_EDIT_MODELS = [
  {
    label: 'GPT Image 2 Edit（FAL）',
    value: 'fal_gpt_image_2_edit',
    model: 'openai/gpt-image-2/edit',
    capabilities: [SINGLE_IMAGE_EDIT_TASK, MULTI_REFERENCE_TASK],
  },
  {
    label: 'GPT Image 2.5 Flare（FAL）',
    value: 'fal_gpt_image_2_5_flare_edit',
    model: 'openai/gpt-image-2.5/flare/edit',
    capabilities: [SINGLE_IMAGE_EDIT_TASK, MULTI_REFERENCE_TASK],
  },
  {
    label: 'GPT Image 2（APIMart）',
    value: 'apimart_gpt_image_2',
    model: 'gpt-image-2',
    capabilities: [SINGLE_IMAGE_EDIT_TASK, MULTI_REFERENCE_TASK],
  },
  {
    label: 'GPT Image 2.5 Sunburst',
    value: 'apimart_gpt_image_2_5_sunburst',
    model: 'gpt-image-2.5-sunburst',
    capabilities: [SINGLE_IMAGE_EDIT_TASK, MULTI_REFERENCE_TASK],
  },
  {
    label: '火山方舟 Seedream 5.0 Pro',
    value: 'ark_seedream_5_0_t2i',
    model: 'doubao-seedream-5-0-pro-260628',
    capabilities: [SINGLE_IMAGE_EDIT_TASK, MULTI_REFERENCE_TASK],
  },
];
const MAX_UPLOAD_SIZE = 8 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_MULTI_REFERENCE_IMAGES = 3;
const MULTI_REFERENCE_FULL_GUIDE = '已使用 3/3 张图。请选择一张图片进行替换，或删除后继续粘贴。';
const MULTI_REFERENCE_SLOTS: Array<{
  id: MultiReferenceSlotId;
  role: string;
  uploadLabel: string;
  uploadHint: string;
  previewAlt: string;
}> = [
  {
    id: 'product',
    role: '商品图',
    uploadLabel: '上传商品图',
    uploadHint: '点击 / 拖拽 / 粘贴，商品主体来源',
    previewAlt: '商品图预览',
  },
  {
    id: 'benchmark',
    role: '参考图 1',
    uploadLabel: '上传参考图 1',
    uploadHint: '点击 / 拖拽 / 粘贴，构图场景参考',
    previewAlt: '参考图 1 预览',
  },
  {
    id: 'extraReference',
    role: '参考图 2',
    uploadLabel: '上传参考图 2',
    uploadHint: '可选，补充风格 / 场景参考',
    previewAlt: '参考图 2 预览',
  },
];
const MULTI_REFERENCE_RENDER_ORDER: MultiReferenceSlotId[] = [
  'benchmark',
  'product',
  'extraReference',
];

function getTaskDisplayState(task: Pick<ImageQueueTask, 'state' | 'status'>) {
  const state = String(task.state || task.status || '').toLowerCase();

  if (state === 'server_waiting') {
    return '排队中';
  }

  if (state === 'waiting' || state === 'queued' || state === 'pending') {
    return '已提交';
  }

  if (state === 'submitting') {
    return '正在提交';
  }

  if (state === 'submitted') {
    return '生成中';
  }

  if (state === 'polling') {
    return '结果查询中';
  }

  if (state === 'running' || state === 'generating' || state === 'loading') {
    return '正在生成';
  }

  if (state === 'success' || state === 'completed' || state === 'done') {
    return '已完成';
  }

  if (state === 'degraded') {
    return '需要重试';
  }

  if (state === 'client_timeout' || state === 'status_unknown') {
    return '状态暂时未知';
  }

  if (state === 'cancelled_local') {
    return '已停止本地等待';
  }

  if (state === 'failed' || state === 'error') {
    return '需要重试';
  }

  return '正在生成';
}

function getTaskVisualState(task: Pick<ImageQueueTask, 'state' | 'status'>) {
  const state = String(task.state || task.status || '').toLowerCase();

  if (state === 'queued' || state === 'pending') {
    return 'waiting';
  }

  if (
    state === 'server_waiting' ||
    state === 'submitting' ||
    state === 'submitted' ||
    state === 'polling'
  ) {
    return 'running';
  }

  if (state === 'generating' || state === 'loading') {
    return 'running';
  }

  if (state === 'completed' || state === 'done') {
    return 'success';
  }

  if (state === 'error') {
    return 'failed';
  }

  if (state === 'degraded') {
    return 'failed';
  }

  if (state === 'client_timeout') {
    return 'status_unknown';
  }

  return state as QueueTaskStatus;
}

function getImageFilesFromDataTransfer(dataTransfer: DataTransfer | null) {
  if (!dataTransfer?.files?.length) {
    return [];
  }

  return Array.from(dataTransfer.files).filter((file) => file.type.startsWith('image/'));
}

function getImageFilesFromClipboard(clipboardData: DataTransfer | null) {
  if (!clipboardData) {
    return [];
  }

  const itemFiles = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  if (itemFiles.length) {
    return itemFiles;
  }

  return Array.from(clipboardData.files ?? []).filter((file) => file.type.startsWith('image/'));
}

const initialConfig: ImageGenerationConfig = {
  platforms: ['通用'],
  imageTypes: ['通用营销图'],
  aspectRatios: ['1:1', '3:4', '4:5', '16:9', '9:16'],
  counts: [1, 2, 4],
  models: [
    {
      label: 'GPT Image 2（FAL）',
      value: 'apimart_gpt_image_2_text',
      modelKey: 'apimart_gpt_image_2_text',
      model: 'openai/gpt-image-2',
      provider: 'fal',
      capabilities: ['text-to-image'],
      supportedCounts: [1],
    },
    { label: '快速生图', value: TEXT_TO_IMAGE_MODEL },
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
  ],
  editModels: IMAGE_GENERATION_EDIT_MODELS,
  defaultAspectRatios: { 通用营销图: '4:5' },
  platformTypeAspectRatios: {},
  outputQualities: OUTPUT_QUALITY_OPTIONS,
  defaultOutputQuality: DEFAULT_OUTPUT_QUALITY,
};

function getImageSrc(image: GeneratedImage) {
  return image.proxiedUrl || image.url || image.b64_json || '';
}

function getBestDownloadSource(image: GeneratedImage) {
  if (image.downloadUrl) {
    return { href: image.downloadUrl, type: 'downloadUrl' as const };
  }
  if (image.proxiedUrl) {
    return { href: image.proxiedUrl, type: 'proxiedUrl' as const };
  }
  if (image.b64_json) {
    return { href: image.b64_json, type: 'b64_json' as const };
  }
  if (image.url) {
    return { href: image.url, type: 'url' as const };
  }
  return null;
}

async function loadAuthenticatedImageBlobResponse(href: string): Promise<ImageBlobResponse> {
  const response = (await request.getResponse(href, {
    responseType: 'blob',
    headers: { Accept: 'image/*,application/json' },
  })) as { data: Blob; headers?: ImageBlobResponse['headers']; status?: number };
  return {
    data: response.data,
    headers: response.headers,
    status: response.status,
  };
}

async function triggerImageDownload(
  source: NonNullable<ReturnType<typeof getBestDownloadSource>>,
  filename: string,
  useAuthenticatedRequest = false,
) {
  const { href } = source;
  if (!href) {
    return false;
  }

  try {
    await downloadImageAsset({
      source: href,
      filename,
      responseLoader: useAuthenticatedRequest ? loadAuthenticatedImageBlobResponse : undefined,
    });
    return true;
  } catch (error) {
    console.warn('[ImageGeneration] blob download failed, opening new tab', {
      stage: 'download_failed',
      hasDownloadSource: Boolean(href),
      selectedSourceType: source.type,
      errorName: error instanceof Error ? error.name : null,
      message: error instanceof Error ? error.message.slice(0, 120) : null,
    });
    return false;
  }
}

function isSameOriginApiUrl(href: string) {
  if (!href || href.startsWith('data:') || href.startsWith('blob:')) {
    return false;
  }
  try {
    const url = new URL(href, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith('/api/');
  } catch {
    return href.startsWith('/api/');
  }
}

function getPromptTemplateId(template: ImagePromptTemplate) {
  return template.id || template._id || template.key;
}

function isGlobalBusinessTemplate(template: ImagePromptTemplate) {
  return template.templateRole === 'global_business';
}

function isPackagingStyleTemplate(template: ImagePromptTemplate) {
  return template.templateRole === 'packaging_style';
}

function canManageImagePromptTemplates(user?: {
  role?: string;
  permissions?: ImagePromptTemplateUserPermissions;
}) {
  return (
    user?.role === SystemRoles.ADMIN || user?.permissions?.imagePromptTemplates?.manage === true
  );
}

function createEmptyPromptTemplate(): ImagePromptTemplate {
  return {
    id: '',
    key: '',
    name: '',
    description: '',
    category: 'batch_packaging',
    templateRole: 'packaging_style',
    taskType: 'batch_packaging',
    prompt: '',
    defaultPrompt: '',
    formattedPrompt: '',
    activePromptSource: 'original',
    formatWarnings: [],
    platform: '通用',
    imageType: '商品主图',
    isSystem: false,
    isEnabled: true,
    sortOrder: 100,
  };
}

function PromptTemplateManager({
  templates,
  selectedTemplateId,
  loading,
  onClose,
  onReload,
  onSelect,
  onTemplateDeleted,
  onTemplateSaved,
}: {
  templates: ImagePromptTemplate[];
  selectedTemplateId: string;
  loading: boolean;
  onClose: () => void;
  onReload: (preserveSelectedTemplateId?: string) => Promise<void>;
  onSelect: (templateId: string) => void;
  onTemplateDeleted: (template: ImagePromptTemplate) => void;
  onTemplateSaved: (template: ImagePromptTemplate, isNew: boolean) => void;
}) {
  const { showToast } = useToastContext();
  const initiallySelectedTemplate =
    templates.find((template) => template.key === selectedTemplateId) ?? templates[0];
  const [activeId, setActiveId] = useState(() =>
    getPromptTemplateId(initiallySelectedTemplate ?? createEmptyPromptTemplate()),
  );
  const [draft, setDraft] = useState<ImagePromptTemplate>(
    () => initiallySelectedTemplate ?? createEmptyPromptTemplate(),
  );
  const [draftState, setDraftState] = useState<PromptTemplateDraftState>('existing');
  const exampleUpdateDraftRef = useRef<ImagePromptTemplate | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (draftState === 'new-unsaved') {
      return;
    }

    const activeTemplate = templates.find((template) => getPromptTemplateId(template) === activeId);
    if (draftState === 'created-pending-list-sync' && !activeTemplate) {
      return;
    }

    const nextTemplate = activeTemplate ?? templates[0];
    if (nextTemplate) {
      setActiveId(getPromptTemplateId(nextTemplate));
      const preservedDraft = exampleUpdateDraftRef.current;
      setDraft(
        preservedDraft && getPromptTemplateId(preservedDraft) === getPromptTemplateId(nextTemplate)
          ? preservedDraft
          : nextTemplate,
      );
      exampleUpdateDraftRef.current = null;
      setDraftState('existing');
    } else {
      setDraft(createEmptyPromptTemplate());
    }
  }, [activeId, draftState, templates]);

  const handleSelectTemplate = (template: ImagePromptTemplate) => {
    const id = getPromptTemplateId(template);
    setDraftState('existing');
    setActiveId(id);
    setDraft(template);
    if (isGlobalBusinessTemplate(template)) {
      onSelect(template.key);
    }
  };

  const handleDraftChange = (
    field: keyof ImagePromptTemplate,
    value: string | boolean | string[] | undefined,
  ) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const handleNewTemplate = () => {
    setDraftState('new-unsaved');
    setActiveId('');
    setDraft(createEmptyPromptTemplate());
  };

  const runTemplateAction = async (
    action: () => Promise<string | void>,
    successMessage: string,
    reloadFailureMessage = '操作已完成，但列表刷新失败，请稍后刷新。',
  ) => {
    setSaving(true);
    let preserveSelectedTemplateId: string | undefined;
    try {
      preserveSelectedTemplateId = (await action()) || undefined;
    } catch (err) {
      const apiError = err as { response?: { data?: { message?: string } }; message?: string };
      showToast({
        status: 'error',
        message: apiError.response?.data?.message || apiError.message || '提示词模板操作失败',
      });
      setSaving(false);
      return;
    }

    try {
      await onReload(preserveSelectedTemplateId);
      showToast({ status: 'success', message: successMessage });
    } catch {
      showToast({ status: 'warning', message: reloadFailureMessage });
    } finally {
      setSaving(false);
    }
  };

  const handleExampleChange = async (file: File | null) => {
    const id = getPromptTemplateId(draft);
    if (!id || saving) return;
    if (
      file &&
      (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
        file.size > 8 * 1024 * 1024)
    ) {
      showToast({ status: 'error', message: '请上传不超过 8MB 的 PNG、JPG/JPEG 或 WebP 图片。' });
      return;
    }
    setSaving(true);
    try {
      const url = `/api/image-generation/prompt-templates/${id}/example-image`;
      const formData = new FormData();
      if (file) formData.append('image', file);
      const response = (
        file ? await request.postMultiPart(url, formData) : await request.delete(url)
      ) as { template: ImagePromptTemplate };
      // Image changes save independently; preserve any unsaved prompt/name edits in the editor.
      setDraft((current) => {
        const next = { ...current, exampleImageUrl: response.template.exampleImageUrl };
        exampleUpdateDraftRef.current = next;
        return next;
      });
      onTemplateSaved(response.template, false);
      showToast({ status: 'success', message: file ? '图例已保存' : '图例已删除' });
    } catch (err) {
      const error = err as { response?: { data?: { message?: string } } };
      showToast({
        status: 'error',
        message: error.response?.data?.message || '图例保存失败，请重试。',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () =>
    runTemplateAction(
      async () => {
        const id = getPromptTemplateId(draft);
        const isNewTemplate = !id;
        const payload = {
          name: draft.name,
          description: draft.description || '',
          platform: draft.platform || '',
          imageType: draft.imageType || '',
          prompt: draft.prompt,
          formattedPrompt: draft.formattedPrompt || '',
          activePromptSource: draft.activePromptSource || 'original',
          formatWarnings: draft.formatWarnings || [],
          isEnabled: draft.isEnabled,
          ...(isNewTemplate ? { templateRole: draft.templateRole } : {}),
        };
        const response = id
          ? ((await request.patch(`/api/image-generation/prompt-templates/${id}`, payload)) as {
              template?: ImagePromptTemplate;
            })
          : ((await request.post('/api/image-generation/prompt-templates', payload)) as {
              template?: ImagePromptTemplate;
            });
        if (response.template) {
          const nextId = getPromptTemplateId(response.template);
          setActiveId(nextId);
          setDraft(response.template);
          onTemplateSaved(response.template, isNewTemplate);
          if (isNewTemplate) {
            setDraftState('created-pending-list-sync');
          }
          if (isGlobalBusinessTemplate(response.template)) {
            onSelect(response.template.key);
          }
          return nextId;
        }
      },
      '提示词模板已保存',
      '模板已保存，但列表刷新失败，请稍后刷新。',
    );

  const handleFormatPrompt = () =>
    runTemplateAction(async () => {
      const id = getPromptTemplateId(draft);
      if (!id) {
        throw new Error('请先保存模板，再整理格式。');
      }
      const result = (await request.post(`/api/image-generation/prompt-templates/${id}/format`, {
        save: true,
      })) as {
        originalPrompt: string;
        formattedPrompt: string;
        warnings: string[];
      };
      setDraft((current) => ({
        ...current,
        prompt: result.originalPrompt,
        formattedPrompt: result.formattedPrompt,
        formatWarnings: result.warnings,
        activePromptSource: current.activePromptSource || 'original',
      }));
    }, '格式整理版已生成');

  const handleUsePromptSource = (source: 'original' | 'formatted') =>
    runTemplateAction(
      async () => {
        const id = getPromptTemplateId(draft);
        if (!id) {
          throw new Error('请先保存模板。');
        }
        if (source === 'formatted' && !draft.formattedPrompt?.trim()) {
          throw new Error('请先生成格式整理版。');
        }
        const response = (await request.patch(`/api/image-generation/prompt-templates/${id}`, {
          activePromptSource: source,
        })) as { template?: ImagePromptTemplate };
        setDraft((current) => ({
          ...(response.template || current),
          activePromptSource: source,
        }));
      },
      source === 'formatted' ? '已采用整理版' : '已切回原始版',
    );

  const handleClearFormattedPrompt = () =>
    runTemplateAction(async () => {
      const id = getPromptTemplateId(draft);
      if (!id) {
        setDraft((current) => ({
          ...current,
          formattedPrompt: '',
          formatWarnings: [],
          activePromptSource: 'original',
        }));
        return;
      }
      const response = (await request.patch(`/api/image-generation/prompt-templates/${id}`, {
        formattedPrompt: '',
        activePromptSource: 'original',
        formatWarnings: [],
      })) as { template?: ImagePromptTemplate };
      setDraft(response.template || createEmptyPromptTemplate());
    }, '已清空整理版');

  const handleRestoreDefault = () =>
    runTemplateAction(async () => {
      const id = getPromptTemplateId(draft);
      const response = (await request.post(
        `/api/image-generation/prompt-templates/${id}/restore-default`,
        {},
      )) as { template?: ImagePromptTemplate };
      if (response.template) {
        setDraft(response.template);
      }
    }, '系统模板已恢复默认');

  const handleDelete = () =>
    runTemplateAction(async () => {
      const id = getPromptTemplateId(draft);
      await request.delete(`/api/image-generation/prompt-templates/${id}`);
      onTemplateDeleted(draft);
      setActiveId('');
      if (isGlobalBusinessTemplate(draft)) {
        onSelect('');
      }
    }, '自定义模板已删除');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6">
      <section className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border-light bg-surface-primary shadow-xl">
        <div className="flex items-center justify-between border-b border-border-light px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold">提示词模板管理</h2>
            <p className="text-xs text-text-secondary">
              格式整理不会自动改写业务内容，只会帮助分段、识别变量和提示风险。
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg border border-border-medium px-3 py-1.5 text-sm hover:bg-surface-hover"
            onClick={onClose}
            disabled={saving}
          >
            关闭
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-0 overflow-hidden md:grid-cols-[280px_1fr]">
          <aside className="min-h-0 overflow-y-auto border-b border-border-light p-4 md:border-b-0 md:border-r">
            <button
              type="button"
              className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
              onClick={handleNewTemplate}
              disabled={saving}
            >
              <Plus className="h-4 w-4" />
              新增模板
            </button>
            <div className="grid gap-2">
              {loading && <div className="text-sm text-text-secondary">模板加载中...</div>}
              {templates.map((template) => {
                const id = getPromptTemplateId(template);
                const isActive = id === getPromptTemplateId(draft);
                return (
                  <button
                    key={id}
                    type="button"
                    className={`rounded-lg border px-3 py-2 text-left text-sm ${
                      isActive
                        ? 'border-text-primary bg-surface-hover'
                        : 'border-border-light bg-surface-primary hover:bg-surface-hover'
                    }`}
                    onClick={() => handleSelectTemplate(template)}
                    disabled={saving}
                  >
                    <span className="block truncate font-medium">{template.name}</span>
                    <span className="block truncate text-xs text-text-secondary">
                      {isPackagingStyleTemplate(template) ? '包装样式模板' : '全局业务提示词'} ·{' '}
                      {template.isSystem ? '系统模板' : '自定义模板'}
                      {template.isEnabled ? '' : ' · 已停用'}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="min-h-0 overflow-y-auto p-5">
            <div className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  <span className="font-medium">模板类型</span>
                  <select
                    className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2"
                    value={draft.templateRole}
                    onChange={(event) =>
                      handleDraftChange(
                        'templateRole',
                        event.target.value as ImagePromptTemplate['templateRole'],
                      )
                    }
                    disabled={draftState !== 'new-unsaved'}
                  >
                    <option value="packaging_style">包装样式模板</option>
                    <option value="global_business">全局业务提示词</option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="font-medium">模板名称</span>
                  <input
                    className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2"
                    value={draft.name}
                    onChange={(event) => handleDraftChange('name', event.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="font-medium">平台</span>
                  <input
                    className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2"
                    value={draft.platform || ''}
                    onChange={(event) => handleDraftChange('platform', event.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="font-medium">图片类型</span>
                  <input
                    className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2"
                    value={draft.imageType || ''}
                    onChange={(event) => handleDraftChange('imageType', event.target.value)}
                  />
                </label>
                <label className="flex items-center gap-2 pt-6 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.isEnabled}
                    onChange={(event) => handleDraftChange('isEnabled', event.target.checked)}
                  />
                  启用模板
                </label>
              </div>

              <label className="grid gap-1 text-sm">
                <span className="font-medium">模板描述</span>
                <input
                  className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2"
                  value={draft.description || ''}
                  onChange={(event) => handleDraftChange('description', event.target.value)}
                />
              </label>

              <div className="grid gap-2 rounded-lg border border-border-light p-3 text-sm">
                <span className="font-medium">图例 / 示例图</span>
                <PromptTemplateExample url={draft.exampleImageUrl} name={draft.name} />
                <div className="flex flex-wrap items-center gap-2">
                  <label className="rounded-lg border border-border-medium px-3 py-1.5 hover:bg-surface-hover">
                    {draft.exampleImageUrl ? '替换图例' : '上传图例'}
                    <input
                      type="file"
                      className="sr-only"
                      accept="image/png,image/jpeg,image/webp"
                      disabled={saving || !getPromptTemplateId(draft)}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file) void handleExampleChange(file);
                      }}
                    />
                  </label>
                  {draft.exampleImageUrl && (
                    <button
                      type="button"
                      className="rounded-lg border border-border-medium px-3 py-1.5 hover:bg-surface-hover disabled:opacity-50"
                      disabled={saving}
                      onClick={() => void handleExampleChange(null)}
                    >
                      删除图例
                    </button>
                  )}
                </div>
                <span className="text-xs text-text-secondary">
                  {getPromptTemplateId(draft)
                    ? '支持 1 张 PNG、JPG/JPEG 或 WebP 图片，最大 8MB。图例操作立即保存。'
                    : '请先保存模板，再上传图例。'}
                </span>
              </div>

              <label className="grid gap-1 text-sm">
                <span className="font-medium">原始提示词</span>
                <textarea
                  className="min-h-[320px] rounded-lg border border-border-medium bg-surface-primary px-3 py-2 font-mono text-sm"
                  value={draft.prompt}
                  onChange={(event) => handleDraftChange('prompt', event.target.value)}
                />
                <span className="text-xs text-text-secondary">
                  prompt
                  原文会始终保留。出图时默认使用原始提示词，只有点击“采用整理版”后才会使用整理版。
                </span>
              </label>

              <div className="grid gap-2 rounded-lg border border-border-light bg-surface-primary-alt p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium">格式整理版</span>
                    <span className="ml-2 text-xs text-text-secondary">
                      当前使用：
                      {draft.activePromptSource === 'formatted' && draft.formattedPrompt
                        ? '整理版'
                        : '原始版'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="rounded-lg border border-border-medium px-3 py-1.5 text-xs hover:bg-surface-hover disabled:opacity-50"
                    onClick={handleFormatPrompt}
                    disabled={saving || !getPromptTemplateId(draft)}
                  >
                    整理格式
                  </button>
                </div>
                <textarea
                  className="min-h-[220px] rounded-lg border border-border-medium bg-surface-primary px-3 py-2 font-mono text-sm"
                  value={draft.formattedPrompt || ''}
                  onChange={(event) => handleDraftChange('formattedPrompt', event.target.value)}
                  placeholder="点击“整理格式”后生成结构化版本；也可以手动微调。"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-border-medium px-3 py-1.5 text-xs hover:bg-surface-hover disabled:opacity-50"
                    onClick={() => handleUsePromptSource('formatted')}
                    disabled={saving || !draft.formattedPrompt?.trim()}
                  >
                    采用整理版
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-border-medium px-3 py-1.5 text-xs hover:bg-surface-hover disabled:opacity-50"
                    onClick={() => handleUsePromptSource('original')}
                    disabled={saving}
                  >
                    使用原始版
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-border-medium px-3 py-1.5 text-xs hover:bg-surface-hover disabled:opacity-50"
                    onClick={handleClearFormattedPrompt}
                    disabled={saving || !draft.formattedPrompt}
                  >
                    清空整理版
                  </button>
                </div>
                <p className="text-xs text-text-secondary">
                  格式整理不会自动改写业务内容，不会删除、压缩、替换包装、产品、卖点、角度或食材描述。
                </p>
              </div>

              <div className="grid gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
                <span className="font-medium">风险提醒</span>
                {draft.formatWarnings?.length ? (
                  <ul className="grid gap-1">
                    {draft.formatWarnings.map((warning) => (
                      <li key={warning}>- {warning}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-xs">
                    暂无风险提醒。点击“整理格式”后会识别变量和潜在风险。
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-lg bg-text-primary px-4 py-2 text-sm font-medium text-surface-primary disabled:opacity-50"
                  onClick={handleSave}
                  disabled={saving}
                >
                  <Save className="h-4 w-4" />
                  保存
                </button>
                {draft.isSystem && (
                  <button
                    type="button"
                    className="flex items-center gap-2 rounded-lg border border-border-medium px-4 py-2 text-sm hover:bg-surface-hover disabled:opacity-50"
                    onClick={handleRestoreDefault}
                    disabled={saving}
                  >
                    <RotateCcw className="h-4 w-4" />
                    恢复默认
                  </button>
                )}
                {getPromptTemplateId(draft) && !draft.isSystem && (
                  <button
                    type="button"
                    className="flex items-center gap-2 rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:text-red-300"
                    onClick={handleDelete}
                    disabled={saving}
                  >
                    <Trash2 className="h-4 w-4" />
                    删除
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

async function imageToFile(image: GeneratedImage, filenameBase: string) {
  const candidates = [image.downloadUrl, image.proxiedUrl, image.b64_json, image.url].filter(
    (value): value is string => Boolean(value),
  );

  for (const candidate of candidates) {
    try {
      return await imageSourceToFile({
        source: candidate,
        filename: filenameBase,
        responseLoader: isSameOriginApiUrl(candidate)
          ? loadAuthenticatedImageBlobResponse
          : undefined,
      });
    } catch {
      // Try the next available source without logging image URLs/base64.
    }
  }

  throw new Error('No usable image source');
}

function getModelLabel(config: ImageGenerationConfig, value: string) {
  return config.models.find((item) => item.value === value)?.label ?? value;
}

function getEditModelLabel(config: ImageGenerationConfig, value?: string) {
  return (
    config.editModels.find((item) => item.value === value)?.label ??
    IMAGE_GENERATION_EDIT_MODELS.find((item) => item.value === value)?.label ??
    value ??
    'GPT Image 2（APIMart）'
  );
}

function getProviderModelForKey(config: ImageGenerationConfig, modelKey: string) {
  return (
    config.editModels.find((item) => item.value === modelKey)?.model ??
    IMAGE_GENERATION_EDIT_MODELS.find((item) => item.value === modelKey)?.model ??
    'gpt-image-2'
  );
}

function createTaskId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `image-task-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function getFileFingerprintDescriptor(file?: File | null) {
  if (!file) {
    return null;
  }

  return {
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  };
}

function buildImageGenerationJobFingerprintDescriptor({
  generationTab,
  taskType,
  modelKey,
  model,
  platform,
  imageType,
  prompt,
  aspectRatio,
  outputQuality,
  count,
  inputImages,
}: {
  generationTab: GenerationTab;
  taskType: TaskType;
  modelKey?: string | null;
  model?: string | null;
  platform: string;
  imageType: string;
  prompt: string;
  aspectRatio: string;
  outputQuality?: OutputQuality | null;
  count: number;
  inputImages: Array<{ role: string; file?: File | null }>;
}) {
  return {
    entry: 'standalone-image-generation',
    generationTab,
    taskType,
    modelKey: modelKey ?? null,
    model: model ?? null,
    platform,
    imageType,
    prompt,
    aspectRatio,
    outputQuality: outputQuality ?? null,
    count,
    inputImages: inputImages.map((image) => ({
      role: image.role,
      file: getFileFingerprintDescriptor(image.file),
    })),
  };
}

function buildImageGenerationTaskFingerprintDescriptor(task: ImageQueueTask) {
  return buildImageGenerationJobFingerprintDescriptor({
    generationTab: 'single',
    taskType: task.taskType,
    modelKey: task.modelKey ?? null,
    model: task.model,
    platform: task.platform,
    imageType: task.imageType,
    prompt: task.prompt,
    aspectRatio: task.aspectRatio,
    outputQuality: task.outputQuality ?? null,
    count: task.count,
    inputImages: task.inputImages.map((image) => ({ role: image.role, file: image.file })),
  });
}

function getTaskTypeLabel(taskType: TaskType) {
  if (taskType === 'image-to-image') {
    return '单图改图';
  }
  if (taskType === 'dual-product-replace') {
    return '多图商品替换';
  }
  if (taskType === 'white-background') {
    return '商品白底图生成';
  }
  return '文生图';
}

function getImageGenerationErrorMessage({
  taskType,
  errorCode,
  message,
}: {
  taskType: TaskType;
  errorCode?: string | null;
  message?: string;
}) {
  if (taskType === 'image-to-image' && errorCode === 'IMAGE_TO_IMAGE_FAILED') {
    return '图片改图失败。请检查图片是否包含水印、二维码、明显平台标识或版权标识；建议更换无水印图片后重试。';
  }

  if (errorCode === 'IMAGE_GENERATION_TIMEOUT') {
    return '生成超时，本次任务已结束，请重新生成。';
  }

  if (errorCode === IMAGE_GENERATION_CLIENT_TIMEOUT_ERROR_CODE) {
    return IMAGE_GENERATION_CLIENT_TIMEOUT_MESSAGE;
  }

  if (errorCode === IMAGE_GENERATION_LOCAL_ABORT_ERROR_CODE) {
    return IMAGE_GENERATION_LOCAL_ABORT_MESSAGE;
  }

  return message || '生成失败，请稍后重试。';
}

function isGeneratingStatus(status: QueueTaskStatus) {
  return status === 'running';
}

const INTERNAL_IMAGE_GENERATION_POLL_INTERVAL_MS = 2000;

type RunQueueTaskOptions = {
  signal?: AbortSignal;
  onStatus?: (status: InternalImageGenerationTaskResponse) => void;
};

function isInternalImageGenerationTaskResponse(
  response: unknown,
): response is InternalImageGenerationTaskResponse {
  if (!response || typeof response !== 'object') {
    return false;
  }
  const maybeResponse = response as InternalImageGenerationTaskResponse;
  return (
    typeof maybeResponse.internalTaskId === 'string' && maybeResponse.internalTaskId.length > 0
  );
}

function getInternalTaskStatus(response: InternalImageGenerationTaskResponse) {
  return String(response.status || response.state || '').toLowerCase();
}

function isInternalTaskSucceeded(response: InternalImageGenerationTaskResponse) {
  const status = getInternalTaskStatus(response);
  return status === 'succeeded' || status === 'success' || response.state === 'success';
}

function isInternalTaskTerminalError(response: InternalImageGenerationTaskResponse) {
  const status = getInternalTaskStatus(response);
  return (
    status === 'failed' ||
    status === 'degraded' ||
    status === 'status_unknown' ||
    status === 'cancelled' ||
    response.state === 'failed' ||
    response.state === 'degraded' ||
    response.state === 'status_unknown' ||
    response.state === 'cancelled'
  );
}

function getQueueStateFromInternalTaskStatus(response: InternalImageGenerationTaskResponse) {
  const status = getInternalTaskStatus(response);
  if (status === 'waiting' || status === 'queued' || status === 'pending') {
    return 'server_waiting';
  }
  if (status === 'submitting') {
    return 'submitting';
  }
  if (status === 'submitted') {
    return 'submitted';
  }
  if (status === 'polling' || status === 'running') {
    return 'polling';
  }
  if (isInternalTaskSucceeded(response)) {
    return 'success';
  }
  if (status === 'status_unknown') {
    return 'status_unknown';
  }
  if (status === 'cancelled') {
    return 'cancelled';
  }
  if (status === 'failed' || status === 'error' || status === 'degraded') {
    return 'failed';
  }
  return 'running';
}

function getInternalTaskWaitMessage(response: InternalImageGenerationTaskResponse) {
  const state = getQueueStateFromInternalTaskStatus(response);
  if (state === 'server_waiting') {
    return '排队中：等待生成资源，尚未提交供应商。';
  }
  if (state === 'submitting') {
    return '正在提交供应商。';
  }
  if (state === 'submitted') {
    return '生成中：供应商已接收。';
  }
  if (state === 'polling') {
    return '结果查询中。';
  }
  return '';
}

function createInternalTaskError(response: InternalImageGenerationTaskResponse) {
  const status = getInternalTaskStatus(response);
  const message =
    response.message ||
    response.error ||
    (status === 'status_unknown'
      ? IMAGE_GENERATION_CLIENT_TIMEOUT_MESSAGE
      : status === 'cancelled'
        ? '任务已取消。'
        : '生成失败，请稍后重试。');
  const error = new Error(message) as Error & {
    response?: {
      data: InternalImageGenerationTaskResponse;
    };
  };
  error.response = {
    data: {
      ...response,
      message,
      state: status === 'succeeded' ? 'success' : response.state || status,
      status: response.status || status,
    },
  };
  return error;
}

function isStoredImageGenerationTaskType(value: unknown): value is TaskType {
  return (
    value === 'text-to-image' ||
    value === 'image-to-image' ||
    value === 'dual-product-replace' ||
    value === 'white-background'
  );
}

function isStoredImageGenerationQueueStatus(value: unknown): value is QueueTaskStatus {
  return (
    value === 'waiting' ||
    value === 'server_waiting' ||
    value === 'submitting' ||
    value === 'submitted' ||
    value === 'polling' ||
    value === 'running' ||
    value === 'success' ||
    value === 'degraded' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'status_unknown' ||
    value === 'client_timeout' ||
    value === 'cancelled_local'
  );
}

function getImageGenerationLocalStorage() {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeStoredImageGenerationAsyncTask(
  value: unknown,
): StoredImageGenerationAsyncTask | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const task = value as Partial<StoredImageGenerationAsyncTask>;
  if (
    typeof task.taskId !== 'string' ||
    !task.taskId ||
    typeof task.internalTaskId !== 'string' ||
    !task.internalTaskId ||
    !isStoredImageGenerationTaskType(task.taskType)
  ) {
    return null;
  }

  return {
    taskId: task.taskId,
    taskType: task.taskType,
    state: task.state ?? task.status ?? 'running',
    modelKey: typeof task.modelKey === 'string' ? task.modelKey : undefined,
    platform: typeof task.platform === 'string' && task.platform ? task.platform : '通用',
    imageType: typeof task.imageType === 'string' && task.imageType ? task.imageType : '通用营销图',
    model: typeof task.model === 'string' ? task.model : '',
    prompt: typeof task.prompt === 'string' ? task.prompt : '',
    aspectRatio:
      typeof task.aspectRatio === 'string' && task.aspectRatio ? task.aspectRatio : '4:5',
    outputQuality:
      typeof task.outputQuality === 'string'
        ? normalizeOutputQuality(task.outputQuality)
        : DEFAULT_OUTPUT_QUALITY,
    count: typeof task.count === 'number' && task.count > 0 ? task.count : 1,
    createdAt:
      typeof task.createdAt === 'string' && task.createdAt
        ? task.createdAt
        : new Date().toISOString(),
    status: isStoredImageGenerationQueueStatus(task.status) ? task.status : 'running',
    resultImages: Array.isArray(task.resultImages)
      ? (task.resultImages.filter(Boolean) as GeneratedImage[])
      : [],
    errorMessage: typeof task.errorMessage === 'string' ? task.errorMessage : '',
    waitMessage: typeof task.waitMessage === 'string' ? task.waitMessage : '',
    errorCode: typeof task.errorCode === 'string' ? task.errorCode : null,
    requestId: typeof task.requestId === 'string' ? task.requestId : null,
    internalTaskId: task.internalTaskId,
  };
}

function readStoredImageGenerationAsyncTasks() {
  const storage = getImageGenerationLocalStorage();
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown[] | { tasks?: unknown[] | Record<string, unknown> };
    const rawTasks = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.tasks)
        ? parsed.tasks
        : parsed.tasks && typeof parsed.tasks === 'object'
          ? Object.values(parsed.tasks)
          : [];
    const seen = new Set<string>();
    return rawTasks
      .map(normalizeStoredImageGenerationAsyncTask)
      .filter((task): task is StoredImageGenerationAsyncTask => {
        if (!task || seen.has(task.internalTaskId)) {
          return false;
        }
        seen.add(task.internalTaskId);
        return true;
      });
  } catch {
    return [];
  }
}

function writeStoredImageGenerationAsyncTasks(tasks: StoredImageGenerationAsyncTask[]) {
  const storage = getImageGenerationLocalStorage();
  if (!storage) {
    return;
  }

  const nextTasks = tasks
    .filter((task) => task.internalTaskId)
    .slice(-MAX_STORED_IMAGE_GENERATION_ASYNC_TASKS);

  try {
    if (!nextTasks.length) {
      storage.removeItem(IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY);
      return;
    }
    storage.setItem(
      IMAGE_GENERATION_ASYNC_TASK_STORAGE_KEY,
      JSON.stringify({
        version: IMAGE_GENERATION_ASYNC_TASK_STORAGE_VERSION,
        tasks: nextTasks,
      }),
    );
  } catch {
    // localStorage can be unavailable or full; backend state remains the source of truth.
  }
}

function getQueueTaskPatchFromInternalTaskStatus(
  response: InternalImageGenerationTaskResponse,
  taskType: TaskType,
) {
  const queueState = getQueueStateFromInternalTaskStatus(response);
  const terminalError = isInternalTaskTerminalError(response);
  const status: QueueTaskStatus = isInternalTaskSucceeded(response)
    ? 'success'
    : terminalError
      ? queueState
      : 'running';
  const rawMessage =
    response.message ||
    response.error ||
    (queueState === 'status_unknown'
      ? IMAGE_GENERATION_CLIENT_TIMEOUT_MESSAGE
      : queueState === 'cancelled'
        ? '任务已取消。'
        : '生成失败，请稍后重试。');

  return {
    status,
    state: queueState,
    internalTaskId: response.internalTaskId ?? null,
    requestId: response.requestId ?? null,
    waitMessage: status === 'running' ? getInternalTaskWaitMessage(response) : '',
    errorMessage: terminalError
      ? getImageGenerationErrorMessage({
          taskType,
          errorCode: response.errorCode,
          message: rawMessage,
        })
      : '',
    errorCode: response.errorCode ?? null,
    resultImages: isInternalTaskSucceeded(response) ? (response.images ?? []) : [],
  };
}

function createStoredImageGenerationAsyncTask(
  task: ImageQueueTask,
  response?: InternalImageGenerationTaskResponse,
): StoredImageGenerationAsyncTask | null {
  const internalTaskId = response?.internalTaskId ?? task.internalTaskId;
  if (!internalTaskId) {
    return null;
  }

  const patch = response
    ? getQueueTaskPatchFromInternalTaskStatus(response, task.taskType)
    : {
        status: task.status,
        state: task.state,
        requestId: task.requestId ?? null,
        waitMessage: task.waitMessage ?? '',
        errorMessage: task.errorMessage,
        errorCode: task.errorCode ?? null,
        resultImages: task.resultImages,
      };

  return {
    taskId: task.taskId,
    taskType: task.taskType,
    state: patch.state,
    modelKey: task.modelKey,
    platform: task.platform,
    imageType: task.imageType,
    model: task.model,
    prompt: task.prompt,
    aspectRatio: task.aspectRatio,
    outputQuality: task.outputQuality ?? DEFAULT_OUTPUT_QUALITY,
    count: task.count,
    createdAt: task.createdAt,
    status: patch.status,
    resultImages: patch.resultImages,
    errorMessage: patch.errorMessage,
    waitMessage: patch.waitMessage,
    errorCode: patch.errorCode,
    requestId: patch.requestId ?? task.requestId ?? null,
    internalTaskId,
  };
}

function upsertStoredImageGenerationAsyncTask(
  task: ImageQueueTask,
  response?: InternalImageGenerationTaskResponse,
) {
  const storedTask = createStoredImageGenerationAsyncTask(task, response);
  if (!storedTask) {
    return;
  }

  const tasks = readStoredImageGenerationAsyncTasks();
  const existingIndex = tasks.findIndex(
    (item) =>
      item.taskId === storedTask.taskId || item.internalTaskId === storedTask.internalTaskId,
  );
  const nextTasks = [...tasks];
  if (existingIndex >= 0) {
    nextTasks[existingIndex] = {
      ...storedTask,
      requestId: storedTask.requestId ?? tasks[existingIndex].requestId ?? null,
    };
  } else {
    nextTasks.push(storedTask);
  }
  writeStoredImageGenerationAsyncTasks(nextTasks);
}

function removeStoredImageGenerationAsyncTask(taskId: string) {
  writeStoredImageGenerationAsyncTasks(
    readStoredImageGenerationAsyncTasks().filter((task) => task.taskId !== taskId),
  );
}

function removeStoredSuccessfulImageGenerationAsyncTasks(taskIds: string[]) {
  const removableIds = new Set(taskIds);
  if (!removableIds.size) {
    return;
  }
  writeStoredImageGenerationAsyncTasks(
    readStoredImageGenerationAsyncTasks().filter((task) => !removableIds.has(task.taskId)),
  );
}

function createQueueTaskFromStoredImageGenerationAsyncTask(
  task: StoredImageGenerationAsyncTask,
): ImageQueueTask {
  const visualState = getTaskVisualState({ status: task.status, state: task.state });
  const status =
    visualState === 'waiting' || isGeneratingStatus(visualState) ? 'running' : visualState;
  return {
    taskId: task.taskId,
    taskType: task.taskType,
    state: task.state ?? status,
    modelKey: task.modelKey,
    platform: task.platform,
    imageType: task.imageType,
    model: task.model,
    prompt: task.prompt,
    aspectRatio: task.aspectRatio,
    outputQuality: task.outputQuality,
    count: task.count,
    inputImages: [],
    createdAt: task.createdAt,
    status,
    resultImages: task.resultImages ?? [],
    errorMessage: task.errorMessage ?? '',
    waitMessage: task.waitMessage ?? '',
    errorCode: task.errorCode ?? null,
    requestId: task.requestId ?? null,
    internalTaskId: task.internalTaskId,
    jobFingerprint: `restored:${task.internalTaskId}`,
    forceBrowserLeaseClaim: false,
  };
}

function sleepForInternalTaskPoll(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
      return;
    }

    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, ms);

    const handleAbort = () => {
      window.clearTimeout(timeoutId);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Request aborted'));
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

const IMAGE_GENERATION_STATUS_QUERY_INTERRUPTED = 'IMAGE_GENERATION_STATUS_QUERY_INTERRUPTED';

async function fetchInternalGenerationTaskStatus(internalTaskId: string, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (signal?.aborted) {
        throw signal.reason;
      }
      const response = (await request.get(
        `/api/image-generation/tasks/${internalTaskId}`,
        signal ? { signal } : undefined,
      )) as InternalImageGenerationTaskResponse;
      if (signal?.aborted) {
        throw signal.reason;
      }
      return response;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      const status = (error as { response?: { status?: number } }).response?.status;
      const transient = status == null || [408, 429, 500, 502, 503, 504, 524].includes(status);
      if (!transient || attempt >= 3) {
        throw createInternalTaskError({
          internalTaskId,
          state: 'status_unknown',
          status: 'status_unknown',
          errorCode: IMAGE_GENERATION_STATUS_QUERY_INTERRUPTED,
          message: IMAGE_GENERATION_CLIENT_TIMEOUT_MESSAGE,
        });
      }
      await sleepForInternalTaskPoll(
        INTERNAL_IMAGE_GENERATION_POLL_INTERVAL_MS * (attempt + 1),
        signal,
      );
    }
  }
}

async function waitForInternalGenerationTask(
  initialResponse: InternalImageGenerationTaskResponse,
  options: RunQueueTaskOptions,
) {
  if (!initialResponse.internalTaskId) {
    return initialResponse.images ?? [];
  }

  let currentResponse = initialResponse;
  options.onStatus?.(currentResponse);

  while (!isInternalTaskSucceeded(currentResponse)) {
    if (isInternalTaskTerminalError(currentResponse)) {
      throw createInternalTaskError(currentResponse);
    }

    currentResponse = await fetchInternalGenerationTaskStatus(
      initialResponse.internalTaskId,
      options.signal,
    );
    options.onStatus?.(currentResponse);

    if (isInternalTaskSucceeded(currentResponse)) {
      break;
    }
    if (isInternalTaskTerminalError(currentResponse)) {
      throw createInternalTaskError(currentResponse);
    }

    await sleepForInternalTaskPoll(INTERNAL_IMAGE_GENERATION_POLL_INTERVAL_MS, options.signal);
  }

  return currentResponse.images ?? [];
}

async function resolveQueueTaskImages(
  response: { images?: GeneratedImage[] } | InternalImageGenerationTaskResponse,
  options: RunQueueTaskOptions,
) {
  if (isInternalImageGenerationTaskResponse(response)) {
    options.onStatus?.(response);
    if (isInternalTaskSucceeded(response)) {
      return response.images ?? [];
    }
    return waitForInternalGenerationTask(response, options);
  }

  return response.images ?? [];
}

function getPromptSummary(prompt: string) {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}

function injectPackagingTitle(templatePrompt: string, title: string) {
  return templatePrompt.replaceAll('{{title}}', title.trim());
}

function getPackagingBatchStatusLabel(status: PackagingBatchItemStatus, item?: PackagingBatchItem) {
  const presentation = item ? getBatchStatusPresentation(item) : null;
  if (presentation) {
    return presentation.label;
  }
  if (status === 'pending') {
    return '已提交';
  }
  if (status === 'running') {
    return '正在生成';
  }
  if (status === 'success') {
    return '已完成';
  }
  if (status === 'cancelled') {
    return '已取消';
  }
  return '需要重试';
}

function getPackagingTaskStatusLabel(batch: PackagingBatchTask) {
  const presentation = getBatchTaskStatusPresentation(batch.items);
  if (presentation) {
    return presentation.label;
  }
  if (batch.status === 'pending') {
    return '已提交';
  }
  if (batch.status === 'running') {
    return '正在生成';
  }
  if (batch.status === 'done') {
    return '已完成';
  }
  if (batch.status === 'cancelled') {
    return '任务已取消';
  }
  return '需要重试';
}

function normalizePackagingBatch(batch: PackagingBatchTask): PackagingBatchTask {
  return {
    ...batch,
    items: batch.items.map((item) => ({
      ...item,
      resultImages:
        item.status === 'success' && item.itemId
          ? [createBatchResultImage(batch.id, item.itemId)]
          : [],
      errorMessage: getBatchItemErrorMessage(item),
    })),
  };
}

function revokeTaskPreviews(task: ImageQueueTask) {
  task.inputImages.forEach((image) => {
    if (image.previewUrl) {
      URL.revokeObjectURL(image.previewUrl);
    }
  });
}

async function runQueueTask(task: ImageQueueTask, options: RunQueueTaskOptions = {}) {
  if (task.taskType === 'white-background') {
    const sourceImage = task.sourceImage;
    if (!sourceImage) {
      throw new Error('请先上传需要生成白底图的商品图。');
    }
    console.info('[ImageGeneration queue] running white-background task', {
      taskId: task.taskId,
      endpoint: '/api/image-generation/white-background',
      inputImageCount: 1,
    });

    const formData = new FormData();
    formData.append('frontendTaskId', task.taskId);
    formData.append('image', sourceImage);

    const response = (await request.postMultiPart(
      '/api/image-generation/white-background',
      formData,
      options.signal ? { signal: options.signal } : undefined,
    )) as { images: GeneratedImage[] } | InternalImageGenerationTaskResponse;
    return resolveQueueTaskImages(response, options);
  }

  if (task.taskType === 'image-to-image') {
    const sourceImage = task.sourceImage;
    if (!sourceImage) {
      throw new Error('请先上传白底图。');
    }
    console.info('[ImageGeneration queue] running image-to-image task', {
      taskId: task.taskId,
      endpoint: '/api/image-generation/image-to-image',
      inputImageCount: 1,
      modelKey: task.modelKey,
      model: task.model,
    });

    const formData = new FormData();
    formData.append('frontendTaskId', task.taskId);
    formData.append('image', sourceImage);
    formData.append('platform', task.platform);
    formData.append('imageType', task.imageType);
    if (task.modelKey) {
      formData.append('modelKey', task.modelKey);
    }
    formData.append('model', task.model);
    formData.append('prompt', task.prompt);
    formData.append('aspectRatio', task.aspectRatio);
    appendOutputQuality(formData, task.outputQuality ?? DEFAULT_OUTPUT_QUALITY);
    formData.append('count', '1');

    const response = (await request.postMultiPart(
      '/api/image-generation/image-to-image',
      formData,
      options.signal ? { signal: options.signal } : undefined,
    )) as
      | {
          images: GeneratedImage[];
        }
      | InternalImageGenerationTaskResponse;
    return resolveQueueTaskImages(response, options);
  }

  if (task.taskType === 'dual-product-replace') {
    const benchmarkImage = task.benchmarkImage;
    const productImage = task.productImage;
    const extraReferenceImage = task.extraReferenceImage;
    if (!benchmarkImage || !productImage) {
      throw new Error('多图商品替换需要上传 1 张商品图和至少 1 张对标/参考图。');
    }
    console.info('[ImageGeneration queue] running dual-product-replace task', {
      taskId: task.taskId,
      endpoint: '/api/image-generation/multi-reference',
      inputImageCount: 2,
      modelKey: task.modelKey,
      model: task.model,
    });

    const formData = new FormData();
    formData.append('frontendTaskId', task.taskId);
    formData.append('images', benchmarkImage);
    formData.append('images', productImage);
    if (extraReferenceImage) {
      formData.append('images', extraReferenceImage);
    }
    formData.append(
      'inputImageRoles',
      JSON.stringify(
        extraReferenceImage
          ? ['对标/参考图 1', '商品图', '对标/参考图 2']
          : ['对标/参考图 1', '商品图'],
      ),
    );
    formData.append('subMode', 'dual-product-replace');
    formData.append('platform', task.platform);
    formData.append('imageType', task.imageType);
    if (task.modelKey) {
      formData.append('modelKey', task.modelKey);
    }
    formData.append('model', task.model);
    formData.append('prompt', task.prompt);
    formData.append('aspectRatio', task.aspectRatio);
    formData.append('count', '1');

    const response = (await request.postMultiPart(
      '/api/image-generation/multi-reference',
      formData,
      options.signal ? { signal: options.signal } : undefined,
    )) as
      | {
          images: GeneratedImage[];
        }
      | InternalImageGenerationTaskResponse;
    return resolveQueueTaskImages(response, options);
  }

  console.info('[ImageGeneration queue] running text-to-image task', {
    taskId: task.taskId,
    endpoint: '/api/image-generation/text-to-image',
    inputImageCount: 0,
    model: task.model,
  });
  const response = (await request.post(
    '/api/image-generation/text-to-image',
    buildTextToImagePayload({
      platform: task.platform,
      imageType: task.imageType,
      modelKey: task.modelKey,
      model: task.model,
      frontendTaskId: task.taskId,
      prompt: task.prompt,
      aspectRatio: task.aspectRatio,
      count: task.count,
      outputQuality: task.outputQuality ?? DEFAULT_OUTPUT_QUALITY,
    }),
    options.signal ? { signal: options.signal } : undefined,
  )) as { images: GeneratedImage[] } | InternalImageGenerationTaskResponse;

  return resolveQueueTaskImages(response, options);
}

function getImageSourceChain(image: GeneratedImage) {
  return Array.from(
    new Set([image.proxiedUrl, image.url, image.b64_json].filter(Boolean)),
  ) as string[];
}

async function loadResolvedImageObjectUrl(href: string) {
  return createImageObjectUrlFromSource(href, {
    responseLoader: isSameOriginApiUrl(href) ? loadAuthenticatedImageBlobResponse : undefined,
  });
}

function ResultImage({
  image,
  index,
  downloadName,
  onUseAsSource,
  onMakeSku,
  makeSkuLabel = '制作 SKU 图',
  isStableBatchResult = false,
  onRecoverStableResult,
}: {
  image: GeneratedImage;
  index: number;
  downloadName: string;
  onUseAsSource: (image: GeneratedImage, index: number) => void;
  onMakeSku?: (image: GeneratedImage, index: number) => void;
  makeSkuLabel?: string;
  isStableBatchResult?: boolean;
  onRecoverStableResult?: () => Promise<void>;
}) {
  const { showToast } = useToastContext();
  const sources = useMemo(() => getImageSourceChain(image), [image]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>(
    sources.length ? 'loading' : 'error',
  );
  const [isRecovering, setIsRecovering] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const src = sources[sourceIndex] ?? '';
  const needsAuthenticatedFileRequest = isStableBatchResult && isBatchResultFileUrl(src);
  const needsResolvedObjectUrl = isSameOriginApiUrl(src);
  const [resolvedObjectSrc, setResolvedObjectSrc] = useState<string | null>(null);
  const usingFallbackSource = sourceIndex > 0;
  const downloadSource = useMemo(() => {
    if (!usingFallbackSource) {
      return getBestDownloadSource(image);
    }
    if (image.b64_json) {
      return { href: image.b64_json, type: 'b64_json' as const };
    }
    if (image.url) {
      return { href: image.url, type: 'url' as const };
    }
    return getBestDownloadSource(image);
  }, [image, usingFallbackSource]);
  const downloadHref = downloadSource?.href ?? '';
  const displaySrc = resolvedObjectSrc ?? src;

  useEffect(() => {
    if (!needsResolvedObjectUrl || !src) {
      setResolvedObjectSrc(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setResolvedObjectSrc(null);
    setStatus('loading');

    loadResolvedImageObjectUrl(src)
      .then((url) => {
        objectUrl = url;
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setResolvedObjectSrc(url);
      })
      .catch((error) => {
        const apiError = error as { response?: { status?: number }; message?: string };
        console.warn('[ImageGeneration] result image object URL load failed', {
          stage: 'result_image_object_url_load_failed',
          status: apiError.response?.status ?? null,
          message: apiError.message ? apiError.message.slice(0, 120) : null,
        });
        if (!cancelled) {
          setResolvedObjectSrc(null);
          setStatus('error');
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [needsResolvedObjectUrl, src, reloadNonce]);
  const shouldRenderImage =
    Boolean(displaySrc) && (!needsResolvedObjectUrl || Boolean(resolvedObjectSrc));

  const handleDownloadClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (!downloadSource) {
      showToast({ status: 'error', message: '图片下载失败，请右键图片另存为或稍后重试。' });
      return;
    }

    void triggerImageDownload(
      downloadSource,
      downloadName,
      isSameOriginApiUrl(downloadSource.href),
    ).then((ok) => {
      if (ok) {
        return;
      }
      if (downloadSource.type === 'url') {
        window.open(downloadSource.href, '_blank', 'noopener,noreferrer');
      }
      showToast({
        status: 'error',
        message:
          downloadSource.type === 'url'
            ? '图片下载失败，已尝试打开原图链接；请右键图片另存为或稍后重试。'
            : '图片下载失败，请右键图片另存为或稍后重试。',
      });
    });
  };

  const handleImageError = () => {
    if (sourceIndex < sources.length - 1) {
      console.warn('[ImageGeneration] result image source failed, trying fallback', {
        stage: 'image_load_failed',
        failedSourceIndex: sourceIndex,
        viaProxy: sourceIndex === 0 && Boolean(image.proxiedUrl),
      });
      setSourceIndex(sourceIndex + 1);
      setStatus('loading');
      return;
    }
    console.warn('[ImageGeneration] result image load failed on all sources', {
      stage: 'image_load_failed',
      sourceCount: sources.length,
    });
    setStatus('error');
  };

  const handleReload = async () => {
    if (isRecovering) {
      return;
    }
    if (onRecoverStableResult) {
      try {
        setIsRecovering(true);
        await onRecoverStableResult();
      } catch (err) {
        const apiError = err as { response?: { data?: { message?: string } }; message?: string };
        showToast({
          status: 'error',
          message:
            apiError.response?.data?.message || apiError.message || '图片恢复失败，请稍后重试。',
        });
      } finally {
        setIsRecovering(false);
      }
    }
    setSourceIndex(0);
    setStatus('loading');
    setReloadNonce((value) => value + 1);
  };

  return (
    <figure className="flex flex-col overflow-hidden rounded-lg border border-border-light bg-surface-primary-alt">
      <div className="relative flex min-h-32 w-full items-center justify-center bg-surface-primary">
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-text-secondary">
            <Loader2 className="h-5 w-5 animate-spin" />
            图片加载中...
          </div>
        )}
        {status === 'error' ? (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-sm text-text-secondary">
            <ImageIcon className="h-8 w-8" />
            <span>图片加载失败，请重新加载或下载。</span>
            {isStableBatchResult && (
              <button
                type="button"
                disabled={isRecovering}
                onClick={handleReload}
                className="flex items-center gap-1 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRecovering ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                {isRecovering ? '正在恢复图片...' : '重新加载'}
              </button>
            )}
            {downloadHref && (
              <a
                href={downloadHref}
                download={downloadName}
                onClick={handleDownloadClick}
                className="flex items-center gap-1 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
              >
                <Download className="h-4 w-4" />
                下载
              </a>
            )}
          </div>
        ) : shouldRenderImage ? (
          <img
            key={`${displaySrc}-${reloadNonce}`}
            src={displaySrc}
            alt={`AI 生图结果 ${index + 1}`}
            loading="lazy"
            className={[
              'max-h-[28rem] w-full object-contain transition-opacity',
              status === 'loaded' ? 'opacity-100' : 'opacity-0',
            ].join(' ')}
            onLoad={() => setStatus('loaded')}
            onError={handleImageError}
          />
        ) : null}
      </div>
      <figcaption className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
        <span className="text-sm text-text-secondary">结果 {index + 1}</span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onUseAsSource(image, index)}
            className="rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
          >
            基于此图修改
          </button>
          {onMakeSku && (
            <button
              type="button"
              onClick={() => onMakeSku(image, index)}
              className="rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
            >
              {makeSkuLabel}
            </button>
          )}
          <a
            href={downloadHref}
            download={downloadName}
            onClick={handleDownloadClick}
            className="flex items-center gap-1 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
          >
            <Download className="h-4 w-4" />
            下载
          </a>
        </div>
      </figcaption>
    </figure>
  );
}

export type ImageGenerationSkuSourceWorkflow = {
  onSourceReady: (payload: { fileId: string; previewObjectUrl?: string }) => void;
};

export type ImageGenerationProps = {
  /** When set, forces single-image edit and returns the result into the SKU workbench. */
  skuSourceWorkflow?: ImageGenerationSkuSourceWorkflow;
};

export default function ImageGeneration({ skuSourceWorkflow }: ImageGenerationProps = {}) {
  const { showToast } = useToastContext();
  const { user } = useAuthContext();
  const localize = useLocalize();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sourceFileId = searchParams.get('sourceFileId') || '';
  const sourceType = searchParams.get('sourceType') || '';
  const isSkuSourceWorkflow = Boolean(skuSourceWorkflow);
  const [config, setConfig] = useState<ImageGenerationConfig>(initialConfig);
  const [generationTab, setGenerationTab] = useState<GenerationTab>('single');
  const [taskType, setTaskType] = useState<TaskType>(
    isSkuSourceWorkflow ? 'image-to-image' : 'text-to-image',
  );
  const [platform, setPlatform] = useState('通用');
  const [imageType, setImageType] = useState('通用营销图');
  const [model, setModel] = useState(TEXT_TO_IMAGE_MODEL);
  const [editModelKey, setEditModelKey] = useState(DEFAULT_EDIT_MODEL_KEY);
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('4:5');
  const [outputQuality, setOutputQuality] = useState<OutputQuality>(DEFAULT_OUTPUT_QUALITY);
  const [count, setCount] = useState(1);
  const [whiteBackgroundImage, setWhiteBackgroundImage] = useState<File | null>(null);
  const [whiteBackgroundPreview, setWhiteBackgroundPreview] = useState('');
  const [benchmarkImage, setBenchmarkImage] = useState<File | null>(null);
  const [extraReferenceImage, setExtraReferenceImage] = useState<File | null>(null);
  const [productImage, setProductImage] = useState<File | null>(null);
  const [selectedMultiReferenceSlot, setSelectedMultiReferenceSlot] =
    useState<MultiReferenceSlotId | null>(null);
  const [benchmarkPreview, setBenchmarkPreview] = useState('');
  const [extraReferencePreview, setExtraReferencePreview] = useState('');
  const [productPreview, setProductPreview] = useState('');
  const [isSingleUploadDragging, setIsSingleUploadDragging] = useState(false);
  const [isMultiUploadDragging, setIsMultiUploadDragging] = useState(false);
  const [manualAspectRatio, setManualAspectRatio] = useState(false);
  const [error, setError] = useState('');
  const [queue, setQueue] = useState<ImageQueueTask[]>([]);
  const [queuePausedByUnknown, setQueuePausedByUnknown] = useState(false);
  const [packagingTitle, setPackagingTitle] = useState('');
  const [packagingMode, setPackagingMode] = useState<PackagingBatchMode>('t2i');
  const [selectedPackagingTemplateIds, setSelectedPackagingTemplateIds] = useState<string[]>([]);
  const [promptTemplates, setPromptTemplates] = useState<ImagePromptTemplate[]>([]);
  const [maxPackagingStylesPerBatch, setMaxPackagingStylesPerBatch] = useState<number | null>(null);
  const [packagingSelectionNotice, setPackagingSelectionNotice] = useState('');
  const [selectedGlobalPromptTemplateKey, setSelectedGlobalPromptTemplateKey] = useState('');
  const [isPromptTemplateManagerOpen, setPromptTemplateManagerOpen] = useState(false);
  const [isPromptTemplatesLoading, setPromptTemplatesLoading] = useState(false);
  const [packagingReferenceImage, setPackagingReferenceImage] = useState<File | null>(null);
  const [packagingReferencePreview, setPackagingReferencePreview] = useState('');
  const [packagingBatch, setPackagingBatch] = useState<PackagingBatchTask | null>(null);
  const [packagingError, setPackagingError] = useState('');
  const [packagingPollWarning, setPackagingPollWarning] = useState('');
  const [browserGenerationLeases, setBrowserGenerationLeases] = useState<ImageGenerationLease[]>(
    () => getActiveImageGenerationLeases(),
  );
  const [currentJobFingerprint, setCurrentJobFingerprint] = useState('');
  const canManagePromptTemplates = canManageImagePromptTemplates(user);
  const processingRef = useRef(false);
  const dispatchedTaskIdsRef = useRef(new Set<string>());
  const claimingTaskIdRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  const queueAbortControllerRef = useRef<AbortController | null>(null);
  const statusQueryControllersRef = useRef(new Map<string, AbortController>());
  const tabSessionIdRef = useRef(getImageGenerationTabSessionId());
  useEffect(() => {
    if (!isSkuSourceWorkflow) {
      return;
    }
    setTaskType('image-to-image');
    setGenerationTab('single');
  }, [isSkuSourceWorkflow]);

  const notifiedTaskIdsRef = useRef(new Set<string>());
  const originalTitleRef = useRef(
    typeof document !== 'undefined' ? document.title : '经济舱 AI 工作台',
  );
  const titleReminderActiveRef = useRef(false);
  const promptTemplateRequestSequenceRef = useRef(0);
  const packagingSelectionInitializedRef = useRef(false);
  const pendingCreatedPromptTemplateRef = useRef<ImagePromptTemplate | null>(null);
  const hasUnresolvedUnknownTask = useMemo(
    () => queue.some((task) => getTaskVisualState(task) === 'status_unknown'),
    [queue],
  );
  const hasWaitingQueueTask = useMemo(
    () => queue.some((task) => task.status === 'waiting'),
    [queue],
  );
  const browserLeaseSignature = useMemo(
    () =>
      JSON.stringify(
        browserGenerationLeases
          .map((lease) =>
            JSON.stringify([
              lease.tabSessionId,
              lease.localTaskId,
              lease.jobFingerprint,
              lease.status,
            ]),
          )
          .sort(),
      ),
    [browserGenerationLeases],
  );
  const activeBrowserGenerationCount = browserGenerationLeases.length;
  const crossTabConcurrencyLimitReached =
    activeBrowserGenerationCount >= IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT;

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      queueAbortControllerRef.current?.abort();
      statusQueryControllersRef.current.forEach((controller) => controller.abort());
    };
  }, []);

  useEffect(() => {
    const refreshLease = () => {
      setBrowserGenerationLeases(getActiveImageGenerationLeases());
    };

    refreshLease();
    const unsubscribe = subscribeImageGenerationLease((leases) => {
      setBrowserGenerationLeases(leases);
    });

    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== IMAGE_GENERATION_LEASE_STORAGE_KEY) {
        return;
      }
      refreshLease();
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  useEffect(() => {
    if (browserGenerationLeases.length === 0) {
      return;
    }

    const nextExpiryAt = Math.min(...browserGenerationLeases.map((lease) => lease.leaseExpiresAt));
    const remainingMs = nextExpiryAt - Date.now();
    if (remainingMs <= 0) {
      setBrowserGenerationLeases(getActiveImageGenerationLeases());
      return;
    }

    const timer = window.setTimeout(() => {
      setBrowserGenerationLeases(getActiveImageGenerationLeases());
    }, remainingMs + 50);

    return () => {
      window.clearTimeout(timer);
    };
  }, [browserGenerationLeases]);

  useEffect(() => {
    if (!hasUnresolvedUnknownTask && queuePausedByUnknown) {
      setQueuePausedByUnknown(false);
    }
  }, [hasUnresolvedUnknownTask, queuePausedByUnknown]);

  const restoreDocumentTitle = useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }
    if (!titleReminderActiveRef.current) {
      return;
    }
    document.title = originalTitleRef.current;
    titleReminderActiveRef.current = false;
  }, []);

  const notifyTaskCompleted = useCallback(
    (taskId: string) => {
      if (notifiedTaskIdsRef.current.has(taskId)) {
        return;
      }
      notifiedTaskIdsRef.current.add(taskId);
      showToast({ status: 'success', message: '图片已生成完成' });

      if (typeof document !== 'undefined' && document.hidden) {
        document.title = '图片已完成 - 经济舱 AI 工作台';
        titleReminderActiveRef.current = true;
      }
    },
    [showToast],
  );

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        restoreDocumentTitle();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      restoreDocumentTitle();
    };
  }, [restoreDocumentTitle]);

  useEffect(() => {
    let ignore = false;

    request
      .get<ImageGenerationConfig>('/api/image-generation/config')
      .then((data) => {
        if (ignore) {
          return;
        }
        setConfig(data);
        setOutputQuality(normalizeOutputQuality(data.defaultOutputQuality));
        setPlatform(data.platforms.includes(platform) ? platform : data.platforms[0]);
        setImageType(data.imageTypes.includes(imageType) ? imageType : data.imageTypes[0]);
        setModel(TEXT_TO_IMAGE_MODEL);
        setEditModelKey(
          data.editModels?.some((item) => item.value === editModelKey)
            ? editModelKey
            : DEFAULT_EDIT_MODEL_KEY,
        );
      })
      .catch(() => {
        setError('AI 生图配置加载失败，请刷新页面后重试。');
      });

    return () => {
      ignore = true;
    };
  }, []);

  const resumeInternalTask = useCallback(
    async (restoredTask: ImageQueueTask) => {
      if (restoredTask.status === 'success' && restoredTask.resultImages.length > 0) {
        return;
      }
      if (
        !restoredTask.internalTaskId ||
        statusQueryControllersRef.current.has(restoredTask.taskId)
      ) {
        return;
      }
      const abortController = new AbortController();
      statusQueryControllersRef.current.set(restoredTask.taskId, abortController);
      let lastRequestId = restoredTask.requestId;
      let lastStatusReceivedAt: number | undefined;
      const applyRestoredTaskStatus = (
        restoredTask: ImageQueueTask,
        taskStatus: InternalImageGenerationTaskResponse,
      ) => {
        if (!isMountedRef.current || abortController.signal.aborted) {
          return;
        }
        lastStatusReceivedAt = Date.now();
        const patch = getQueueTaskPatchFromInternalTaskStatus(taskStatus, restoredTask.taskType);
        const internalTaskId = patch.internalTaskId ?? restoredTask.internalTaskId ?? null;
        const requestId = patch.requestId ?? lastRequestId ?? null;
        lastRequestId = requestId;
        if (patch.state === 'status_unknown') {
          setQueuePausedByUnknown(true);
        }
        setQueue((items) =>
          items.map((task) =>
            task.taskId === restoredTask.taskId
              ? {
                  ...task,
                  status: patch.status,
                  state: patch.state,
                  internalTaskId,
                  requestId,
                  waitMessage: patch.waitMessage,
                  errorMessage: patch.errorMessage,
                  errorCode: patch.errorCode,
                  resultImages: patch.resultImages,
                }
              : task,
          ),
        );
        if (
          isInternalTaskSucceeded(taskStatus) ||
          ['failed', 'degraded', 'cancelled'].includes(getInternalTaskStatus(taskStatus))
        ) {
          clearImageGenerationLease({
            localTaskId: restoredTask.taskId,
            tabSessionId: tabSessionIdRef.current,
          });
          setBrowserGenerationLeases(getActiveImageGenerationLeases());
        }
        if (isInternalTaskSucceeded(taskStatus)) {
          notifyTaskCompleted(restoredTask.taskId);
        }
        upsertStoredImageGenerationAsyncTask(
          {
            ...restoredTask,
            status: patch.status,
            state: patch.state,
            internalTaskId,
            requestId,
            waitMessage: patch.waitMessage,
            errorMessage: patch.errorMessage,
            errorCode: patch.errorCode,
            resultImages: patch.resultImages,
          },
          taskStatus,
        );
      };

      try {
        await withImageGenerationClientWait(
          async (signal) => {
            const initialStatus = await fetchInternalGenerationTaskStatus(
              restoredTask.internalTaskId as string,
              signal,
            );
            applyRestoredTaskStatus(restoredTask, initialStatus);
            if (
              isInternalTaskSucceeded(initialStatus) ||
              isInternalTaskTerminalError(initialStatus)
            ) {
              return;
            }
            await waitForInternalGenerationTask(initialStatus, {
              signal,
              onStatus: (taskStatus) => applyRestoredTaskStatus(restoredTask, taskStatus),
            });
          },
          {
            ...getImageGenerationClientWaitConfig(restoredTask),
            signal: abortController.signal,
            getLastStatusReceivedAt: () => lastStatusReceivedAt,
          },
        );
      } catch (error) {
        if (!isMountedRef.current || abortController.signal.aborted) {
          return;
        }
        const response = (error as { response?: { data?: InternalImageGenerationTaskResponse } })
          .response?.data;
        applyRestoredTaskStatus(
          restoredTask,
          response ?? {
            internalTaskId: restoredTask.internalTaskId,
            requestId: lastRequestId,
            state: 'status_unknown',
            status: 'status_unknown',
            errorCode: IMAGE_GENERATION_STATUS_QUERY_INTERRUPTED,
            message: IMAGE_GENERATION_CLIENT_TIMEOUT_MESSAGE,
          },
        );
      } finally {
        if (statusQueryControllersRef.current.get(restoredTask.taskId) === abortController) {
          statusQueryControllersRef.current.delete(restoredTask.taskId);
        }
      }
    },
    [notifyTaskCompleted],
  );

  useEffect(() => {
    const restoredQueueTasks = readStoredImageGenerationAsyncTasks().map(
      createQueueTaskFromStoredImageGenerationAsyncTask,
    );
    setQueue((items) => {
      const existingIds = new Set(items.map((task) => task.internalTaskId || task.taskId));
      const tasksToRestore = restoredQueueTasks.filter(
        (task) => !existingIds.has(task.internalTaskId || task.taskId),
      );
      return tasksToRestore.length ? [...items, ...tasksToRestore] : items;
    });
    restoredQueueTasks.forEach((task) => {
      void resumeInternalTask(task);
    });
  }, [resumeInternalTask]);

  useEffect(() => {
    if (!whiteBackgroundImage) {
      setWhiteBackgroundPreview('');
      return;
    }

    const objectUrl = URL.createObjectURL(whiteBackgroundImage);
    setWhiteBackgroundPreview(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [whiteBackgroundImage]);

  useEffect(() => {
    if (!benchmarkImage) {
      setBenchmarkPreview('');
      return;
    }

    const objectUrl = URL.createObjectURL(benchmarkImage);
    setBenchmarkPreview(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [benchmarkImage]);

  useEffect(() => {
    if (!extraReferenceImage) {
      setExtraReferencePreview('');
      return;
    }

    const objectUrl = URL.createObjectURL(extraReferenceImage);
    setExtraReferencePreview(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [extraReferenceImage]);

  useEffect(() => {
    if (!productImage) {
      setProductPreview('');
      return;
    }

    const objectUrl = URL.createObjectURL(productImage);
    setProductPreview(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [productImage]);

  useEffect(() => {
    if (!packagingReferenceImage) {
      setPackagingReferencePreview('');
      return;
    }

    const objectUrl = URL.createObjectURL(packagingReferenceImage);
    setPackagingReferencePreview(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [packagingReferenceImage]);

  const recommendedAspectRatio = useMemo(() => {
    return (
      config.platformTypeAspectRatios[`${platform}|${imageType}`] ??
      config.defaultAspectRatios[imageType] ??
      '1:1'
    );
  }, [config, platform, imageType]);

  useEffect(() => {
    if (!manualAspectRatio) {
      setAspectRatio(recommendedAspectRatio);
    }
  }, [manualAspectRatio, recommendedAspectRatio]);

  const isImageToImage = taskType === 'image-to-image';
  const isDualProductReplace = taskType === 'dual-product-replace';
  const isWhiteBackground = taskType === 'white-background';
  const supportsOutputQuality = shouldAttachOutputQuality({ taskType, generationTab });
  const isImageEditTask = isImageToImage || isDualProductReplace;
  const isSingleUploadTask = isImageToImage || isWhiteBackground;
  const isBatchPackagingTab = generationTab === 'batch-packaging';
  const outputQualityOptions = config.outputQualities?.length
    ? config.outputQualities
    : OUTPUT_QUALITY_OPTIONS;
  const effectiveIsImageEditTask = isBatchPackagingTab ? packagingMode === 'i2i' : isImageEditTask;
  const effectiveImageEditCapability = isBatchPackagingTab
    ? SINGLE_IMAGE_EDIT_TASK
    : isImageToImage
      ? SINGLE_IMAGE_EDIT_TASK
      : MULTI_REFERENCE_TASK;
  const currentModelOptions = useMemo(() => {
    if (effectiveIsImageEditTask) {
      const source = config.editModels?.length ? config.editModels : IMAGE_GENERATION_EDIT_MODELS;
      return source
        .filter(
          (item) => !item.capabilities || item.capabilities.includes(effectiveImageEditCapability),
        )
        .map((item) => ({ label: item.label, value: item.value }));
    }

    return (config.models?.length ? config.models : initialConfig.models)
      .filter((item) => !item.capabilities || item.capabilities.includes('text-to-image'))
      .map((item) => ({ label: item.label, value: item.value }));
  }, [config, effectiveImageEditCapability, effectiveIsImageEditTask]);

  useEffect(() => {
    if (!effectiveIsImageEditTask) {
      return;
    }
    if (currentModelOptions.some((item) => item.value === editModelKey)) {
      return;
    }
    setEditModelKey(currentModelOptions[0]?.value ?? DEFAULT_EDIT_MODEL_KEY);
  }, [currentModelOptions, editModelKey, effectiveIsImageEditTask]);

  const selectedModel = useMemo(() => {
    if (effectiveIsImageEditTask) {
      const selectedEditModel = (
        config.editModels?.length ? config.editModels : IMAGE_GENERATION_EDIT_MODELS
      ).find((item) => item.value === editModelKey);
      return {
        label: selectedEditModel?.label ?? editModelKey,
        modelKey: editModelKey,
        model: selectedEditModel?.model ?? getProviderModelForKey(config, editModelKey),
      };
    }

    const selectedTextModel = (config.models?.length ? config.models : initialConfig.models).find(
      (item) => item.value === model,
    );
    const providerModel = selectedTextModel?.model ?? model;
    const modelKey =
      selectedTextModel?.provider === 'siliconflow' ||
      selectedTextModel?.value === TEXT_TO_IMAGE_MODEL
        ? undefined
        : (selectedTextModel?.modelKey ?? selectedTextModel?.value);

    return {
      label: selectedTextModel?.label ?? selectedTextModel?.name ?? model,
      modelKey,
      model: providerModel,
    };
  }, [config, editModelKey, effectiveIsImageEditTask, model]);

  const selectedTextModelConfig = useMemo(
    () =>
      (config.models?.length ? config.models : initialConfig.models).find(
        (item) => item.value === model,
      ),
    [config.models, model],
  );
  const supportedGenerationCounts = useMemo(
    () =>
      getSupportedGenerationCounts(
        config.counts,
        isBatchPackagingTab ? undefined : selectedTextModelConfig?.supportedCounts,
      ),
    [config.counts, isBatchPackagingTab, selectedTextModelConfig?.supportedCounts],
  );
  const generationCountNotice = useMemo(
    () =>
      getGenerationCountNotice(
        selectedTextModelConfig?.modelKey ?? selectedTextModelConfig?.value,
        isBatchPackagingTab ? undefined : selectedTextModelConfig?.supportedCounts,
        effectiveIsImageEditTask,
      ),
    [
      effectiveIsImageEditTask,
      isBatchPackagingTab,
      selectedTextModelConfig?.modelKey,
      selectedTextModelConfig?.supportedCounts,
      selectedTextModelConfig?.value,
    ],
  );

  useEffect(() => {
    if (effectiveIsImageEditTask || isBatchPackagingTab) {
      return;
    }
    setCount((current) =>
      normalizeGenerationCount(current, config.counts, selectedTextModelConfig?.supportedCounts),
    );
  }, [
    config.counts,
    effectiveIsImageEditTask,
    isBatchPackagingTab,
    selectedTextModelConfig?.supportedCounts,
  ]);

  const currentJobFingerprintDescriptor = useMemo(
    () =>
      buildImageGenerationJobFingerprintDescriptor({
        generationTab,
        taskType,
        modelKey: selectedModel.modelKey ?? null,
        model: isWhiteBackground ? null : selectedModel.model,
        platform,
        imageType,
        prompt: prompt.trim(),
        aspectRatio,
        outputQuality: getTaskOutputQuality({ taskType, generationTab, outputQuality }),
        count: isImageEditTask || isWhiteBackground ? 1 : count,
        inputImages: [
          ...(isImageToImage && whiteBackgroundImage
            ? [{ role: '白底图', file: whiteBackgroundImage }]
            : []),
          ...(isWhiteBackground && whiteBackgroundImage
            ? [{ role: '商品原图', file: whiteBackgroundImage }]
            : []),
          ...(isDualProductReplace && benchmarkImage
            ? [{ role: '对标/参考图 1', file: benchmarkImage }]
            : []),
          ...(isDualProductReplace && productImage ? [{ role: '商品图', file: productImage }] : []),
          ...(isDualProductReplace && extraReferenceImage
            ? [{ role: '对标/参考图 2', file: extraReferenceImage }]
            : []),
        ],
      }),
    [
      aspectRatio,
      benchmarkImage,
      count,
      extraReferenceImage,
      generationTab,
      imageType,
      isDualProductReplace,
      isImageEditTask,
      isImageToImage,
      isWhiteBackground,
      outputQuality,
      platform,
      productImage,
      prompt,
      selectedModel.model,
      selectedModel.modelKey,
      taskType,
      whiteBackgroundImage,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    void createImageGenerationJobFingerprint(currentJobFingerprintDescriptor)
      .then((fingerprint) => {
        if (!cancelled) {
          setCurrentJobFingerprint(fingerprint);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentJobFingerprint('');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentJobFingerprintDescriptor]);

  const duplicateBrowserGenerationLease = useMemo(() => {
    if (!currentJobFingerprint) {
      return null;
    }

    return (
      browserGenerationLeases.find(
        (lease) =>
          lease.tabSessionId !== tabSessionIdRef.current &&
          lease.jobFingerprint === currentJobFingerprint,
      ) ?? null
    );
  }, [browserGenerationLeases, currentJobFingerprint]);

  const globalPromptTemplates = useMemo(
    () =>
      promptTemplates.filter(
        (template) => template.isEnabled && isGlobalBusinessTemplate(template),
      ),
    [promptTemplates],
  );
  const packagingStyleTemplates = useMemo(
    () =>
      promptTemplates.filter(
        (template) => template.isEnabled && isPackagingStyleTemplate(template),
      ),
    [promptTemplates],
  );

  const selectedGlobalPromptTemplateName = useMemo(() => {
    const selected = globalPromptTemplates.find(
      (template) => template.key === selectedGlobalPromptTemplateKey,
    );
    return selected?.name || '未选择';
  }, [globalPromptTemplates, selectedGlobalPromptTemplateKey]);

  const selectedPackagingStyleTemplateNames = useMemo(() => {
    return packagingStyleTemplates
      .filter((template) => selectedPackagingTemplateIds.includes(template.key))
      .map((template) => template.name);
  }, [packagingStyleTemplates, selectedPackagingTemplateIds]);
  const isAPIMartGPTImage2Selected = selectedModel.model === 'gpt-image-2';
  const isSeedreamProSelected = selectedModel.model === 'doubao-seedream-5-0-pro-260628';
  const multiReferenceImages = useMemo(
    () => ({
      benchmark: benchmarkImage,
      product: productImage,
      extraReference: extraReferenceImage,
    }),
    [benchmarkImage, extraReferenceImage, productImage],
  );
  const multiReferencePreviews = useMemo(
    () => ({
      benchmark: benchmarkPreview,
      product: productPreview,
      extraReference: extraReferencePreview,
    }),
    [benchmarkPreview, extraReferencePreview, productPreview],
  );
  const activeMultiReferenceSlots = MULTI_REFERENCE_RENDER_ORDER.filter((slotId) =>
    Boolean(multiReferenceImages[slotId]),
  );
  const multiReferenceImageCount = activeMultiReferenceSlots.length;
  const hasReferenceImages = Boolean(benchmarkImage || extraReferenceImage);
  const selectedMultiReferenceSlotLabel = selectedMultiReferenceSlot
    ? MULTI_REFERENCE_SLOTS.find((slot) => slot.id === selectedMultiReferenceSlot)?.role
    : null;

  const setMultiReferenceSlotImage = useCallback(
    (slotId: MultiReferenceSlotId, file: File | null) => {
      if (slotId === 'benchmark') {
        setBenchmarkImage(file);
        return;
      }
      if (slotId === 'product') {
        setProductImage(file);
        return;
      }
      setExtraReferenceImage(file);
    },
    [],
  );

  const getNextAvailableMultiReferenceSlot = useCallback(
    (usedSlots: Set<MultiReferenceSlotId>) => {
      if (!productImage && !usedSlots.has('product')) {
        return 'product';
      }
      if (!benchmarkImage && !usedSlots.has('benchmark')) {
        return 'benchmark';
      }
      if (!extraReferenceImage && !usedSlots.has('extraReference')) {
        return 'extraReference';
      }
      return null;
    },
    [benchmarkImage, extraReferenceImage, productImage],
  );

  const handleMultiReferenceSlotFile = useCallback(
    (slotId: MultiReferenceSlotId, file?: File) => {
      const validation = validateUploadFile(file);
      setMultiReferenceSlotImage(slotId, validation.ok ? validation.file : null);
      if (selectedMultiReferenceSlot === slotId && !validation.ok) {
        setSelectedMultiReferenceSlot(null);
      }
    },
    [selectedMultiReferenceSlot, setMultiReferenceSlotImage],
  );

  const handleDeleteMultiReferenceSlot = useCallback(
    (slotId: MultiReferenceSlotId) => {
      setMultiReferenceSlotImage(slotId, null);
      if (selectedMultiReferenceSlot === slotId) {
        setSelectedMultiReferenceSlot(null);
      }
      setError('');
    },
    [selectedMultiReferenceSlot, setMultiReferenceSlotImage],
  );

  const handleClearReferenceImages = useCallback(() => {
    setBenchmarkImage(null);
    setExtraReferenceImage(null);
    setSelectedMultiReferenceSlot((slotId) =>
      slotId === 'benchmark' || slotId === 'extraReference' ? null : slotId,
    );
    setError('');
  }, []);

  const handleClearAllMultiReferenceImages = useCallback(() => {
    setBenchmarkImage(null);
    setProductImage(null);
    setExtraReferenceImage(null);
    setSelectedMultiReferenceSlot(null);
    setError('');
  }, []);

  const handleTaskTypeChange = (nextTaskType: TaskType) => {
    setTaskType(nextTaskType);
    if (nextTaskType === 'text-to-image') {
      setModel(TEXT_TO_IMAGE_MODEL);
    } else {
      setEditModelKey(DEFAULT_EDIT_MODEL_KEY);
    }
    if (nextTaskType !== 'text-to-image') {
      setCount(1);
    }
    if (nextTaskType !== 'dual-product-replace') {
      setSelectedMultiReferenceSlot(null);
    }
    setError('');
  };

  const handleModelChange = (value: string) => {
    if (effectiveIsImageEditTask) {
      setEditModelKey(value);
      return;
    }

    setModel(value);
  };

  /**
   * 复用的模型选择控件：单次生成与批量包装生成共用同一套状态（currentModelOptions /
   * selectedModel / model / editModelKey / effectiveIsImageEditTask / handleModelChange），
   * 不新增 batch 独立 model state。
   */
  const renderModelSelect = () => (
    <label className="grid gap-2 text-sm font-medium">
      模型选择
      <select
        aria-label="模型选择"
        value={effectiveIsImageEditTask ? editModelKey : model}
        className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-blue-500"
        onChange={(event) => handleModelChange(event.target.value)}
      >
        {currentModelOptions.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
      {!effectiveIsImageEditTask && model === 'apimart_gpt_image_2_5_flare' && (
        <span className="text-xs font-normal text-text-secondary">
          文生图模型，按生成数量和尺寸计费
        </span>
      )}
      {effectiveIsImageEditTask && editModelKey === 'apimart_gpt_image_2_5_sunburst' && (
        <span className="text-xs font-normal text-text-secondary">编辑模型，费用较高</span>
      )}
    </label>
  );

  const handlePlatformChange = (value: string) => {
    setPlatform(value);
    setManualAspectRatio(false);
  };

  const handleImageTypeChange = (value: string) => {
    setImageType(value);
    setManualAspectRatio(false);
  };

  const validateUploadFile = (file?: File) => {
    setError('');

    if (!file) {
      return { ok: false as const, file: null };
    }

    if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) {
      setError('只支持 PNG、JPG/JPEG、WebP 图片。');
      return { ok: false as const, file: null };
    }

    if (file.size > MAX_UPLOAD_SIZE) {
      setError('图片不能超过 8MB。');
      return { ok: false as const, file: null };
    }

    return { ok: true as const, file };
  };

  useEffect(() => {
    if (!sourceFileId || sourceType !== 'sku-result') {
      return;
    }

    let disposed = false;
    let objectUrl: string | undefined;
    (async () => {
      try {
        objectUrl = await loadSkuFileObjectUrl(sourceFileId);
        const response = await fetch(objectUrl);
        const blob = await response.blob();
        const file = new File([blob], `sku-source-${sourceFileId}.png`, {
          type: blob.type || 'image/png',
        });
        const validation = validateUploadFile(file);
        if (!validation.ok || !validation.file || disposed) {
          return;
        }
        setTaskType('image-to-image');
        setEditModelKey(DEFAULT_EDIT_MODEL_KEY);
        setCount(1);
        setWhiteBackgroundImage(validation.file);
        showToast({ status: 'success', message: '已带入 SKU 结果，可继续单图改图。' });
      } catch {
        if (!disposed) {
          showToast({ status: 'error', message: 'SKU 结果读取失败，请重新上传图片。' });
        }
      } finally {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [showToast, sourceFileId, sourceType]);

  const handleUploadChange = (file?: File) => {
    const validation = validateUploadFile(file);
    if (!validation.ok) {
      setWhiteBackgroundImage(null);
      return;
    }
    setWhiteBackgroundImage(validation.file ?? null);
  };

  const handleBenchmarkUploadChange = (file?: File) => {
    handleMultiReferenceSlotFile('benchmark', file);
  };

  const handleExtraReferenceUploadChange = (file?: File) => {
    handleMultiReferenceSlotFile('extraReference', file);
  };

  const handleProductUploadChange = (file?: File) => {
    handleMultiReferenceSlotFile('product', file);
  };

  const handleImageFiles = useCallback(
    (files: File[], source: 'drag' | 'paste') => {
      if (!files.length) {
        showToast({ status: 'error', message: '仅支持上传图片文件' });
        return;
      }

      if (isSingleUploadTask) {
        const validation = validateUploadFile(files[0]);
        if (!validation.ok || !validation.file) {
          return;
        }

        if (files.length > 1) {
          showToast({ status: 'success', message: '单图改图仅使用第一张图片' });
        } else if (source === 'paste') {
          showToast({ status: 'success', message: '已替换上传图片' });
        }

        setWhiteBackgroundImage(validation.file);
        return;
      }

      if (isDualProductReplace) {
        if (selectedMultiReferenceSlot && multiReferenceImages[selectedMultiReferenceSlot]) {
          const validation = validateUploadFile(files[0]);
          if (!validation.ok || !validation.file) {
            return;
          }
          setMultiReferenceSlotImage(selectedMultiReferenceSlot, validation.file);
          setSelectedMultiReferenceSlot(null);
          if (files.length > 1) {
            showToast({
              status: 'error',
              message: `已替换${selectedMultiReferenceSlotLabel ?? '所选图片'}，本次有 ${
                files.length - 1
              } 张未加入。`,
            });
          } else if (source === 'paste') {
            showToast({ status: 'success', message: '已替换所选图片' });
          }
          return;
        }

        const availableSlots = MAX_MULTI_REFERENCE_IMAGES - multiReferenceImageCount;

        if (availableSlots <= 0) {
          showToast({
            status: 'error',
            message: MULTI_REFERENCE_FULL_GUIDE,
          });
          return;
        }

        const validFiles: File[] = [];
        for (const file of files.slice(0, availableSlots)) {
          const validation = validateUploadFile(file);
          if (validation.ok && validation.file) {
            validFiles.push(validation.file);
          }
        }

        if (!validFiles.length) {
          return;
        }

        const usedSlots = new Set<MultiReferenceSlotId>();
        for (const file of validFiles) {
          const slotId = getNextAvailableMultiReferenceSlot(usedSlots);
          if (!slotId) {
            break;
          }
          setMultiReferenceSlotImage(slotId, file);
          usedSlots.add(slotId);
        }

        if (files.length > availableSlots) {
          showToast({
            status: 'error',
            message: `已使用 ${MAX_MULTI_REFERENCE_IMAGES}/${MAX_MULTI_REFERENCE_IMAGES} 张图，本次有 ${
              files.length - availableSlots
            } 张未加入。`,
          });
        } else if (source === 'paste') {
          showToast({ status: 'success', message: '已添加图片' });
        }
        return;
      }

      showToast({
        status: 'error',
        message: '请切换到单图改图或多图商品替换后上传图片',
      });
    },
    [
      benchmarkImage,
      extraReferenceImage,
      getNextAvailableMultiReferenceSlot,
      isDualProductReplace,
      isSingleUploadTask,
      multiReferenceImageCount,
      multiReferenceImages,
      productImage,
      selectedMultiReferenceSlot,
      selectedMultiReferenceSlotLabel,
      showToast,
      setMultiReferenceSlotImage,
    ],
  );

  const handleUploadDragOver = (event: DragEvent<HTMLElement>, uploadType: 'single' | 'multi') => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (uploadType === 'single') {
      setIsSingleUploadDragging(true);
      return;
    }
    setIsMultiUploadDragging(true);
  };

  const handleUploadDragLeave = (event: DragEvent<HTMLElement>, uploadType: 'single' | 'multi') => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    if (uploadType === 'single') {
      setIsSingleUploadDragging(false);
      return;
    }
    setIsMultiUploadDragging(false);
  };

  const handleUploadDrop = (event: DragEvent<HTMLElement>, uploadType: 'single' | 'multi') => {
    event.preventDefault();
    if (uploadType === 'single') {
      setIsSingleUploadDragging(false);
    } else {
      setIsMultiUploadDragging(false);
    }

    const files = getImageFilesFromDataTransfer(event.dataTransfer);
    if (!files.length && event.dataTransfer.files.length) {
      showToast({ status: 'error', message: '仅支持上传图片文件' });
      return;
    }

    handleImageFiles(files, 'drag');
  };

  const handlePasteUpload = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const files = getImageFilesFromClipboard(event.clipboardData);
      if (!files.length) {
        return;
      }

      event.preventDefault();
      handleImageFiles(files, 'paste');
    },
    [handleImageFiles],
  );

  const handleUseResultAsSource = useCallback(
    async (image: GeneratedImage, index: number) => {
      try {
        const file = await imageToFile(image, `ai-result-${Date.now()}-${index + 1}`);
        const validation = validateUploadFile(file);
        if (!validation.ok || !validation.file) {
          throw new Error('Invalid generated image file');
        }

        handleTaskTypeChange('image-to-image');
        setWhiteBackgroundImage(validation.file);
        setCount(1);
        showToast({
          status: 'success',
          message: '已将图片带入单图改图，可输入修改要求继续生成',
        });
      } catch {
        showToast({
          status: 'error',
          message: '无法直接带入改图。请先下载图片，再手动上传。',
        });
      }
    },
    [showToast],
  );

  const handleMakeSku = useCallback(
    async (image: GeneratedImage, index: number) => {
      try {
        const file = await imageToFile(image, `ai-result-${Date.now()}-${index + 1}`);
        const validation = validateUploadFile(file);
        if (!validation.ok || !validation.file) {
          throw new Error('Invalid generated image file');
        }
        const saved = await uploadSkuFile(validation.file, 'source');
        if (skuSourceWorkflow) {
          const previewObjectUrl = URL.createObjectURL(validation.file);
          skuSourceWorkflow.onSourceReady({
            fileId: saved.fileId,
            previewObjectUrl,
          });
          return;
        }
        navigate(
          `/sku-generation?sourceFileId=${encodeURIComponent(saved.fileId)}&sourceType=image-edit-result`,
        );
      } catch {
        showToast({
          status: 'error',
          message: isSkuSourceWorkflow
            ? '无法带入 SKU 源图。请先下载图片，再手动上传。'
            : '无法带入 SKU 制作。请先下载图片，再手动上传。',
        });
      }
    },
    [isSkuSourceWorkflow, navigate, showToast, skuSourceWorkflow],
  );

  const fetchPackagingBatch = useCallback(async (batchId: string) => {
    const response = (await request.get(`/api/batch/image-generation/${batchId}`)) as {
      batch?: PackagingBatchTask;
    };
    if (response.batch) {
      setPackagingBatch((current) =>
        mergePackagingBatchState(current, normalizePackagingBatch(response.batch)),
      );
      setPackagingPollWarning('');
    }
  }, []);

  const fetchPromptTemplates = useCallback(
    async ({ preserveSelectedTemplateId }: FetchPromptTemplatesOptions = {}) => {
      const requestSequence = ++promptTemplateRequestSequenceRef.current;
      setPromptTemplatesLoading(true);
      try {
        const response = (await request.get(
          '/api/image-generation/prompt-templates?category=batch_packaging',
        )) as {
          templates?: ImagePromptTemplate[];
          limits?: { maxPackagingStylesPerBatch?: number };
        };
        const serverTemplates = response.templates ?? [];
        if (requestSequence !== promptTemplateRequestSequenceRef.current) {
          return;
        }
        const serverSelectionLimit = response.limits?.maxPackagingStylesPerBatch;
        if (!Number.isInteger(serverSelectionLimit) || Number(serverSelectionLimit) < 1) {
          throw new Error('包装样式选择上限加载失败，请刷新后重试。');
        }
        setMaxPackagingStylesPerBatch(Number(serverSelectionLimit));
        const pendingTemplate = pendingCreatedPromptTemplateRef.current;
        const pendingTemplateId = pendingTemplate ? getPromptTemplateId(pendingTemplate) : '';
        const serverHasPendingTemplate = Boolean(
          pendingTemplateId &&
            serverTemplates.some((template) => getPromptTemplateId(template) === pendingTemplateId),
        );
        const templates =
          pendingTemplate && !serverHasPendingTemplate
            ? [...serverTemplates, pendingTemplate]
            : serverTemplates;
        if (serverHasPendingTemplate) {
          pendingCreatedPromptTemplateRef.current = null;
        }
        setPromptTemplates(templates);
        const enabledPackagingTemplates = templates.filter(
          (template) => template.isEnabled && isPackagingStyleTemplate(template),
        );
        setSelectedPackagingTemplateIds((current) => {
          if (!packagingSelectionInitializedRef.current) {
            packagingSelectionInitializedRef.current = true;
            const enabledSystemTemplateKeys = enabledPackagingTemplates
              .filter((template) => template.isSystem)
              .map((template) => template.key);
            if (enabledSystemTemplateKeys.length > Number(serverSelectionLimit)) {
              setPackagingSelectionNotice('系统包装样式超过每批上限，未自动选择，请手动选择。');
              return [];
            }
            setPackagingSelectionNotice('');
            return enabledSystemTemplateKeys;
          }
          const availableTemplateKeys = new Set(
            enabledPackagingTemplates.map((template) => template.key),
          );
          return current.filter((templateKey) => availableTemplateKeys.has(templateKey));
        });
        const enabledGlobalTemplates = templates.filter(
          (template) => template.isEnabled && isGlobalBusinessTemplate(template),
        );
        setSelectedGlobalPromptTemplateKey((current) => {
          if (preserveSelectedTemplateId) {
            const preservedTemplate = enabledGlobalTemplates.find(
              (template) =>
                getPromptTemplateId(template) === preserveSelectedTemplateId ||
                template.key === preserveSelectedTemplateId,
            );
            if (preservedTemplate) {
              return preservedTemplate.key;
            }
          }
          if (current && enabledGlobalTemplates.some((template) => template.key === current)) {
            return current;
          }
          return enabledGlobalTemplates[0]?.key || '';
        });
      } catch (err) {
        if (requestSequence !== promptTemplateRequestSequenceRef.current) {
          throw err;
        }
        setMaxPackagingStylesPerBatch(null);
        const apiError = err as { response?: { data?: { message?: string } }; message?: string };
        setPackagingError(
          apiError.response?.data?.message ||
            apiError.message ||
            '提示词模板加载失败，请刷新后重试。',
        );
        throw err;
      } finally {
        if (requestSequence === promptTemplateRequestSequenceRef.current) {
          setPromptTemplatesLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (generationTab === 'batch-packaging') {
      void fetchPromptTemplates().catch(() => undefined);
    }
  }, [fetchPromptTemplates, generationTab]);

  const handlePackagingReferenceUploadChange = (file?: File) => {
    const validation = validateUploadFile(file);
    setPackagingReferenceImage(validation.ok ? validation.file : null);
  };

  const handleTogglePackagingTemplate = (templateId: string) => {
    if (selectedPackagingTemplateIds.includes(templateId)) {
      setSelectedPackagingTemplateIds((items) => items.filter((item) => item !== templateId));
      setPackagingError('');
      setPackagingSelectionNotice('');
      return;
    }
    if (!maxPackagingStylesPerBatch) {
      setPackagingError('包装样式选择上限加载失败，请刷新后重试。');
      return;
    }
    if (selectedPackagingTemplateIds.length >= maxPackagingStylesPerBatch) {
      setPackagingError(`每批最多选择 ${maxPackagingStylesPerBatch} 个，请先取消一个已选模板。`);
      return;
    }
    setSelectedPackagingTemplateIds((items) => [...items, templateId]);
    setPackagingError('');
    setPackagingSelectionNotice('');
  };

  const handleSelectAllPackagingTemplates = () => {
    if (!maxPackagingStylesPerBatch) {
      setPackagingError('包装样式选择上限加载失败，请刷新后重试。');
      return;
    }
    if (selectedPackagingTemplateIds.length >= maxPackagingStylesPerBatch) {
      return;
    }
    const availableTemplateKeys = packagingStyleTemplates.map((template) => template.key);
    if (availableTemplateKeys.length <= maxPackagingStylesPerBatch) {
      setSelectedPackagingTemplateIds(availableTemplateKeys);
      setPackagingError('');
      setPackagingSelectionNotice('');
      return;
    }
    const availableTemplateKeySet = new Set(availableTemplateKeys);
    const filledSelection = selectedPackagingTemplateIds.filter((templateKey) =>
      availableTemplateKeySet.has(templateKey),
    );
    const selectedKeys = new Set(filledSelection);
    for (const templateKey of availableTemplateKeys) {
      if (filledSelection.length >= maxPackagingStylesPerBatch) {
        break;
      }
      if (!selectedKeys.has(templateKey)) {
        selectedKeys.add(templateKey);
        filledSelection.push(templateKey);
      }
    }
    setSelectedPackagingTemplateIds(filledSelection);
    setPackagingError('');
    setPackagingSelectionNotice('');
  };

  const handlePromptTemplateSaved = useCallback((template: ImagePromptTemplate, isNew: boolean) => {
    const pendingTemplateId = pendingCreatedPromptTemplateRef.current
      ? getPromptTemplateId(pendingCreatedPromptTemplateRef.current)
      : '';
    if (isNew || pendingTemplateId === getPromptTemplateId(template)) {
      pendingCreatedPromptTemplateRef.current = template;
    }
    setPromptTemplates((current) => {
      const templateId = getPromptTemplateId(template);
      const existingIndex = current.findIndex((item) => getPromptTemplateId(item) === templateId);
      if (existingIndex < 0) {
        return [...current, template];
      }
      return current.map((item, index) => (index === existingIndex ? template : item));
    });
    if (isPackagingStyleTemplate(template) && !template.isEnabled) {
      setSelectedPackagingTemplateIds((current) =>
        current.filter((templateKey) => templateKey !== template.key),
      );
    }
  }, []);

  const handlePromptTemplateDeleted = useCallback((template: ImagePromptTemplate) => {
    const templateId = getPromptTemplateId(template);
    if (
      pendingCreatedPromptTemplateRef.current &&
      getPromptTemplateId(pendingCreatedPromptTemplateRef.current) === templateId
    ) {
      pendingCreatedPromptTemplateRef.current = null;
    }
    setPromptTemplates((current) =>
      current.filter((item) => getPromptTemplateId(item) !== templateId),
    );
    if (isPackagingStyleTemplate(template)) {
      setSelectedPackagingTemplateIds((current) =>
        current.filter((templateKey) => templateKey !== template.key),
      );
    }
  }, []);

  const handleStartPackagingBatch = async () => {
    const normalizedTitle = packagingTitle.trim();
    if (!normalizedTitle) {
      setPackagingError('请先填写商品标题。');
      return;
    }

    const selectedTemplates = packagingStyleTemplates.filter((template) =>
      selectedPackagingTemplateIds.includes(template.key),
    );
    if (!maxPackagingStylesPerBatch) {
      setPackagingError('包装样式选择上限加载失败，请刷新后重试。');
      return;
    }
    if (!selectedTemplates.length) {
      setPackagingError('请至少选择 1 个包装模板。');
      return;
    }
    if (selectedTemplates.length > maxPackagingStylesPerBatch) {
      setPackagingError(
        `每批最多选择 ${maxPackagingStylesPerBatch} 个包装样式。当前已选 ${selectedTemplates.length} 个，请先取消超出项。`,
      );
      return;
    }

    if (packagingMode === 'i2i' && !packagingReferenceImage) {
      setPackagingError('图生图模式请先上传参考图。');
      return;
    }

    setPackagingError('');
    setPackagingPollWarning('');
    try {
      const formData = new FormData();
      formData.append('title', normalizedTitle);
      formData.append('mode', packagingMode);
      if (selectedModel.modelKey) {
        formData.append('modelKey', selectedModel.modelKey);
      }
      formData.append('model', selectedModel.model);
      formData.append(
        'templateIds',
        JSON.stringify(selectedTemplates.map((template) => template.key)),
      );
      if (selectedGlobalPromptTemplateKey) {
        formData.append('promptTemplateId', selectedGlobalPromptTemplateKey);
      }
      if (packagingMode === 'i2i' && packagingReferenceImage) {
        formData.append('referenceImage', packagingReferenceImage);
      }

      const response = (await request.postMultiPart('/api/batch/image-generation', formData)) as {
        batchId?: string;
        batch?: PackagingBatchTask;
      };
      if (response.batchId && typeof localStorage !== 'undefined') {
        localStorage.setItem(PACKAGING_BATCH_STORAGE_KEY, response.batchId);
      }
      if (response.batch) {
        setPackagingBatch((current) =>
          mergePackagingBatchState(current, normalizePackagingBatch(response.batch)),
        );
      }
      showToast({ status: 'success', message: '批量任务已创建' });
    } catch (err) {
      const apiError = err as { response?: { data?: { message?: string } }; message?: string };
      setPackagingError(
        apiError.response?.data?.message || apiError.message || '批量任务创建失败，请稍后重试。',
      );
    }
  };

  const handleRetryPackagingItem = async (item: PackagingBatchItem) => {
    if (!packagingBatch) {
      return;
    }

    try {
      const response = (await request.post(
        `/api/batch/image-generation/${packagingBatch.id}/retry`,
        {
          templateId: item.templateId,
        },
      )) as { batch?: PackagingBatchTask };
      if (response.batch) {
        setPackagingBatch((current) =>
          mergePackagingBatchState(current, normalizePackagingBatch(response.batch)),
        );
      }
    } catch (err) {
      const apiError = err as { response?: { data?: { message?: string } }; message?: string };
      setPackagingError(
        apiError.response?.data?.message || apiError.message || '重试失败，请稍后重试。',
      );
    }
  };

  const handleRecoverPackagingItemResult = async (item: PackagingBatchItem) => {
    if (!packagingBatch) {
      return;
    }

    try {
      const response = (await request.post(
        getBatchResultRecoveryUrl(packagingBatch.id, item.itemId),
        {},
      )) as { batch?: PackagingBatchTask };
      if (response.batch) {
        setPackagingBatch((current) =>
          mergePackagingBatchState(current, normalizePackagingBatch(response.batch)),
        );
      }
    } catch (err) {
      const apiError = err as { response?: { data?: { message?: string } }; message?: string };
      setPackagingError(
        apiError.response?.data?.message || apiError.message || '图片恢复失败，请稍后重试。',
      );
      throw err;
    }
  };

  const handleCancelPackagingBatch = async () => {
    if (!packagingBatch) {
      return;
    }

    try {
      const response = (await request.post(
        `/api/batch/image-generation/${packagingBatch.id}/cancel`,
        {},
      )) as {
        batch?: PackagingBatchTask;
      };
      if (response.batch) {
        setPackagingBatch((current) =>
          mergePackagingBatchState(current, normalizePackagingBatch(response.batch)),
        );
      }
      showToast({ status: 'success', message: '批量任务已停止' });
    } catch (err) {
      const apiError = err as { response?: { data?: { message?: string } }; message?: string };
      setPackagingError(
        apiError.response?.data?.message || apiError.message || '停止任务失败，请稍后重试。',
      );
    }
  };

  useEffect(() => {
    if (typeof localStorage === 'undefined') {
      return;
    }
    const storedBatchId = localStorage.getItem(PACKAGING_BATCH_STORAGE_KEY);
    if (!storedBatchId) {
      return;
    }
    void fetchPackagingBatch(storedBatchId).catch(() => {
      localStorage.removeItem(PACKAGING_BATCH_STORAGE_KEY);
    });
  }, [fetchPackagingBatch]);

  useEffect(() => {
    if (!packagingBatch?.id) {
      return;
    }
    if (!shouldPollPackagingBatch(packagingBatch)) {
      return;
    }

    const timer = window.setInterval(() => {
      void fetchPackagingBatch(packagingBatch.id).catch(() => {
        // Keep the current visible state if a transient polling request fails.
        setPackagingPollWarning('状态同步失败，正在重试。');
      });
    }, 2000);

    return () => {
      window.clearInterval(timer);
    };
  }, [fetchPackagingBatch, packagingBatch?.id, packagingBatch?.status]);

  useEffect(() => {
    if (processingRef.current) {
      return;
    }
    if (claimingTaskIdRef.current) {
      return;
    }
    if (queuePausedByUnknown) {
      return;
    }

    const nextTask = queue.find(
      (task) => task.status === 'waiting' && !dispatchedTaskIdsRef.current.has(task.taskId),
    );
    if (!nextTask) {
      return;
    }

    claimingTaskIdRef.current = nextTask.taskId;
    const abortController = new AbortController();
    const requestStartedAt = Date.now();
    let lastStatusReceivedAt: number | undefined;
    const waitConfig = getImageGenerationClientWaitConfig(nextTask);
    const runningLease = createImageGenerationLease({
      localTaskId: nextTask.taskId,
      taskType: nextTask.taskType,
      jobFingerprint: nextTask.jobFingerprint,
      hardTimeoutMs: waitConfig.hardTimeoutMs,
      status: 'running',
      startedAt: requestStartedAt,
      tabSessionId: tabSessionIdRef.current,
    });

    const startClaimedTask = async () => {
      try {
        const claim = await claimImageGenerationLease(runningLease, {
          force: nextTask.forceBrowserLeaseClaim === true,
        });
        if (claimingTaskIdRef.current === nextTask.taskId) {
          claimingTaskIdRef.current = null;
        }
        if (!isMountedRef.current) {
          clearImageGenerationLease({
            localTaskId: nextTask.taskId,
            tabSessionId: tabSessionIdRef.current,
          });
          return;
        }
        if (!claim.ok) {
          logImageGenerationLivenessEvent('queue_lease_claim_blocked', {
            taskId: nextTask.taskId,
            requestType: nextTask.taskType,
            blockingLeaseTaskId: claim.blockingLease?.localTaskId ?? null,
            blockingLeaseStatus: claim.blockingLease?.status ?? null,
            blockReason: claim.reason,
            activeCount: claim.activeCount,
          });
          setBrowserGenerationLeases(getActiveImageGenerationLeases());
          setError(
            claim.reason === 'concurrency_limit'
              ? IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE
              : IMAGE_GENERATION_CROSS_TAB_DUPLICATE_MESSAGE,
          );
          return;
        }
      } catch (claimError) {
        if (claimingTaskIdRef.current === nextTask.taskId) {
          claimingTaskIdRef.current = null;
        }
        if (isMountedRef.current) {
          logImageGenerationLivenessEvent('queue_lease_claim_failed', {
            taskId: nextTask.taskId,
            requestType: nextTask.taskType,
            error: claimError instanceof Error ? claimError.message : 'unknown',
          });
          setBrowserGenerationLeases(getActiveImageGenerationLeases());
          setError(IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE);
        }
        return;
      }

      dispatchedTaskIdsRef.current.add(nextTask.taskId);
      queueAbortControllerRef.current = abortController;
      processingRef.current = true;
      setBrowserGenerationLeases(getActiveImageGenerationLeases());
      logImageGenerationLivenessEvent('queue_request_started', {
        taskId: nextTask.taskId,
        requestType: nextTask.taskType,
        requestStartedAt,
        waitProfile: waitConfig.profile,
        softTimeoutMs: waitConfig.softTimeoutMs,
        hardTimeoutMs: waitConfig.hardTimeoutMs,
      });
      setQueue((items) =>
        items.map((task) =>
          task.taskId === nextTask.taskId
            ? {
                ...task,
                status: 'running',
                state: 'running',
                errorMessage: '',
                waitMessage: '',
                resultImages: [],
              }
            : task,
        ),
      );

      withImageGenerationClientWait(
        (signal) =>
          runQueueTask(nextTask, {
            signal,
            onStatus: (taskStatus) => {
              if (!isMountedRef.current || abortController.signal.aborted) {
                return;
              }
              lastStatusReceivedAt = Date.now();
              writeImageGenerationLease({
                ...runningLease,
                leaseExpiresAt: lastStatusReceivedAt + waitConfig.hardTimeoutMs,
              });
              upsertStoredImageGenerationAsyncTask(nextTask, taskStatus);
              const queueState = getQueueStateFromInternalTaskStatus(taskStatus);
              const waitMessage = getInternalTaskWaitMessage(taskStatus);
              setQueue((items) =>
                items.map((task) =>
                  task.taskId === nextTask.taskId
                    ? {
                        ...task,
                        status: queueState === 'status_unknown' ? 'status_unknown' : 'running',
                        state: queueState,
                        internalTaskId: taskStatus.internalTaskId ?? task.internalTaskId ?? null,
                        requestId: taskStatus.requestId ?? task.requestId ?? null,
                        waitMessage,
                      }
                    : task,
                ),
              );
            },
          }),
        {
          signal: abortController.signal,
          softTimeoutMs: waitConfig.softTimeoutMs,
          hardTimeoutMs: waitConfig.hardTimeoutMs,
          getLastStatusReceivedAt: () => lastStatusReceivedAt,
          onSoftTimeout: () => {
            if (!isMountedRef.current || abortController.signal.aborted) {
              return;
            }
            logImageGenerationLivenessEvent('queue_soft_wait_reached', {
              taskId: nextTask.taskId,
              requestType: nextTask.taskType,
              waitProfile: waitConfig.profile,
              elapsedMs: Date.now() - requestStartedAt,
              softTimeoutMs: waitConfig.softTimeoutMs,
              hardTimeoutMs: waitConfig.hardTimeoutMs,
            });
            setQueue((items) =>
              items.map((task) =>
                task.taskId === nextTask.taskId && task.status === 'running'
                  ? { ...task, waitMessage: IMAGE_GENERATION_CLIENT_SOFT_WAIT_MESSAGE }
                  : task,
              ),
            );
          },
        },
      )
        .then((resultImages) => {
          if (!isMountedRef.current || abortController.signal.aborted) {
            return;
          }
          logImageGenerationLivenessEvent('queue_request_succeeded', {
            taskId: nextTask.taskId,
            requestType: nextTask.taskType,
            elapsedMs: Date.now() - requestStartedAt,
          });
          setQueue((items) =>
            items.map((task) =>
              task.taskId === nextTask.taskId
                ? {
                    ...task,
                    status: 'success',
                    state: 'success',
                    resultImages,
                    errorMessage: '',
                    waitMessage: '',
                  }
                : task,
            ),
          );
          clearImageGenerationLease({
            localTaskId: nextTask.taskId,
            tabSessionId: tabSessionIdRef.current,
          });
          setBrowserGenerationLeases(getActiveImageGenerationLeases());
          notifyTaskCompleted(nextTask.taskId);
        })
        .catch((err: unknown) => {
          if (!isMountedRef.current) {
            return;
          }
          const apiError = err as {
            response?: {
              status?: number;
              data?: {
                message?: string;
                errorCode?: string;
                requestId?: string;
                state?: QueueTaskStatus;
                status?: QueueTaskStatus;
                internalTaskId?: string;
              };
            };
            message?: string;
          };
          const responseData = apiError.response?.data;
          const isClientWaitError = isImageGenerationClientWaitError(err);
          const isSubmissionResponseLost =
            apiError.response?.status === 524 && !responseData?.state && !responseData?.status;
          const errorMessage = getImageGenerationErrorMessage({
            taskType: nextTask.taskType,
            errorCode: isClientWaitError ? err.errorCode : responseData?.errorCode,
            message: isClientWaitError ? err.message : responseData?.message || apiError.message,
          });
          const isUnknownStatus =
            responseData?.state === 'status_unknown' ||
            responseData?.status === 'status_unknown' ||
            isSubmissionResponseLost;
          const status = isClientWaitError
            ? err.state === 'client_timeout'
              ? 'status_unknown'
              : 'cancelled'
            : isUnknownStatus
              ? 'status_unknown'
              : 'failed';
          const state = isClientWaitError ? err.state : status;
          if (responseData?.internalTaskId) {
            upsertStoredImageGenerationAsyncTask(
              nextTask,
              responseData as InternalImageGenerationTaskResponse,
            );
          }
          if (status === 'status_unknown') {
            setQueuePausedByUnknown(true);
            const unknownLease = createImageGenerationLease({
              localTaskId: nextTask.taskId,
              taskType: nextTask.taskType,
              jobFingerprint: nextTask.jobFingerprint,
              hardTimeoutMs: waitConfig.unknownProtectionMs,
              status: 'status_unknown',
              tabSessionId: tabSessionIdRef.current,
            });
            writeImageGenerationLease(unknownLease);
            setBrowserGenerationLeases(getActiveImageGenerationLeases());
          } else {
            clearImageGenerationLease({
              localTaskId: nextTask.taskId,
              tabSessionId: tabSessionIdRef.current,
            });
            setBrowserGenerationLeases(getActiveImageGenerationLeases());
          }
          logImageGenerationLivenessEvent('queue_request_finished_without_success', {
            taskId: nextTask.taskId,
            requestType: nextTask.taskType,
            finalStatus: status,
            errorCode: isClientWaitError ? err.errorCode : responseData?.errorCode,
            elapsedMs: Date.now() - requestStartedAt,
          });
          setQueue((items) =>
            items.map((task) =>
              task.taskId === nextTask.taskId
                ? {
                    ...task,
                    status,
                    state,
                    errorMessage,
                    waitMessage: '',
                    errorCode: isClientWaitError
                      ? err.errorCode
                      : isSubmissionResponseLost
                        ? 'IMAGE_GENERATION_SUBMIT_RESULT_UNKNOWN'
                        : (responseData?.errorCode ?? null),
                    requestId: responseData?.requestId ?? task.requestId ?? null,
                    internalTaskId: responseData?.internalTaskId ?? task.internalTaskId ?? null,
                    resultImages: [],
                  }
                : task,
            ),
          );
        })
        .finally(() => {
          if (queueAbortControllerRef.current === abortController) {
            queueAbortControllerRef.current = null;
          }
          processingRef.current = false;
          logImageGenerationLivenessEvent('queue_processing_released', {
            taskId: nextTask.taskId,
            requestType: nextTask.taskType,
            elapsedMs: Date.now() - requestStartedAt,
          });
          if (isMountedRef.current) {
            setQueue((items) => [...items]);
          }
        });
    };

    void startClaimedTask();
  }, [notifyTaskCompleted, queue, queuePausedByUnknown, browserLeaseSignature]);

  const handleEnqueueTask = async (options: { ignoreBrowserGenerationLease?: boolean } = {}) => {
    if (hasUnresolvedUnknownTask) {
      setError('当前已有状态无法确认的任务。请先删除该任务，或确认风险后继续队列。');
      return;
    }

    const enqueuePreparedTask = async (taskBase: Omit<ImageQueueTask, 'jobFingerprint'>) => {
      const jobFingerprint = await createImageGenerationJobFingerprint(
        buildImageGenerationTaskFingerprintDescriptor({
          ...taskBase,
          jobFingerprint: '',
        }),
      );
      let forceBrowserLeaseClaim = options.ignoreBrowserGenerationLease === true;
      let activeLeases = getActiveImageGenerationLeases();
      setBrowserGenerationLeases(activeLeases);
      if (activeLeases.length >= IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT) {
        setError(IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE);
        return;
      }

      const duplicateLease = activeLeases.find(
        (lease) =>
          lease.tabSessionId !== tabSessionIdRef.current && lease.jobFingerprint === jobFingerprint,
      );
      if (duplicateLease && !forceBrowserLeaseClaim) {
        if (typeof window === 'undefined') {
          setError(IMAGE_GENERATION_CROSS_TAB_DUPLICATE_MESSAGE);
          return;
        }
        const confirmed = window.confirm(IMAGE_GENERATION_CROSS_TAB_DUPLICATE_MESSAGE);
        if (!confirmed) {
          setError(IMAGE_GENERATION_CROSS_TAB_DUPLICATE_MESSAGE);
          return;
        }
        activeLeases = getActiveImageGenerationLeases();
        setBrowserGenerationLeases(activeLeases);
        if (activeLeases.length >= IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT) {
          setError(IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE);
          return;
        }
        forceBrowserLeaseClaim = true;
      }

      setError('');
      setQueue((items) => [
        ...items,
        {
          ...taskBase,
          jobFingerprint,
          forceBrowserLeaseClaim,
        },
      ]);
    };

    if (isWhiteBackground) {
      if (!whiteBackgroundImage) {
        setError('请先上传需要生成白底图的商品图。');
        return;
      }

      const task: Omit<ImageQueueTask, 'jobFingerprint'> = {
        taskId: createTaskId(),
        taskType,
        platform,
        imageType,
        model: '',
        prompt: '',
        aspectRatio,
        count: 1,
        inputImages: [
          {
            role: '商品原图',
            name: whiteBackgroundImage.name,
            previewUrl: URL.createObjectURL(whiteBackgroundImage),
            file: whiteBackgroundImage,
          },
        ],
        sourceImage: whiteBackgroundImage,
        createdAt: new Date().toISOString(),
        status: 'waiting',
        state: 'waiting',
        resultImages: [],
        errorMessage: '',
        waitMessage: '',
        forceBrowserLeaseClaim: false,
      };
      void enqueuePreparedTask(task);
      return;
    }

    if (!prompt.trim()) {
      setError(
        isImageToImage
          ? '请先填写改图需求。'
          : isDualProductReplace
            ? '请先填写生成需求。'
            : '请先填写提示词。',
      );
      return;
    }

    if (isImageToImage && !whiteBackgroundImage) {
      setError('请先上传白底图。');
      return;
    }

    if (isDualProductReplace) {
      if (!benchmarkImage || !productImage) {
        setError('多图商品替换需要上传 1 张商品图和至少 1 张对标/参考图。');
        return;
      }
    }

    const inputImages: QueueInputImage[] = [];
    if (isImageToImage && whiteBackgroundImage) {
      inputImages.push({
        role: '白底图',
        name: whiteBackgroundImage.name,
        previewUrl: URL.createObjectURL(whiteBackgroundImage),
        file: whiteBackgroundImage,
      });
    }

    if (isDualProductReplace) {
      if (benchmarkImage) {
        inputImages.push({
          role: '对标/参考图 1',
          name: benchmarkImage.name,
          previewUrl: URL.createObjectURL(benchmarkImage),
          file: benchmarkImage,
        });
      }
      if (productImage) {
        inputImages.push({
          role: '商品图',
          name: productImage.name,
          previewUrl: URL.createObjectURL(productImage),
          file: productImage,
        });
      }
      if (extraReferenceImage) {
        inputImages.push({
          role: '对标/参考图 2',
          name: extraReferenceImage.name,
          previewUrl: URL.createObjectURL(extraReferenceImage),
          file: extraReferenceImage,
        });
      }
    }

    const task: Omit<ImageQueueTask, 'jobFingerprint'> = {
      taskId: createTaskId(),
      taskType,
      modelKey: selectedModel.modelKey,
      platform,
      imageType,
      model: selectedModel.model,
      prompt: prompt.trim(),
      aspectRatio,
      outputQuality: getTaskOutputQuality({ taskType, generationTab, outputQuality }),
      count: isImageEditTask ? 1 : count,
      inputImages,
      sourceImage: isImageToImage ? (whiteBackgroundImage ?? undefined) : undefined,
      benchmarkImage: isDualProductReplace ? (benchmarkImage ?? undefined) : undefined,
      extraReferenceImage: isDualProductReplace ? (extraReferenceImage ?? undefined) : undefined,
      productImage: isDualProductReplace ? (productImage ?? undefined) : undefined,
      createdAt: new Date().toISOString(),
      status: 'waiting',
      state: 'waiting',
      resultImages: [],
      errorMessage: '',
      waitMessage: '',
      forceBrowserLeaseClaim: false,
    };

    void enqueuePreparedTask(task);
  };

  const handleRetryTask = (taskId: string) => {
    dispatchedTaskIdsRef.current.delete(taskId);
    removeStoredImageGenerationAsyncTask(taskId);
    setQueue((items) =>
      items.map((task) =>
        task.taskId === taskId
          ? {
              ...task,
              status: 'waiting',
              state: 'waiting',
              errorMessage: '',
              waitMessage: '',
              resultImages: [],
              requestId: null,
              internalTaskId: null,
            }
          : task,
      ),
    );
  };

  const handleConfirmContinueQueue = () => {
    if (typeof window === 'undefined') {
      return;
    }
    const confirmed = window.confirm(IMAGE_GENERATION_CONTINUE_QUEUE_RISK_MESSAGE);
    if (!confirmed) {
      return;
    }
    setQueue((items) =>
      items.map((task) =>
        task.status === 'waiting' ? { ...task, forceBrowserLeaseClaim: true } : task,
      ),
    );
    setQueuePausedByUnknown(false);
    setError('');
  };

  const handleDeleteTask = (taskId: string) => {
    const target = queue.find((task) => task.taskId === taskId);
    const visualState = target ? getTaskVisualState(target) : null;
    if (!target || (visualState && isGeneratingStatus(visualState))) {
      return;
    }
    if (
      visualState === 'status_unknown' &&
      typeof window !== 'undefined' &&
      !window.confirm(IMAGE_GENERATION_REMOVE_UNKNOWN_TASK_MESSAGE)
    ) {
      return;
    }
    statusQueryControllersRef.current.get(taskId)?.abort();
    if (visualState === 'status_unknown') {
      clearImageGenerationLease({
        localTaskId: taskId,
        tabSessionId: tabSessionIdRef.current,
      });
      setBrowserGenerationLeases(getActiveImageGenerationLeases());
    }

    setQueue((items) => {
      const currentTarget = items.find((task) => task.taskId === taskId);
      if (currentTarget && isGeneratingStatus(getTaskVisualState(currentTarget))) {
        return items;
      }
      if (currentTarget) {
        revokeTaskPreviews(currentTarget);
        removeStoredImageGenerationAsyncTask(currentTarget.taskId);
      }
      return items.filter((task) => task.taskId !== taskId);
    });
  };

  const handleClearSuccessTasks = () => {
    setQueue((items) => {
      const successfulTasks = items.filter((task) => task.status === 'success');
      successfulTasks.forEach(revokeTaskPreviews);
      removeStoredSuccessfulImageGenerationAsyncTasks(successfulTasks.map((task) => task.taskId));
      return items.filter((task) => task.status !== 'success');
    });
  };

  return (
    <>
      <div className="h-full overflow-y-auto bg-surface-primary text-text-primary">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
          {!isSkuSourceWorkflow && (
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-light pb-5">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-active-alt">
                  <Sparkles className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <h1 className="text-2xl font-semibold">AI 生图</h1>
                  <p className="text-sm text-text-secondary">
                    多平台电商文生图、单图改图与多图商品替换。
                  </p>
                </div>
              </div>
            </header>
          )}

          {isSkuSourceWorkflow ? (
            <div className="rounded-lg border border-border-light bg-surface-primary-alt px-4 py-3 text-sm text-text-secondary">
              在 SKU 图制作中完成单图改图。生成结果后点击「用作 SKU 源图」进入排版批量。
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={[
                  'rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
                  generationTab === 'single'
                    ? 'border-border-medium bg-surface-active-alt'
                    : 'border-border-light bg-surface-primary hover:bg-surface-hover',
                ].join(' ')}
                onClick={() => setGenerationTab('single')}
              >
                单次生成
              </button>
              <button
                type="button"
                className={[
                  'rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
                  generationTab === 'batch-packaging'
                    ? 'border-border-medium bg-surface-active-alt'
                    : 'border-border-light bg-surface-primary hover:bg-surface-hover',
                ].join(' ')}
                onClick={() => setGenerationTab('batch-packaging')}
              >
                批量包装生成
              </button>
            </div>
          )}

          {generationTab === 'single' ? (
            <div className="grid gap-6 lg:grid-cols-[420px_minmax(0,1fr)]">
              <section
                className="flex flex-col gap-5 rounded-lg border border-border-light bg-surface-primary-alt p-5"
                onPaste={handlePasteUpload}
              >
                <div className="grid gap-3">
                  <label className="text-sm font-medium">任务类型</label>
                  {isSkuSourceWorkflow ? (
                    <div className="rounded-lg border border-border-medium bg-surface-active-alt px-3 py-2 text-sm font-medium">
                      单图改图
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className={[
                          'rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                          taskType === 'text-to-image'
                            ? 'border-border-medium bg-surface-active-alt'
                            : 'border-border-light bg-surface-primary hover:bg-surface-hover',
                        ].join(' ')}
                        onClick={() => handleTaskTypeChange('text-to-image')}
                      >
                        文生图
                      </button>
                      <button
                        type="button"
                        className={[
                          'rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                          taskType === 'image-to-image'
                            ? 'border-border-medium bg-surface-active-alt'
                            : 'border-border-light bg-surface-primary hover:bg-surface-hover',
                        ].join(' ')}
                        onClick={() => handleTaskTypeChange('image-to-image')}
                      >
                        单图改图
                      </button>
                      <button
                        type="button"
                        className={[
                          'rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                          taskType === 'dual-product-replace'
                            ? 'border-border-medium bg-surface-active-alt'
                            : 'border-border-light bg-surface-primary hover:bg-surface-hover',
                        ].join(' ')}
                        onClick={() => handleTaskTypeChange('dual-product-replace')}
                      >
                        多图商品替换
                      </button>
                      <button
                        type="button"
                        className={[
                          'rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                          taskType === 'white-background'
                            ? 'border-border-medium bg-surface-active-alt'
                            : 'border-border-light bg-surface-primary hover:bg-surface-hover',
                        ].join(' ')}
                        onClick={() => handleTaskTypeChange('white-background')}
                      >
                        商品白底图生成
                      </button>
                    </div>
                  )}
                </div>

                {isImageToImage && (
                  <div className="grid gap-3">
                    <label className="text-sm font-medium">改图模式</label>
                    <div className="rounded-lg border border-border-medium bg-surface-active-alt px-3 py-2 text-sm font-medium">
                      白底图场景化
                    </div>
                  </div>
                )}

                {!isWhiteBackground && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="grid gap-2 text-sm font-medium">
                        平台
                        <select
                          value={platform}
                          className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-blue-500"
                          onChange={(event) => handlePlatformChange(event.target.value)}
                        >
                          {config.platforms.map((item) => (
                            <option key={item} value={item}>
                              {item}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="grid gap-2 text-sm font-medium">
                        图片类型
                        <select
                          value={imageType}
                          className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-blue-500"
                          onChange={(event) => handleImageTypeChange(event.target.value)}
                        >
                          {config.imageTypes.map((item) => (
                            <option key={item} value={item}>
                              {item}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {renderModelSelect()}
                    {isSeedreamProSelected && (
                      <div className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
                        Seedream 5.0 Pro
                        是即梦新推出的高质量生图模型。上线初期使用人数较多时，生成可能稍慢或排队，请耐心等待。
                      </div>
                    )}
                  </>
                )}

                {isSingleUploadTask && (
                  <div className="grid gap-3">
                    <div>
                      <label className="text-sm font-medium">
                        {isWhiteBackground ? '上传商品图' : '上传白底图'}
                      </label>
                      <p className="mt-1 text-xs text-text-secondary">
                        {isWhiteBackground
                          ? '上传商品图，系统会调用硅基流动图像编辑模型，生成干净白色背景的电商商品图。该功能为生成式白底重绘，可能轻微改变商品细节，请人工确认后使用。'
                          : '用于识别真实商品主体，系统会根据平台和图片类型生成更适合投放的场景化图片。建议上传无水印、无二维码、无明显平台标识的图片，成功率更高。'}
                      </p>
                    </div>
                    <label
                      className={[
                        'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-5 text-center transition-colors hover:bg-surface-hover',
                        isSingleUploadDragging
                          ? 'border-blue-500 bg-blue-50/70 dark:bg-blue-950/20'
                          : 'border-border-medium bg-surface-primary',
                      ].join(' ')}
                      onDragOver={(event) => handleUploadDragOver(event, 'single')}
                      onDragLeave={(event) => handleUploadDragLeave(event, 'single')}
                      onDrop={(event) => handleUploadDrop(event, 'single')}
                    >
                      <Upload className="h-6 w-6 text-text-secondary" />
                      <span className="text-sm font-medium">
                        点击上传 / 拖拽图片到这里 / 粘贴图片
                      </span>
                      <span className="text-xs text-text-secondary">
                        PNG、JPG/JPEG、WebP，单张不超过 8MB
                      </span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={(event) => handleUploadChange(event.target.files?.[0])}
                      />
                    </label>
                    {whiteBackgroundPreview && (
                      <figure className="overflow-hidden rounded-lg border border-border-light bg-surface-primary">
                        <img
                          src={whiteBackgroundPreview}
                          alt="白底图预览"
                          className="max-h-72 w-full object-contain"
                        />
                        <figcaption className="truncate px-3 py-2 text-xs text-text-secondary">
                          {whiteBackgroundImage?.name}
                        </figcaption>
                      </figure>
                    )}
                  </div>
                )}

                {isDualProductReplace && (
                  <div className="grid gap-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">上传参考图</div>
                        <p className="mt-1 text-xs text-text-secondary">
                          上传 1 张商品图 + 1-2 张对标/参考图，最多 3
                          张。系统会参考多张图片完成商品替换或风格融合。
                        </p>
                        <p className="mt-1 text-xs text-text-secondary">
                          已满后，可选择图片进行替换，或删除后继续粘贴/上传。
                        </p>
                        <p className="mt-1 text-xs text-text-secondary">
                          已使用 {multiReferenceImageCount} / {MAX_MULTI_REFERENCE_IMAGES} 张图
                          {selectedMultiReferenceSlotLabel
                            ? `，当前替换目标：${selectedMultiReferenceSlotLabel}`
                            : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={!hasReferenceImages}
                          onClick={handleClearReferenceImages}
                          className="rounded-lg border border-border-medium px-3 py-2 text-xs text-text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          清空参考图
                        </button>
                        <button
                          type="button"
                          disabled={!multiReferenceImageCount}
                          onClick={handleClearAllMultiReferenceImages}
                          className="rounded-lg border border-border-medium px-3 py-2 text-xs text-text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          清空全部
                        </button>
                      </div>
                    </div>
                    <div
                      className={[
                        'grid gap-3 rounded-lg border border-dashed p-2 transition-colors sm:grid-cols-3',
                        isMultiUploadDragging
                          ? 'border-blue-500 bg-blue-50/70 dark:bg-blue-950/20'
                          : 'border-transparent',
                      ].join(' ')}
                      onDragOver={(event) => handleUploadDragOver(event, 'multi')}
                      onDragLeave={(event) => handleUploadDragLeave(event, 'multi')}
                      onDrop={(event) => handleUploadDrop(event, 'multi')}
                    >
                      {MULTI_REFERENCE_RENDER_ORDER.map((slotId) => {
                        const slot = MULTI_REFERENCE_SLOTS.find((item) => item.id === slotId);
                        if (!slot) {
                          return null;
                        }
                        const image = multiReferenceImages[slotId];
                        const preview = multiReferencePreviews[slotId];
                        const selected = selectedMultiReferenceSlot === slotId;
                        const handleChange =
                          slotId === 'benchmark'
                            ? handleBenchmarkUploadChange
                            : slotId === 'product'
                              ? handleProductUploadChange
                              : handleExtraReferenceUploadChange;

                        return (
                          <div key={slot.id} data-testid={`multi-reference-slot-${slot.id}`}>
                            {image && preview ? (
                              <figure
                                className={[
                                  'group h-full overflow-hidden rounded-lg border bg-surface-primary transition-colors',
                                  selected
                                    ? 'border-blue-500 ring-2 ring-blue-500/30'
                                    : 'border-border-light',
                                ].join(' ')}
                              >
                                <button
                                  type="button"
                                  onClick={() => setSelectedMultiReferenceSlot(slotId)}
                                  aria-label={`选择${slot.role}作为粘贴替换目标`}
                                  className="relative flex w-full items-center justify-center bg-surface-primary"
                                >
                                  <img
                                    src={preview}
                                    alt={slot.previewAlt}
                                    className="max-h-56 w-full object-contain"
                                  />
                                  {selected && (
                                    <span className="absolute left-2 top-2 rounded bg-surface-active-alt px-2 py-1 text-xs font-medium text-text-primary">
                                      当前替换目标
                                    </span>
                                  )}
                                </button>
                                <figcaption className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-text-secondary">
                                  <span className="min-w-0 truncate">
                                    {slot.role}：{image.name}
                                  </span>
                                  <span className="flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                                    <label className="cursor-pointer rounded border border-border-medium px-2 py-1 hover:bg-surface-hover">
                                      替换
                                      <input
                                        type="file"
                                        accept="image/png,image/jpeg,image/webp"
                                        className="hidden"
                                        onChange={(event) => {
                                          handleMultiReferenceSlotFile(
                                            slotId,
                                            event.target.files?.[0],
                                          );
                                          setSelectedMultiReferenceSlot(null);
                                          event.currentTarget.value = '';
                                        }}
                                      />
                                    </label>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteMultiReferenceSlot(slotId)}
                                      aria-label={`删除${slot.role}`}
                                      className="rounded border border-border-medium px-2 py-1 hover:bg-surface-hover"
                                    >
                                      删除
                                    </button>
                                  </span>
                                </figcaption>
                              </figure>
                            ) : (
                              <label className="flex h-full min-h-36 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-medium bg-surface-primary px-4 py-5 text-center hover:bg-surface-hover">
                                <Upload className="h-6 w-6 text-text-secondary" />
                                <span className="text-sm font-medium">{slot.uploadLabel}</span>
                                <span className="text-xs text-text-secondary">
                                  {slot.uploadHint}
                                </span>
                                <input
                                  type="file"
                                  accept="image/png,image/jpeg,image/webp"
                                  className="hidden"
                                  onChange={(event) => {
                                    handleChange(event.target.files?.[0]);
                                    event.currentTarget.value = '';
                                  }}
                                />
                              </label>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {!isWhiteBackground && (
                  <>
                    <label className="grid gap-2 text-sm font-medium">
                      {isImageToImage || isDualProductReplace ? '生成需求' : '提示词'}
                      <textarea
                        value={prompt}
                        rows={6}
                        className="resize-none rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-blue-500"
                        placeholder={
                          isImageToImage
                            ? '例如：把这张白底商品图做成小红书种草图，增加自然光、生活化桌面场景，突出高级感'
                            : isDualProductReplace
                              ? '例如：以商品图为主体，参考多张对标图的构图、场景和氛围，做成淘宝商品主图，突出高级感和卖点'
                              : '例如：白色保温杯，适合办公室女性使用，突出高级感和保温效果'
                        }
                        onChange={(event) => setPrompt(event.target.value)}
                      />
                    </label>

                    <div className="grid gap-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">比例</span>
                        <span className="text-xs text-text-secondary">
                          推荐：{recommendedAspectRatio}
                        </span>
                      </div>
                      <div className="grid grid-cols-5 gap-2">
                        {config.aspectRatios.map((item) => (
                          <button
                            key={item}
                            type="button"
                            className={[
                              'rounded-lg border px-2 py-2 text-sm transition-colors',
                              aspectRatio === item
                                ? 'border-blue-500 bg-blue-500 text-white'
                                : 'border-border-medium bg-surface-primary hover:bg-surface-hover',
                            ].join(' ')}
                            onClick={() => {
                              setAspectRatio(item);
                              setManualAspectRatio(true);
                            }}
                          >
                            {item}
                          </button>
                        ))}
                      </div>
                    </div>

                    {supportsOutputQuality && (
                      <div className="grid gap-3">
                        <span className="text-sm font-medium">输出清晰度</span>
                        <div className="grid grid-cols-3 gap-2">
                          {outputQualityOptions.map((item) => (
                            <button
                              key={item.value}
                              type="button"
                              className={[
                                'min-h-16 rounded-lg border px-2 py-2 text-center transition-colors',
                                outputQuality === item.value
                                  ? 'border-blue-500 bg-blue-500 text-white'
                                  : 'border-border-medium bg-surface-primary hover:bg-surface-hover',
                              ].join(' ')}
                              onClick={() => setOutputQuality(normalizeOutputQuality(item.value))}
                            >
                              <span className="block text-sm font-medium">{item.label}</span>
                              <span
                                className={[
                                  'mt-1 block text-xs leading-snug',
                                  outputQuality === item.value
                                    ? 'text-white/85'
                                    : 'text-text-secondary',
                                ].join(' ')}
                              >
                                {item.description}
                              </span>
                            </button>
                          ))}
                        </div>
                        {generationCountNotice && (
                          <p className="text-xs text-text-secondary">{generationCountNotice}</p>
                        )}
                      </div>
                    )}

                    {isImageEditTask ? (
                      <div className="grid gap-2">
                        <span className="text-sm font-medium">生成数量</span>
                        <div className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm text-text-secondary">
                          {isImageToImage ? '单图改图固定生成 1 张' : '多图商品替换固定生成 1 张'}
                        </div>
                      </div>
                    ) : (
                      <div className="grid gap-3">
                        <span className="text-sm font-medium">生成数量</span>
                        <div className="grid grid-cols-3 gap-2">
                          {config.counts.map((item) => (
                            <button
                              key={item}
                              type="button"
                              disabled={!supportedGenerationCounts.includes(item)}
                              aria-label={`生成 ${item} 张`}
                              className={[
                                'rounded-lg border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                                count === item
                                  ? 'border-blue-500 bg-blue-500 text-white'
                                  : 'border-border-medium bg-surface-primary hover:bg-surface-hover',
                              ].join(' ')}
                              onClick={() => setCount(item)}
                            >
                              {item}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}

                <button
                  type="button"
                  disabled={hasUnresolvedUnknownTask || crossTabConcurrencyLimitReached}
                  className="mt-1 flex h-11 items-center justify-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-surface-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => handleEnqueueTask()}
                >
                  <Sparkles className="h-4 w-4" />
                  加入生成队列
                </button>

                {activeBrowserGenerationCount > 0 &&
                  !crossTabConcurrencyLimitReached &&
                  !duplicateBrowserGenerationLease && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
                      {getImageGenerationCrossTabAvailabilityMessage(activeBrowserGenerationCount)}
                    </div>
                  )}

                {crossTabConcurrencyLimitReached && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                    {IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE}
                  </div>
                )}

                {duplicateBrowserGenerationLease && !crossTabConcurrencyLimitReached && (
                  <div className="grid gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                    <div>{IMAGE_GENERATION_CROSS_TAB_DUPLICATE_MESSAGE}</div>
                    <div>
                      {getImageGenerationCrossTabAvailabilityMessage(activeBrowserGenerationCount)}
                    </div>
                  </div>
                )}

                {hasUnresolvedUnknownTask && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                    当前已有状态无法确认的任务。为避免重复生成，请先处理该任务，或确认风险后继续已排队任务。
                  </div>
                )}

                {error && (
                  <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                    {error}
                  </div>
                )}
              </section>

              <section className="min-h-[560px] rounded-lg border border-border-light bg-surface-primary-alt p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">生成队列</h2>
                    <p className="text-sm text-text-secondary">
                      任务会按提交顺序串行生成，已完成图片可直接下载。
                    </p>
                  </div>
                  {queue.some((task) => task.status === 'success') && (
                    <button
                      type="button"
                      className="rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                      onClick={handleClearSuccessTasks}
                    >
                      清空已完成
                    </button>
                  )}
                </div>

                {queue.length === 0 && !error && (
                  <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-medium bg-surface-primary text-center">
                    <ImageIcon className="h-10 w-10 text-text-secondary" />
                    <div>
                      <p className="text-sm font-medium">队列为空</p>
                      <p className="text-sm text-text-secondary">
                        填写左侧表单后点击“加入生成队列”。
                      </p>
                    </div>
                  </div>
                )}

                {queue.length > 0 && (
                  <div className="grid gap-4">
                    {queuePausedByUnknown && hasUnresolvedUnknownTask && (
                      <div className="grid gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                        <div className="font-medium">队列已暂停</div>
                        <div>{IMAGE_GENERATION_CONTINUE_QUEUE_RISK_MESSAGE}</div>
                        {hasWaitingQueueTask && (
                          <button
                            type="button"
                            className="w-fit rounded-md bg-amber-700 px-3 py-2 text-sm font-medium text-white hover:bg-amber-800"
                            onClick={handleConfirmContinueQueue}
                          >
                            确认风险并继续队列
                          </button>
                        )}
                      </div>
                    )}
                    <div className="grid gap-4">
                      {queue.map((task, index) => {
                        const visualState = getTaskVisualState(task);
                        const statusLabel = getTaskDisplayState(task);
                        const isRunning = isGeneratingStatus(visualState);
                        return (
                          <article
                            key={task.taskId}
                            className={[
                              'grid gap-4 rounded-lg border p-4 transition-colors',
                              visualState === 'success'
                                ? 'border-green-300 bg-green-50/40 dark:border-green-900/60 dark:bg-green-950/10'
                                : 'border-border-light bg-surface-primary',
                            ].join(' ')}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="grid gap-1">
                                <div
                                  className={[
                                    'text-sm font-medium',
                                    visualState === 'success'
                                      ? 'text-green-700 dark:text-green-300'
                                      : visualState === 'failed'
                                        ? 'text-red-700 dark:text-red-300'
                                        : visualState === 'degraded' ||
                                            visualState === 'status_unknown'
                                          ? 'text-amber-700 dark:text-amber-300'
                                          : visualState === 'running'
                                            ? 'text-blue-700 dark:text-blue-300'
                                            : 'text-text-secondary',
                                  ].join(' ')}
                                >
                                  任务 {index + 1} 状态：{statusLabel}
                                </div>
                                {visualState === 'status_unknown' && (
                                  <div className="break-all text-xs text-text-secondary">
                                    {localize('com_ui_image_task_reference', {
                                      id: task.internalTaskId ?? task.taskId,
                                    })}
                                  </div>
                                )}
                              </div>

                              <div className="flex flex-wrap gap-2">
                                {task.internalTaskId && visualState === 'status_unknown' && (
                                  <button
                                    type="button"
                                    className="flex items-center gap-1 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                                    onClick={() => {
                                      void resumeInternalTask(task);
                                    }}
                                  >
                                    <RotateCcw className="h-4 w-4" />
                                    {localize('com_ui_image_resume_status')}
                                  </button>
                                )}
                                {visualState === 'failed' && (
                                  <button
                                    type="button"
                                    className="flex items-center gap-1 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                                    onClick={() => handleRetryTask(task.taskId)}
                                  >
                                    <RotateCcw className="h-4 w-4" />
                                    重试
                                  </button>
                                )}
                                {!isGeneratingStatus(visualState) && (
                                  <button
                                    type="button"
                                    className="flex items-center gap-1 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                                    onClick={() => handleDeleteTask(task.taskId)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                    {visualState === 'status_unknown' ? '移除本地记录' : '删除'}
                                  </button>
                                )}
                              </div>
                            </div>

                            {isRunning && (
                              <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-border-light bg-surface-primary-alt px-4 text-center text-sm text-text-secondary">
                                <Loader2 className="h-5 w-5 animate-spin" />
                                <div>AI 正在生成图片，请稍等</div>
                                <div className="text-xs opacity-80">复杂任务可能需要1–3分钟</div>
                                {task.waitMessage && (
                                  <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                                    {task.waitMessage}
                                  </div>
                                )}
                              </div>
                            )}

                            {visualState === 'failed' && (
                              <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                                <div>{task.errorMessage || '生成失败，请稍后重试。'}</div>
                              </div>
                            )}

                            {visualState === 'status_unknown' && (
                              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                                <div>
                                  {task.errorCode === IMAGE_GENERATION_STATUS_QUERY_INTERRUPTED ||
                                  (task.internalTaskId &&
                                    task.errorCode === IMAGE_GENERATION_CLIENT_TIMEOUT_ERROR_CODE)
                                    ? localize('com_ui_image_status_interrupted')
                                    : task.errorCode === 'IMAGE_EGRESS_SUBMIT_RESULT_UNKNOWN' ||
                                        task.errorCode === 'IMAGE_GENERATION_SUBMIT_RESULT_UNKNOWN'
                                      ? localize('com_ui_image_submit_unknown')
                                      : task.errorMessage ||
                                        IMAGE_GENERATION_CLIENT_TIMEOUT_MESSAGE}
                                </div>
                              </div>
                            )}

                            {visualState === 'success' && task.resultImages.length > 0 && (
                              <div className="grid gap-4 sm:grid-cols-2">
                                {task.resultImages.map((image, imageIndex) => (
                                  <ResultImage
                                    key={`${task.taskId}-${getImageSrc(image)}-${imageIndex}`}
                                    image={image}
                                    index={imageIndex}
                                    downloadName={`ai-image-${task.taskId}-${imageIndex + 1}.png`}
                                    onUseAsSource={handleUseResultAsSource}
                                    onMakeSku={
                                      task.taskType === 'image-to-image' ? handleMakeSku : undefined
                                    }
                                    makeSkuLabel={
                                      isSkuSourceWorkflow ? '用作 SKU 源图' : '制作 SKU 图'
                                    }
                                  />
                                ))}
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                    <div className="rounded-lg border border-border-light bg-surface-primary-alt px-3 py-2 text-xs text-text-secondary">
                      当前系统已调整为极简状态展示，不影响生成能力
                    </div>
                  </div>
                )}
              </section>
            </div>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[420px_minmax(0,1fr)]">
              <section className="flex flex-col gap-5 rounded-lg border border-border-light bg-surface-primary-alt p-5">
                <div>
                  <h2 className="text-lg font-semibold">批量包装主图生成</h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    输入商品标题后，批量任务会按顺序逐个生成 1:1 电商主图。
                  </p>
                </div>

                <label className="grid gap-2 text-sm font-medium">
                  商品标题
                  <textarea
                    value={packagingTitle}
                    rows={4}
                    className="resize-none rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-blue-500"
                    placeholder="请输入淘宝完整标题，例如：红枣黑芝麻丸即食代餐小零食独立包装..."
                    onChange={(event) => setPackagingTitle(event.target.value)}
                  />
                </label>

                <div className="grid gap-3">
                  <span className="text-sm font-medium">生成模式</span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      className={[
                        'rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                        packagingMode === 't2i'
                          ? 'border-border-medium bg-surface-active-alt'
                          : 'border-border-light bg-surface-primary hover:bg-surface-hover',
                      ].join(' ')}
                      onClick={() => setPackagingMode('t2i')}
                    >
                      文生图
                    </button>
                    <button
                      type="button"
                      className={[
                        'rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                        packagingMode === 'i2i'
                          ? 'border-border-medium bg-surface-active-alt'
                          : 'border-border-light bg-surface-primary hover:bg-surface-hover',
                      ].join(' ')}
                      onClick={() => setPackagingMode('i2i')}
                    >
                      图生图
                    </button>
                  </div>
                  {renderModelSelect()}
                  <div className="grid gap-1 text-xs text-text-secondary">
                    <p>当前模型：{selectedModel.label}</p>
                    <p>每种包装风格生成 1 张 1:1 主图。</p>
                  </div>
                  {isAPIMartGPTImage2Selected && (
                    <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                      GPT Image 2
                      质量较高，但生成较慢；复杂提示词或批量任务可能需要较长时间，若长时间未完成建议切换
                      Seedream 5.0 Pro。
                    </div>
                  )}
                  {isSeedreamProSelected && (
                    <div className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
                      Seedream 5.0 Pro
                      是即梦新推出的高质量生图模型。上线初期使用人数较多时，生成可能稍慢或排队，请耐心等待。
                    </div>
                  )}
                </div>

                {packagingMode === 'i2i' && (
                  <div className="grid gap-3">
                    <div>
                      <label className="text-sm font-medium">参考图</label>
                      <p className="mt-1 text-xs text-text-secondary">
                        8 个子任务会复用同一张参考图，继续走现有单图改图接口。
                      </p>
                    </div>
                    <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-medium bg-surface-primary px-4 py-5 text-center hover:bg-surface-hover">
                      <Upload className="h-6 w-6 text-text-secondary" />
                      <span className="text-sm font-medium">点击上传参考图</span>
                      <span className="text-xs text-text-secondary">
                        PNG、JPG/JPEG、WebP，单张不超过 8MB
                      </span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={(event) =>
                          handlePackagingReferenceUploadChange(event.target.files?.[0])
                        }
                      />
                    </label>
                    {packagingReferencePreview && (
                      <figure className="overflow-hidden rounded-lg border border-border-light bg-surface-primary">
                        <img
                          src={packagingReferencePreview}
                          alt="包装批量参考图预览"
                          className="max-h-72 w-full object-contain"
                        />
                        <figcaption className="truncate px-3 py-2 text-xs text-text-secondary">
                          {packagingReferenceImage?.name}
                        </figcaption>
                      </figure>
                    )}
                  </div>
                )}

                <div className="grid gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <label className="text-sm font-medium" htmlFor="batch-prompt-template">
                        全局提示词模板
                      </label>
                      <p className="mt-1 text-xs text-text-secondary">
                        全局提示词模板用于维护通用生成规则，例如标题提取、食材展示、文字排版、合规提醒等。
                        系统会自动追加图片比例、尺寸和合规约束。
                      </p>
                    </div>
                    {canManagePromptTemplates && (
                      <button
                        type="button"
                        className="flex items-center gap-1 rounded-lg border border-border-medium px-3 py-1.5 text-xs hover:bg-surface-hover"
                        onClick={() => setPromptTemplateManagerOpen(true)}
                      >
                        <Settings className="h-3.5 w-3.5" />
                        管理模板
                      </button>
                    )}
                  </div>
                  <select
                    id="batch-prompt-template"
                    className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm"
                    value={selectedGlobalPromptTemplateKey}
                    onChange={(event) => setSelectedGlobalPromptTemplateKey(event.target.value)}
                    disabled={isPromptTemplatesLoading}
                  >
                    {selectedGlobalPromptTemplateKey &&
                      !globalPromptTemplates.some(
                        (template) => template.key === selectedGlobalPromptTemplateKey,
                      ) && <option value={selectedGlobalPromptTemplateKey}>刚保存的模板</option>}
                    {globalPromptTemplates.map((template) => (
                      <option key={template.key} value={template.key}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                  <PromptTemplateExample
                    url={
                      globalPromptTemplates.find(
                        (template) => template.key === selectedGlobalPromptTemplateKey,
                      )?.exampleImageUrl
                    }
                    name={selectedGlobalPromptTemplateName}
                  />
                </div>

                <div className="grid gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <span className="text-sm font-medium">包装样式模板</span>
                      <p className="mt-1 text-xs text-text-secondary">
                        包装样式模板决定最终生成盒装、袋装、礼盒、罐装、白底图等具体包装形态。
                      </p>
                    </div>
                    <button
                      type="button"
                      className="rounded-lg border border-border-medium px-3 py-1.5 text-xs hover:bg-surface-hover"
                      onClick={handleSelectAllPackagingTemplates}
                      disabled={
                        !maxPackagingStylesPerBatch ||
                        selectedPackagingTemplateIds.length >= maxPackagingStylesPerBatch
                      }
                    >
                      {!maxPackagingStylesPerBatch
                        ? '选择上限不可用'
                        : selectedPackagingTemplateIds.length > maxPackagingStylesPerBatch
                          ? `已超上限 ${selectedPackagingTemplateIds.length}/${maxPackagingStylesPerBatch}`
                          : selectedPackagingTemplateIds.length === maxPackagingStylesPerBatch
                            ? `已达上限 ${selectedPackagingTemplateIds.length}/${maxPackagingStylesPerBatch}`
                            : packagingStyleTemplates.length <= maxPackagingStylesPerBatch
                              ? `全选 ${packagingStyleTemplates.length} 个`
                              : `补满至 ${maxPackagingStylesPerBatch} 个`}
                    </button>
                  </div>
                  {maxPackagingStylesPerBatch && (
                    <p className="text-xs text-text-secondary">
                      每批最多选择 {maxPackagingStylesPerBatch} 个包装样式。已选{' '}
                      {selectedPackagingTemplateIds.length}/{maxPackagingStylesPerBatch}（共{' '}
                      {packagingStyleTemplates.length} 个可用）。
                    </p>
                  )}
                  {packagingSelectionNotice && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {packagingSelectionNotice}
                    </p>
                  )}
                  <div className="grid gap-2">
                    {packagingStyleTemplates.map((template) => (
                      <label
                        key={template.key}
                        className="flex items-center gap-2 rounded-lg border border-border-light bg-surface-primary px-3 py-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={selectedPackagingTemplateIds.includes(template.key)}
                          onChange={() => handleTogglePackagingTemplate(template.key)}
                        />
                        <PromptTemplateExample
                          url={template.exampleImageUrl}
                          name={template.name}
                          className="h-16 w-16 shrink-0 rounded border border-border-light object-contain"
                          deferUntilVisible
                        />
                        <span>{template.name}</span>
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-text-secondary">
                    如果需要生成袋装，请选择袋装类包装样式模板。仅修改全局提示词模板，不一定能覆盖包装样式模板中的盒装/礼盒描述。
                  </p>
                </div>

                <details className="rounded-lg border border-border-light bg-surface-primary px-3 py-2 text-sm">
                  <summary className="cursor-pointer font-medium">最终生效说明</summary>
                  <div className="mt-3 grid gap-1 text-xs text-text-secondary">
                    <p>当前全局提示词模板：{selectedGlobalPromptTemplateName}</p>
                    <p>
                      当前包装样式模板：
                      {selectedPackagingStyleTemplateNames.length
                        ? selectedPackagingStyleTemplateNames.join('、')
                        : '未选择'}
                    </p>
                    <p>输出约束：1:1 / 800x800</p>
                    <p>说明：包装形态主要由包装样式模板决定。</p>
                  </div>
                </details>

                <button
                  type="button"
                  className="mt-1 flex h-11 items-center justify-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-surface-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={handleStartPackagingBatch}
                  disabled={Boolean(
                    packagingBatch?.items.some(
                      (item) => item.status === 'pending' || item.status === 'running',
                    ),
                  )}
                >
                  <Sparkles className="h-4 w-4" />
                  开始批量生成
                </button>

                {packagingError && (
                  <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                    {packagingError}
                  </div>
                )}
                {packagingPollWarning && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                    {packagingPollWarning}
                  </div>
                )}
              </section>

              <section className="min-h-[560px] rounded-lg border border-border-light bg-surface-primary-alt p-5">
                <div className="mb-4">
                  <h2 className="text-lg font-semibold">包装生成结果</h2>
                  <p className="text-sm text-text-secondary">
                    每个包装模板是独立子任务，批量任务会按顺序逐个生成 1:1
                    电商主图；失败项可单独重试。
                  </p>
                  <p className="mt-1 text-xs text-text-secondary">
                    生成结果保留 24 小时，请及时下载。
                  </p>
                </div>

                {!packagingBatch && (
                  <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-medium bg-surface-primary text-center">
                    <ImageIcon className="h-10 w-10 text-text-secondary" />
                    <div>
                      <p className="text-sm font-medium">暂无批量任务</p>
                      <p className="text-sm text-text-secondary">
                        填写左侧标题后点击“开始批量生成”。
                      </p>
                    </div>
                  </div>
                )}

                {packagingBatch && (
                  <div className="grid gap-4">
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-light bg-surface-primary px-3 py-2 text-sm text-text-secondary">
                      <div className="grid gap-1">
                        <div>商品标题：{packagingBatch.title}</div>
                        <div>批量状态：{getPackagingTaskStatusLabel(packagingBatch)}</div>
                        {packagingPollWarning && (
                          <div className="text-amber-700">{packagingPollWarning}</div>
                        )}
                      </div>
                      {(packagingBatch.status === 'pending' ||
                        packagingBatch.status === 'running') && (
                        <button
                          type="button"
                          className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/30"
                          onClick={handleCancelPackagingBatch}
                        >
                          停止生成
                        </button>
                      )}
                    </div>
                    <div className="grid gap-4">
                      {packagingBatch.items.map((item, index) => {
                        const statusPresentation = getBatchStatusPresentation(item);
                        const statusLabel = getPackagingBatchStatusLabel(item.status, item);
                        const isRunning = item.status === 'pending' || item.status === 'running';
                        const isProviderSubmitUnknown = isProviderSubmitUnknownItem(item);
                        const retryAction = isProviderSubmitUnknown
                          ? null
                          : getBatchRetryAction(item.status, item.retryMode, item);
                        const providerLabel = item.provider || packagingBatch.provider || '未知';
                        const modelLabel =
                          item.modelKey ||
                          packagingBatch.modelKey ||
                          item.model ||
                          packagingBatch.model ||
                          '未知';
                        return (
                          <article
                            key={item.templateId}
                            className={[
                              'grid gap-4 rounded-lg border p-4 transition-colors',
                              item.status === 'success'
                                ? 'border-green-300 bg-green-50/40 dark:border-green-900/60 dark:bg-green-950/10'
                                : 'border-border-light bg-surface-primary',
                            ].join(' ')}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="grid gap-1">
                                <div
                                  className={[
                                    'text-sm font-medium',
                                    item.status === 'success'
                                      ? 'text-green-700 dark:text-green-300'
                                      : statusPresentation
                                        ? 'text-amber-700 dark:text-amber-300'
                                        : item.status === 'failed'
                                          ? 'text-red-700 dark:text-red-300'
                                          : item.status === 'cancelled'
                                            ? 'text-amber-700 dark:text-amber-300'
                                            : item.status === 'running'
                                              ? 'text-blue-700 dark:text-blue-300'
                                              : 'text-text-secondary',
                                  ].join(' ')}
                                >
                                  模板 {index + 1} {item.templateName} 状态：{statusLabel}
                                </div>
                              </div>

                              {retryAction && (
                                <button
                                  type="button"
                                  className="flex items-center gap-1 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                                  onClick={() => handleRetryPackagingItem(item)}
                                >
                                  <RotateCcw className="h-4 w-4" />
                                  {retryAction.label}
                                </button>
                              )}
                            </div>

                            {isRunning && (
                              <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-border-light bg-surface-primary-alt px-4 text-center text-sm text-text-secondary">
                                <Loader2 className="h-5 w-5 animate-spin" />
                                <div>AI 正在生成包装主图，请稍等</div>
                                <div className="text-xs opacity-80">
                                  批量任务会按顺序逐个生成 1:1 电商主图
                                </div>
                              </div>
                            )}

                            {item.status === 'failed' && isProviderSubmitUnknown && (
                              <div className="grid gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                                <div>{item.errorMessage || getBatchItemErrorMessage(item)}</div>
                                <div className="grid gap-1 rounded-md bg-white/60 p-2 text-xs dark:bg-black/10">
                                  <div>核查信息</div>
                                  <div>批量任务 ID：{packagingBatch.id}</div>
                                  <div>子任务 ID：{item.itemId}</div>
                                  <div>包装模板：{item.templateName}</div>
                                  <div>供应商：{providerLabel}</div>
                                  <div>模型标识：{modelLabel}</div>
                                  <div>提交次数：{item.submitAttempt ?? 0}</div>
                                  <div>错误类型：{item.errorKind}</div>
                                </div>
                                <div className="text-xs">
                                  为避免重复计费，此状态不会提供重新生成或重新加载入口。请管理员先核查供应商后台与服务端记录。
                                </div>
                              </div>
                            )}

                            {item.status === 'failed' && !isProviderSubmitUnknown && (
                              <div
                                className={[
                                  'rounded-lg border px-3 py-2 text-sm',
                                  statusPresentation
                                    ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300'
                                    : 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300',
                                ].join(' ')}
                              >
                                {statusPresentation?.message ||
                                  item.errorMessage ||
                                  '生成失败，请稍后重试。'}
                              </div>
                            )}

                            {item.status === 'cancelled' && (
                              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                                {item.errorMessage || '任务已取消'}
                              </div>
                            )}

                            {item.status === 'success' && item.resultImages.length > 0 && (
                              <div className="grid gap-4 sm:grid-cols-2">
                                {item.resultImages.map((image, imageIndex) => (
                                  <ResultImage
                                    key={`${packagingBatch.id}-${item.templateId}-${getImageSrc(image)}-${imageIndex}`}
                                    image={image}
                                    index={imageIndex}
                                    downloadName={`packaging-${item.templateId}-${imageIndex + 1}.png`}
                                    onUseAsSource={handleUseResultAsSource}
                                    isStableBatchResult
                                    onRecoverStableResult={() =>
                                      handleRecoverPackagingItemResult(item)
                                    }
                                  />
                                ))}
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
      {isPromptTemplateManagerOpen && canManagePromptTemplates && (
        <PromptTemplateManager
          templates={promptTemplates}
          selectedTemplateId={selectedGlobalPromptTemplateKey}
          loading={isPromptTemplatesLoading}
          onClose={() => setPromptTemplateManagerOpen(false)}
          onReload={(preserveSelectedTemplateId) =>
            fetchPromptTemplates({ preserveSelectedTemplateId })
          }
          onSelect={setSelectedGlobalPromptTemplateKey}
          onTemplateDeleted={handlePromptTemplateDeleted}
          onTemplateSaved={handlePromptTemplateSaved}
        />
      )}
    </>
  );
}
