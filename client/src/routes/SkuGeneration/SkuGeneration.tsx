/* eslint-disable i18next/no-literal-string */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useToastContext } from '@librechat/client';
import { useNavigate, useSearchParams } from 'react-router-dom';
import ImageGeneration from '../ImageGeneration';
import {
  cancelSkuBatch,
  createSkuBatch,
  downloadSkuFile,
  getSkuBatch,
  loadSkuTemplateAssetObjectUrl,
  loadSkuFileObjectUrl,
  retrySkuBatchItem,
  uploadSkuFile,
} from './api';
import type { SkuBatchItem, SkuBatchSummary, SkuFile, SkuFileKind } from './types';
import SkuPreview from './SkuPreview';
import { SKU_TEMPLATE_V1, SKU_TEMPLATE_V1_KEY } from './skuTemplate';

const TEMPLATE_KEY = SKU_TEMPLATE_V1_KEY;
const MAX_TEXT_ROWS = 6;
const TERMINAL_STATUSES = new Set<SkuBatchSummary['status']>([
  'completed',
  'partial_failed',
  'failed',
  'cancelled',
]);

type SourceOrigin = 'image-edit-result' | 'direct-upload' | 'sku-result' | '';
type WorkbenchStep = 'source' | 'compose';
type SourceMethod = 'edit' | 'upload';

function getStatusLabel(status: SkuBatchSummary['status']) {
  return {
    pending: '已提交',
    running: '制作中',
    completed: '已完成',
    partial_failed: '部分失败',
    failed: '任务失败',
    cancelled: '已取消',
  }[status];
}

