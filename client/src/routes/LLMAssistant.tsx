/* eslint-disable i18next/no-literal-string -- This standalone business route uses Chinese UI copy. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Bot, ChevronDown, Loader2, Plus, Send, Upload, User, X } from 'lucide-react';
import { request } from 'librechat-data-provider';
import type { KeyboardEvent } from 'react';

type ChatRole = 'user' | 'assistant';

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

type LLMModel = {
  key: string;
  name: string;
  group: 'domestic' | 'overseas';
  enabled: boolean;
  recommended: boolean;
  capabilities: string[];
  recommendFor: string;
  description: string;
};

type LLMAssistantConfig = {
  models: LLMModel[];
  defaultModelKey: string;
};

const LONG_TEXT_THRESHOLD = 800;
const MAX_CONTEXT_MESSAGES = 10;
const ALLOWED_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_UPLOAD_SIZE = 8 * 1024 * 1024;

const CAPABILITY_LABELS: Record<string, string> = {
  text: '文本',
  reasoning: '推理',
  'long-context': '长上下文',
  vision: '图文理解',
  fast: '快速',
  'low-cost': '低成本',
};

function getCapabilityLabel(capability: string) {
  return CAPABILITY_LABELS[capability] ?? capability;
}

function createId() {
  return (
    globalThis.crypto?.randomUUID?.() ?? `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function recommendModelKey(
  models: LLMModel[],
  hasImage: boolean,
  inputLength: number,
  fallback: string,
) {
  if (hasImage) {
    const visionModel = models.find((model) => model.capabilities.includes('vision'));
    if (visionModel) {
      return visionModel.key;
    }
  }
  if (inputLength > LONG_TEXT_THRESHOLD) {
    const longModel = models.find((model) => model.capabilities.includes('long-context'));
    if (longModel) {
      return longModel.key;
    }
  }
  return fallback;
}

export default function LLMAssistant() {
  const { modelKey: routeModelKey } = useParams<{ modelKey?: string }>();
  const [config, setConfig] = useState<LLMAssistantConfig>({ models: [], defaultModelKey: '' });
  const [selectedKey, setSelectedKey] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [errorMeta, setErrorMeta] = useState<{ errorCode?: string; requestId?: string }>({});
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const requestGeneration = useRef(0);
  const retiredKimiRoute =
    routeModelKey === 'kimi_k2_6' &&
    !config.models.some((model) => model.key === 'kimi_k2_6' && model.enabled) &&
    config.models.some((model) => model.key === 'glm_5_3' && model.enabled);

  useEffect(() => {
    requestGeneration.current += 1;
    setMessages([]);
    setLoading(false);
    setError('');
  }, [routeModelKey]);

  useEffect(() => {
    let ignore = false;
    request
      .get<LLMAssistantConfig>('/api/llm-assistant/config')
      .then((data) => {
        if (ignore) {
          return;
        }
        setConfig(data);
      })
      .catch(() => setError('模型配置加载失败，请刷新页面后重试。'));
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (!config.models.length) {
      return;
    }
    const effectiveRouteKey = retiredKimiRoute ? 'glm_5_3' : routeModelKey;
    const fromRoute = config.models.find(
      (model) => model.key === effectiveRouteKey && model.enabled,
    );
    if (fromRoute) {
      setSelectedKey(fromRoute.key);
      return;
    }
    setSelectedKey(
      (prev) =>
        prev || config.defaultModelKey || config.models.find((model) => model.enabled)?.key || '',
    );
  }, [config, routeModelKey, retiredKimiRoute]);

  useEffect(() => {
    if (!imageFile) {
      setImagePreview('');
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const domesticModels = useMemo(
    () => config.models.filter((model) => model.group === 'domestic'),
    [config.models],
  );
  const overseasModels = useMemo(
    () => config.models.filter((model) => model.group === 'overseas'),
    [config.models],
  );

  const recommendedKey = useMemo(
    () =>
      recommendModelKey(config.models, Boolean(imageFile), input.length, config.defaultModelKey),
    [config.models, config.defaultModelKey, imageFile, input.length],
  );
  const recommendedModel = config.models.find((model) => model.key === recommendedKey);
  const selectedModel = config.models.find((model) => model.key === selectedKey);
  const selectedSupportsVision = Boolean(selectedModel?.capabilities.includes('vision'));
  const showImageReminder = Boolean(imageFile) && !selectedSupportsVision;
  const showRecommendChip =
    Boolean(recommendedModel) &&
    recommendedModel?.enabled === true &&
    recommendedKey !== selectedKey &&
    !imageFile;

  const handleSelect = (model: LLMModel) => {
    if (!model.enabled) {
      return;
    }
    if (selectedKey !== model.key) {
      requestGeneration.current += 1;
      setMessages([]);
      setLoading(false);
    }
    setSelectedKey(model.key);
    setModelPanelOpen(false);
    setError('');
  };

  const handleNewConversation = () => {
    requestGeneration.current += 1;
    setLoading(false);
    setMessages([]);
    setInput('');
    setImageFile(null);
    setError('');
    setErrorMeta({});
  };

  const handleImageChange = (file?: File) => {
    setError('');
    if (!file) {
      return;
    }
    if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) {
      setError('只支持 PNG、JPG/JPEG、WebP 图片。');
      return;
    }
    if (file.size > MAX_UPLOAD_SIZE) {
      setError('图片不能超过 8MB。');
      return;
    }
    setImageFile(file);
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed) {
      setError('请先输入要发送的内容。');
      return;
    }
    if (!selectedModel?.enabled) {
      setError('该模型暂未开放，请选择已上线的模型。');
      return;
    }

    const generation = requestGeneration.current;
    const userMessage: ChatMessage = { id: createId(), role: 'user', content: trimmed };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput('');
    setError('');
    setErrorMeta({});
    setLoading(true);

    try {
      const payloadMessages = nextMessages
        .slice(-MAX_CONTEXT_MESSAGES)
        .map((message) => ({ role: message.role, content: message.content }));
      const response = (await request.post('/api/llm-assistant/chat', {
        modelKey: selectedKey,
        messages: payloadMessages,
      })) as { text: string };
      if (generation !== requestGeneration.current) {
        return;
      }
      setMessages((items) => [
        ...items,
        { id: createId(), role: 'assistant', content: response.text ?? '' },
      ]);
    } catch (err: unknown) {
      if (generation !== requestGeneration.current) {
        return;
      }
      const apiError = err as {
        response?: { data?: { message?: string; errorCode?: string; requestId?: string } };
        message?: string;
      };
      const data = apiError.response?.data;
      setError(data?.message || apiError.message || '分析失败，请稍后重试。');
      setErrorMeta({ errorCode: data?.errorCode, requestId: data?.requestId });
    } finally {
      if (generation === requestGeneration.current) {
        setLoading(false);
      }
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!loading) {
        void handleSend();
      }
    }
  };

  const renderModelRow = (model: LLMModel) => {
    const isSelected = model.key === selectedKey;
    const isRecommended = model.key === recommendedKey;
    return (
      <button
        key={model.key}
        type="button"
        disabled={!model.enabled}
        onClick={() => handleSelect(model)}
        className={[
          'flex w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors',
          isSelected
            ? 'border-blue-500 bg-blue-500/5'
            : 'border-border-light bg-surface-primary hover:bg-surface-hover',
          model.enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-70',
        ].join(' ')}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-text-primary">{model.name}</span>
          {isRecommended && model.enabled && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] text-green-700 dark:bg-green-950/40 dark:text-green-300">
              推荐
            </span>
          )}
          {!model.enabled && (
            <span className="rounded-full bg-surface-active-alt px-2 py-0.5 text-[11px] text-text-secondary">
              {isRecommended ? '推荐 · 即将上线' : '即将上线'}
            </span>
          )}
        </div>
        <div className="text-[11px] text-text-secondary">推荐：{model.recommendFor}</div>
        <div className="flex flex-wrap gap-1">
          {model.capabilities.map((capability) => (
            <span
              key={capability}
              className="rounded bg-surface-active-alt px-1.5 py-0.5 text-[10px] text-text-secondary"
            >
              {getCapabilityLabel(capability)}
            </span>
          ))}
        </div>
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col bg-surface-primary text-text-primary">
      <header className="flex items-center justify-between gap-3 border-b border-border-light px-5 py-3 lg:px-8">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-active-alt">
            <Bot className="h-4 w-4" aria-hidden="true" />
          </span>
          <h1 className="text-lg font-semibold">{selectedModel?.name ?? '模型对话'}</h1>
        </div>
        <button
          type="button"
          onClick={handleNewConversation}
          className="flex items-center gap-1.5 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
        >
          <Plus className="h-4 w-4" />
          新建对话
        </button>
      </header>

      {retiredKimiRoute && (
        <p role="status" className="px-5 py-3 text-sm text-text-secondary">
          Kimi K2.6 已下线，此旧入口默认选择 GLM 5.3，也可切换其他模型。
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-5 lg:px-0">
          {messages.length === 0 && !loading ? (
            <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center text-sm text-text-secondary">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-active-alt">
                <Bot className="h-6 w-6" />
              </span>
              <p className="max-w-md">
                不知道选哪个？默认使用 DeepSeek V4
                Pro。系统会根据你的任务类型推荐模型，也可以在下方手动切换。
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={[
                    'flex gap-3',
                    message.role === 'user' ? 'flex-row-reverse' : 'flex-row',
                  ].join(' ')}
                >
                  <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-surface-active-alt">
                    {message.role === 'user' ? (
                      <User className="h-4 w-4" />
                    ) : (
                      <Bot className="h-4 w-4" />
                    )}
                  </span>
                  <div
                    className={[
                      'max-w-[82%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-6',
                      message.role === 'user'
                        ? 'bg-blue-500 text-white'
                        : 'border border-border-light bg-surface-primary-alt text-text-primary',
                    ].join(' ')}
                  >
                    {message.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex items-center gap-2 text-sm text-text-secondary">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在思考...
                </div>
              )}
              <div ref={streamEndRef} />
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border-light bg-surface-primary">
        <div className="mx-auto w-full max-w-3xl px-5 py-3 lg:px-0">
          {imageFile && (
            <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              已检测到图片任务。图文理解（视觉）能力正在验证 /
              即将上线，当前模型暂不能直接识别图片；请在输入框中用文字描述图片重点，先用已上线模型分析文字内容。
            </div>
          )}

          {error && (
            <div className="mb-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              <div>{error}</div>
              {errorMeta.errorCode && (
                <div className="mt-1 text-xs opacity-80">错误码：{errorMeta.errorCode}</div>
              )}
              {errorMeta.requestId && (
                <div className="text-xs opacity-80">请求ID：{errorMeta.requestId}</div>
              )}
            </div>
          )}

          {showImageReminder && !error && (
            <div className="mb-2 rounded-lg border border-border-medium bg-surface-primary-alt px-3 py-2 text-xs leading-5 text-text-secondary">
              当前模型不支持图片识别，本次只会分析你的文字内容。请在输入框中描述图片重点，或等待视觉模型上线。
            </div>
          )}

          <div className="flex flex-col gap-2 rounded-2xl border border-border-medium bg-surface-primary-alt p-2">
            {imagePreview && (
              <div className="flex items-center gap-2 rounded-lg border border-border-light bg-surface-primary p-2">
                <img
                  src={imagePreview}
                  alt="参考图预览"
                  className="h-10 w-10 rounded object-cover"
                />
                <span className="flex-1 truncate text-xs text-text-secondary">
                  {imageFile?.name}
                </span>
                <button
                  type="button"
                  aria-label="移除图片"
                  onClick={() => setImageFile(null)}
                  className="rounded p-1 text-text-secondary hover:bg-surface-hover"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            <textarea
              value={input}
              rows={2}
              className="resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
              placeholder="输入你的问题，可连续多轮提问。Enter 发送，Shift+Enter 换行。"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleInputKeyDown}
            />

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setModelPanelOpen((open) => !open)}
                    className="flex items-center gap-1.5 rounded-lg border border-border-medium px-3 py-2 text-xs font-medium hover:bg-surface-hover"
                  >
                    {selectedModel?.name ?? '选择模型'}
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>

                  {modelPanelOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setModelPanelOpen(false)}
                      />
                      <div className="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-xl border border-border-light bg-surface-primary p-3 shadow-xl">
                        <div className="grid gap-3">
                          <div className="grid gap-2">
                            <span className="text-xs font-semibold text-text-secondary">
                              国内模型（优先推荐）
                            </span>
                            {domesticModels.map(renderModelRow)}
                          </div>
                          <div className="grid gap-2">
                            <span className="text-xs font-semibold text-text-secondary">
                              海外模型（高级 / 备用）
                            </span>
                            {overseasModels.map(renderModelRow)}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {showRecommendChip && (
                  <button
                    type="button"
                    onClick={() => recommendedModel && handleSelect(recommendedModel)}
                    className="rounded-lg border border-green-300 px-2.5 py-2 text-xs text-green-700 hover:bg-green-50 dark:border-green-900 dark:text-green-300 dark:hover:bg-green-950/30"
                  >
                    推荐 {recommendedModel?.name}
                  </button>
                )}

                <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-medium px-3 py-2 text-xs text-text-secondary hover:bg-surface-hover">
                  <Upload className="h-3.5 w-3.5" />
                  图片
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(event) => handleImageChange(event.target.files?.[0])}
                  />
                </label>
              </div>

              <button
                type="button"
                disabled={loading}
                onClick={handleSend}
                className="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-text-primary px-4 text-sm font-medium text-surface-primary transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                发送
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