function getItemStatusLabel(status: SkuBatchItem['status']) {
  return {
    pending: '排队中',
    running: '制作中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }[status];
}

function getSourceOriginLabel(origin: SourceOrigin) {
  if (origin === 'image-edit-result') {
    return '来自单图改图';
  }
  if (origin === 'sku-result') {
    return '来自 SKU 结果';
  }
  if (origin === 'direct-upload') {
    return '直接上传';
  }
  return null;
}

function validateTextRow(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (/\r|\n/u.test(normalized)) {
    return '文字必须保持单行。';
  }
  return null;
}

function validateFile(file: File) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    return '只支持 PNG、JPG/JPEG、WebP 图片。';
  }
  if (file.size > 8 * 1024 * 1024) {
    return '图片不能超过 8MB。';
  }
  return null;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function SkuResultPreview({ item }: { item: SkuBatchItem }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (!item.outputFileId) {
      return;
    }
    let disposed = false;
    let objectUrl: string | undefined;
    loadSkuFileObjectUrl(item.outputFileId)
      .then((url) => {
        objectUrl = url;
        if (disposed) {
          URL.revokeObjectURL(url);
          return;
        }
        setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [item.outputFileId]);

  return src ? (
    <img src={src} alt={`SKU 结果：${item.text}`} className="max-h-72 w-full object-contain" />
  ) : null;
}

function resolveSourceOrigin(sourceId: string, sourceType: SourceOrigin): SourceOrigin {
  if (!sourceId) {
    return '';
  }
  if (sourceType === 'image-edit-result' || sourceType === 'sku-result') {
    return sourceType;
  }
  return 'direct-upload';
}

export default function SkuGeneration() {
  const { showToast } = useToastContext();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const querySourceId = searchParams.get('sourceFileId') || '';
  const querySourceType = (searchParams.get('sourceType') || '') as SourceOrigin;
  const [sourceFile, setSourceFile] = useState<SkuFile | null>(
    querySourceId ? { fileId: querySourceId } : null,
  );
  const [sourceOrigin, setSourceOrigin] = useState<SourceOrigin>(
    resolveSourceOrigin(querySourceId, querySourceType),
  );
  const [sourceUrl, setSourceUrl] = useState<string>();
  const [leftIconUrl, setLeftIconUrl] = useState<string>();
  const [rightIconUrl, setRightIconUrl] = useState<string>();
  const [textRows, setTextRows] = useState(['']);
  const [batch, setBatch] = useState<SkuBatchSummary | null>(null);
  const [uploading, setUploading] = useState<SkuFileKind | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  const [forceSourceStep, setForceSourceStep] = useState(false);
  const [sourceMethod, setSourceMethod] = useState<SourceMethod>('edit');

  const hasSource = Boolean(sourceFile?.fileId);
  const currentStep: WorkbenchStep = forceSourceStep || !hasSource ? 'source' : 'compose';

  useEffect(() => {
    if (!querySourceId) {
      return;
    }
    setSourceFile({ fileId: querySourceId });
    setSourceOrigin(resolveSourceOrigin(querySourceId, querySourceType));
    setForceSourceStep(false);
    let disposed = false;
    let objectUrl: string | undefined;
    loadSkuFileObjectUrl(querySourceId)
      .then((url) => {
        objectUrl = url;
        if (disposed) {
          URL.revokeObjectURL(url);
          return;
        }
        setSourceUrl(url);
      })
      .catch((error) => {
        showToast({
          status: 'error',
          message: getErrorMessage(error, '源图读取失败，请重新上传。'),
        });
      });
    return () => {
      disposed = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [querySourceId, querySourceType, showToast]);

  useEffect(() => {
    if (currentStep !== 'compose') {
      return;
    }
    let disposed = false;
    let objectUrls: string[] = [];
    Promise.all([
      loadSkuTemplateAssetObjectUrl(TEMPLATE_KEY, SKU_TEMPLATE_V1.assets.leftIcon),
      loadSkuTemplateAssetObjectUrl(TEMPLATE_KEY, SKU_TEMPLATE_V1.assets.rightIcon),
    ])
      .then(([leftUrl, rightUrl]) => {
        if (disposed) {
          URL.revokeObjectURL(leftUrl);
          URL.revokeObjectURL(rightUrl);
          return;
        }
        objectUrls = [leftUrl, rightUrl];
        setLeftIconUrl(leftUrl);
        setRightIconUrl(rightUrl);
      })
      .catch((error) => {
        if (!disposed) {
          showToast({ status: 'error', message: getErrorMessage(error, '模板素材读取失败。') });
        }
      });
    return () => {
      disposed = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      setLeftIconUrl(undefined);
      setRightIconUrl(undefined);
    };
  }, [currentStep, showToast]);

  useEffect(() => {
    if (!batch || TERMINAL_STATUSES.has(batch.status)) {
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        setBatch(await getSkuBatch(batch.batchId));
      } catch (error) {
        showToast({ status: 'error', message: getErrorMessage(error, 'SKU 任务状态读取失败。') });
      }
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [batch, showToast]);

  const applySource = useCallback(
    (payload: { fileId: string; previewObjectUrl?: string; origin: SourceOrigin }) => {
      setSourceFile({ fileId: payload.fileId });
      if (payload.previewObjectUrl) {
        setSourceUrl(payload.previewObjectUrl);
      }
      setSourceOrigin(payload.origin);
      setForceSourceStep(false);
      navigate(
        `/sku-generation?sourceFileId=${encodeURIComponent(payload.fileId)}&sourceType=${encodeURIComponent(payload.origin || 'direct-upload')}`,
        { replace: true },
      );
    },
    [navigate],
  );

  const uploadFile = useCallback(
    async (kind: SkuFileKind, file?: File) => {
      if (!file) {
        return;
      }
      const validationError = validateFile(file);
      if (validationError) {
        showToast({ status: 'error', message: validationError });
        return;
      }
      setUploading(kind);
      try {
        const saved = await uploadSkuFile(file, kind);
        const localUrl = URL.createObjectURL(file);
        if (kind === 'source') {
          applySource({
            fileId: saved.fileId,
            previewObjectUrl: localUrl,
            origin: 'direct-upload',
          });
        }
      } catch (error) {
        showToast({
          status: 'error',
          message: getErrorMessage(error, '图片上传失败，请稍后重试。'),
        });
      } finally {
        setUploading(null);
      }
    },
    [applySource, showToast],
  );

  const nonEmptyRows = useMemo(() => textRows.map((row) => row.trim()).filter(Boolean), [textRows]);
  const textValidationError = useMemo(() => {
    for (const row of nonEmptyRows) {
      const error = validateTextRow(row);
      if (error) {
        return error;
      }
    }
    if (nonEmptyRows.length > MAX_TEXT_ROWS) {
      return `文字行不能超过 ${MAX_TEXT_ROWS} 条。`;
    }
    return null;
  }, [nonEmptyRows]);
  const canSubmit = Boolean(sourceFile?.fileId && nonEmptyRows.length && !textValidationError);
  const sourceOriginLabel = getSourceOriginLabel(sourceOrigin);

  const handleSubmit = async () => {
    if (!canSubmit || submitting) {
      return;
    }
    if (textValidationError) {
      showToast({ status: 'error', message: textValidationError });
      return;
    }
    setSubmitting(true);
    try {
      const created = await createSkuBatch({
        sourceFileId: sourceFile!.fileId,
        templateKey: TEMPLATE_KEY,
        textRows: nonEmptyRows,
      });
      setBatch(created);
      if (!TERMINAL_STATUSES.has(created.status)) {
        setBatch(await getSkuBatch(created.batchId));
      }
    } catch (error) {
      showToast({ status: 'error', message: getErrorMessage(error, 'SKU 批量任务创建失败。') });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownload = async (item: SkuBatchItem) => {
    if (!item.outputFileId || downloadingFileId) {
      return;
    }
    setDownloadingFileId(item.outputFileId);
    try {
      await downloadSkuFile(item.outputFileId, `sku-${item.itemIndex + 1}.png`);
    } catch (error) {
      showToast({ status: 'error', message: getErrorMessage(error, '下载失败，请稍后重试。') });
    } finally {
      setDownloadingFileId(null);
    }
  };

  const addRow = () => setTextRows((rows) => [...rows, '']);
  const removeRow = (index: number) =>
    setTextRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
  const moveRow = (index: number, offset: -1 | 1) => {
    setTextRows((rows) => {
      const nextIndex = index + offset;
      if (nextIndex < 0 || nextIndex >= rows.length) {
        return rows;
      }
      const next = [...rows];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-6 overflow-y-auto px-4 py-6">
      <header>
        <h1 className="text-2xl font-semibold">SKU 图制作</h1>
        <p className="mt-1 text-sm text-text-secondary">
          独立功能区：先出源图（单图改图或上传），再按固定版式批量合成，不调用 AI。
        </p>
        <div className="mt-4 flex flex-wrap gap-2" data-testid="sku-step-indicator">
          <button
            type="button"
            data-testid="sku-step-source"
            aria-current={currentStep === 'source' ? 'step' : undefined}
            className={[
              'rounded-full px-3 py-1 text-sm',
              currentStep === 'source'
                ? 'bg-blue-600 text-white'
                : 'bg-surface-secondary text-text-secondary hover:bg-surface-hover',
            ].join(' ')}
            onClick={() => setForceSourceStep(true)}
          >
            步骤 1 · 出源图
          </button>
          <button
            type="button"
            data-testid="sku-step-compose"
            aria-current={currentStep === 'compose' ? 'step' : undefined}
            disabled={!hasSource}
            className={[
              'rounded-full px-3 py-1 text-sm',
              currentStep === 'compose'
                ? 'bg-blue-600 text-white'
                : 'bg-surface-secondary text-text-secondary hover:bg-surface-hover',
              !hasSource ? 'cursor-not-allowed opacity-50' : '',
            ].join(' ')}
            onClick={() => {
              if (hasSource) {
                setForceSourceStep(false);
              }
            }}
          >
            步骤 2 · 制 SKU
          </button>
        </div>
        {sourceOriginLabel && currentStep === 'compose' && (
          <span
            data-testid="sku-source-origin"
            className="mt-3 inline-flex rounded-full bg-surface-secondary px-3 py-1 text-sm"
          >
            {sourceOriginLabel}
          </span>
        )}
      </header>

      {currentStep === 'source' ? (
        <section className="space-y-4 rounded-xl border border-border-light p-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="sku-source-method-edit"
              className={[
                'rounded-lg border px-4 py-2 text-sm font-medium',
                sourceMethod === 'edit'
                  ? 'border-border-medium bg-surface-active-alt'
                  : 'border-border-light hover:bg-surface-hover',
              ].join(' ')}
              onClick={() => setSourceMethod('edit')}
            >
              单图改图
            </button>
            <button
              type="button"
              data-testid="sku-source-method-upload"
              className={[
                'rounded-lg border px-4 py-2 text-sm font-medium',
                sourceMethod === 'upload'
                  ? 'border-border-medium bg-surface-active-alt'
                  : 'border-border-light hover:bg-surface-hover',
              ].join(' ')}
              onClick={() => setSourceMethod('upload')}
            >
              直接上传
            </button>
            {hasSource && (
              <button
                type="button"
                className="ml-auto rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                onClick={() => setForceSourceStep(false)}
              >
                返回排版
              </button>
            )}
          </div>

          {sourceMethod === 'edit' ? (
            <div
              data-testid="sku-step1-image-edit"
              className="overflow-hidden rounded-lg border border-border-light"
            >
              <ImageGeneration
                skuSourceWorkflow={{
                  onSourceReady: ({ fileId, previewObjectUrl }) => {
                    applySource({
                      fileId,
                      previewObjectUrl,
                      origin: 'image-edit-result',
                    });
                    showToast({
                      status: 'success',
                      message: '已带入源图，可继续配置 SKU 版式。',
                    });
                  },
                }}
              />
            </div>
          ) : (
            <div data-testid="sku-step1-upload">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="font-medium">上传源图</h2>
                <span className="text-xs text-text-secondary">PNG/JPG/WebP，≤8MB</span>
              </div>
              <label className="flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-border-medium px-4 py-8 text-sm hover:bg-surface-hover">
                <Upload className="mr-2 h-4 w-4" />
                {sourceFile ? '替换源图' : '上传源图'}
                <input
                  data-testid="sku-source-input"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(event) => void uploadFile('source', event.target.files?.[0])}
                />
              </label>
              {sourceUrl && (
                <img
                  data-testid="sku-source-preview"
                  src={sourceUrl}
                  alt="SKU 源图"
                  className="mt-4 max-h-72 w-full rounded-lg object-contain"
                />
              )}
            </div>
          )}
        </section>
      ) : (
        <>
          <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)]">
            <div className="space-y-6 rounded-xl border border-border-light p-4">
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h2 className="font-medium">源图</h2>
                  <button
                    type="button"
                    data-testid="sku-change-source"
                    onClick={() => {
                      setForceSourceStep(true);
                      setSourceMethod('edit');
                    }}
                    className="rounded-lg border border-border-medium px-3 py-1.5 text-sm hover:bg-surface-hover"
                  >
                    更换源图
                  </button>
                </div>
                {sourceUrl && (
                  <img
                    data-testid="sku-source-preview"
                    src={sourceUrl}
                    alt="SKU 源图"
                    className="max-h-72 w-full rounded-lg object-contain"
                  />
                )}
              </div>
              <div className="rounded-lg border border-border-light bg-surface-secondary p-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-medium">{SKU_TEMPLATE_V1.name}</h2>
                  <span className="text-xs text-text-secondary">固定模板</span>
                </div>
                <p className="mt-1 text-xs text-text-secondary">{SKU_TEMPLATE_V1.description}</p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {leftIconUrl && (
                    <img
                      data-testid="sku-template-left-asset"
                      src={leftIconUrl}
                      alt="模板左上素材"
                      className="h-20 w-full object-contain"
                    />
                  )}
                  {rightIconUrl && (
                    <img
                      data-testid="sku-template-right-asset"
                      src={rightIconUrl}
                      alt="模板右上素材"
                      className="h-20 w-full object-contain"
                    />
                  )}
                </div>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="font-medium">文字列表</h2>
                  <span className="text-xs text-text-secondary">
                    预计输出 {nonEmptyRows.length} 张
                  </span>
                </div>
                <p className="mb-2 text-xs text-text-secondary">
                  每条文字保持单行；空行不参与生成，过长文字会在提交时提示。
                </p>
                <div className="space-y-2">
                  {textRows.map((row, index) => (
                    <div className="flex items-center gap-2" key={`sku-text-${index}`}>
                      <input
                        data-testid={`sku-text-input-${index}`}
                        value={row}
                        onChange={(event) =>
                          setTextRows((rows) =>
                            rows.map((value, rowIndex) =>
                              rowIndex === index ? event.target.value : value,
                            ),
                          )
                        }
                        className="min-w-0 flex-1 rounded-lg border border-border-medium bg-transparent px-3 py-2 text-sm"
                        placeholder={`第 ${index + 1} 条文字`}
                      />
                      <button
                        type="button"
                        aria-label="上移"
                        onClick={() => moveRow(index, -1)}
                        className="rounded p-2 hover:bg-surface-hover"
                      >
                        <ArrowUp className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="下移"
                        onClick={() => moveRow(index, 1)}
                        className="rounded p-2 hover:bg-surface-hover"
                      >
                        <ArrowDown className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="删除文字"
                        onClick={() => removeRow(index)}
                        className="rounded p-2 hover:bg-surface-hover"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
                {textValidationError && (
                  <p className="mt-2 text-sm text-red-500" data-testid="sku-text-validation">
                    {textValidationError}
                  </p>
                )}
                <button
                  type="button"
                  onClick={addRow}
                  className="mt-3 inline-flex items-center gap-1 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                >
                  <Plus className="h-4 w-4" />
                  添加文字
                </button>
              </div>
              <button
                type="button"
                disabled={!canSubmit || submitting || uploading !== null}
                onClick={() => void handleSubmit()}
                className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : '批量生成'}
              </button>
            </div>
            <div className="space-y-4 rounded-xl border border-border-light p-4">
              <div className="flex items-center justify-between">
                <h2 className="font-medium">版式预览</h2>
                <span className="text-xs text-text-secondary">{TEMPLATE_KEY}</span>
              </div>
              <SkuPreview
                sourceUrl={sourceUrl}
                leftIconUrl={leftIconUrl}
                rightIconUrl={rightIconUrl}
                text={nonEmptyRows[0] || ''}
              />
            </div>
          </section>
          {batch && (
            <section className="space-y-4 rounded-xl border border-border-light p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-medium">生成结果</h2>
                  <p className="text-sm text-text-secondary">
                    {batch.completedCount}/{batch.outputCount} 张完成
                  </p>
                </div>
                <span className="rounded-full bg-surface-secondary px-3 py-1 text-sm">
                  {getStatusLabel(batch.status)}
                </span>
                {!TERMINAL_STATUSES.has(batch.status) && (
                  <button
                    type="button"
                    onClick={() => void cancelSkuBatch(batch.batchId).then(setBatch)}
                    className="rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                  >
                    取消任务
                  </button>
                )}
              </div>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {batch.items.map((item) => (
                  <article
                    key={item.itemId}
                    className="overflow-hidden rounded-lg border border-border-light p-3"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{item.text}</span>
                      <span className="text-xs text-text-secondary">
                        {getItemStatusLabel(item.status)}
                      </span>
                    </div>
                    {item.status === 'succeeded' && <SkuResultPreview item={item} />}
                    {item.error && <p className="mt-2 text-sm text-red-500">{item.error}</p>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.status === 'succeeded' && item.outputFileId && (
                        <button
                          type="button"
                          onClick={() => void handleDownload(item)}
                          disabled={downloadingFileId === item.outputFileId}
                          className="rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover disabled:opacity-50"
                        >
                          {downloadingFileId === item.outputFileId ? '下载中…' : '下载'}
                        </button>
                      )}
                      {item.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() =>
                            void retrySkuBatchItem(batch.batchId, item.itemId)
                              .then(() => getSkuBatch(batch.batchId))
                              .then(setBatch)
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                        >
                          <RotateCcw className="h-4 w-4" />
                          重试
                        </button>
                      )}
                      {item.status === 'succeeded' && item.outputFileId && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              navigate(
                                `/sku-generation?sourceFileId=${encodeURIComponent(item.outputFileId!)}&sourceType=sku-result`,
                              )
                            }
                            className="rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                          >
                            再次制作 SKU 图
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              navigate(
                                `/image-generation?sourceFileId=${encodeURIComponent(item.outputFileId!)}&sourceType=sku-result`,
                              )
                            }
                            className="rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                          >
                            继续单图改图
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
