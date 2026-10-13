import { useRef, useCallback, useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { OGDialog, OGDialogContent, Spinner, useToastContext } from '@librechat/client';
import {
  megabyte,
  SystemRoles,
  mergeFileConfig,
  SKILL_CATEGORIES,
  SKILL_CATEGORIES_MAX,
  fileConfig as defaultFileConfig,
} from 'librechat-data-provider';
import { useGetFileConfig, useImportSkillMutation } from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface UploadSkillDialogProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

function formatMegabytes(bytes: number): string {
  const value = bytes / megabyte;
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

export default function UploadSkillDialog({ isOpen, setIsOpen }: UploadSkillDialogProps) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const { user } = useAuthContext();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [visibility, setVisibility] = useState<'private' | 'global'>('private');
  const [displayTitle, setDisplayTitle] = useState('');
  const [categories, setCategories] = useState<string[]>([]);

  const toggleCategory = (category: string) => {
    setCategories((prev) =>
      prev.includes(category)
        ? prev.filter((item) => item !== category)
        : prev.length >= SKILL_CATEGORIES_MAX
          ? prev
          : [...prev, category],
    );
  };
  const isAdmin = user?.role === SystemRoles.ADMIN;
  const { data: skillFileConfig = { fileConfig: defaultFileConfig } } = useGetFileConfig({
    select: (data) => ({
      configuredSizeLimitMb: data?.skills?.fileSizeLimit,
      fileConfig: mergeFileConfig(data),
    }),
  });
  const { configuredSizeLimitMb, fileConfig } = skillFileConfig;
  const skillImportSizeLimit =
    fileConfig.skills?.fileSizeLimit ?? defaultFileConfig.skills?.fileSizeLimit ?? 0;
  const displayedSizeLimit =
    configuredSizeLimitMb !== undefined
      ? `${configuredSizeLimitMb}`
      : formatMegabytes(skillImportSizeLimit);

  useEffect(() => {
    if (!isAdmin && visibility !== 'private') {
      setVisibility('private');
    }
  }, [isAdmin, visibility]);

  useEffect(() => {
    if (!isOpen) {
      setDisplayTitle('');
    }
  }, [isOpen]);

  const importMutation = useImportSkillMutation({
    onSuccess: (skill) => {
      showToast({ status: 'success', message: localize('com_ui_skill_created') });
      setIsOpen(false);
      navigate(`/skills/${skill._id}`);
    },
    onError: (error: unknown) => {
      const errData = (error as { response?: { data?: { error?: string; message?: string } } })
        ?.response?.data;
      const message =
        errData?.message ?? errData?.error ?? localize('com_ui_create_skill_upload_error');
      showToast({ status: 'error', message });
    },
  });

  const handleFile = useCallback(
    (file: File) => {
      if (importMutation.isLoading) {
        return;
      }
      if (file.size > skillImportSizeLimit) {
        showToast({
          status: 'error',
          message: localize('com_ui_skill_upload_size_error', { 0: displayedSizeLimit }),
        });
        return;
      }
      const formData = new FormData();
      formData.append('file', file, file.name);
      formData.append('visibility', isAdmin ? visibility : 'private');
      const trimmedDisplayTitle = displayTitle.trim();
      if (trimmedDisplayTitle) {
        formData.append('displayTitle', trimmedDisplayTitle);
      }
      if (categories.length > 0) {
        formData.append('categories', JSON.stringify(categories));
      }
      importMutation.mutate(formData);
    },
    [
      categories,
      displayTitle,
      displayedSizeLimit,
      importMutation,
      isAdmin,
      localize,
      showToast,
      skillImportSizeLimit,
      visibility,
    ],
  );

  const handleFileInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        handleFile(file);
      }
      event.target.value = '';
    },
    [handleFile],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setIsDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) {
        handleFile(file);
      }
    },
    [handleFile],
  );

  return (
    <OGDialog open={isOpen} onOpenChange={setIsOpen}>
      <OGDialogContent className="w-11/12 max-w-lg overflow-hidden">
        <div className="flex flex-col gap-6 p-1 sm:p-2">
          <h2 className="text-lg font-bold text-text-primary">
            {localize('com_ui_skill_upload_title')}
          </h2>

          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              disabled={importMutation.isLoading}
              className={cn(
                'flex h-[120px] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-text-secondary transition-colors',
                isDragging
                  ? 'border-border-heavy bg-surface-hover'
                  : 'border-border-medium hover:bg-surface-hover',
                importMutation.isLoading && 'cursor-wait opacity-50',
              )}
            >
              {importMutation.isLoading ? (
                <Spinner className="size-8" />
              ) : (
                <Upload className="size-8 text-text-secondary" aria-hidden="true" />
              )}
              {localize('com_ui_skill_upload_drag')}
            </button>

            <div className="flex flex-col gap-3 text-xs text-text-secondary">
              <label className="flex flex-col gap-1.5 text-sm text-text-primary">
                <span className="font-medium">中文展示名（可选）</span>
                <input
                  type="text"
                  value={displayTitle}
                  maxLength={50}
                  onChange={(event) => {
                    const nextValue = event.target.value.replace(/[<>]/g, '');
                    setDisplayTitle(Array.from(nextValue).slice(0, 50).join(''));
                  }}
                  placeholder="例如：淘宝标题诊断"
                  disabled={importMutation.isLoading}
                  className="h-10 rounded-lg border border-border-medium bg-transparent px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span className="text-xs text-text-secondary">
                  展示给同事看的中文名称，例如：淘宝标题诊断。内部 Skill name 仍需使用英文。
                </span>
              </label>

              <div className="flex flex-col gap-1.5 text-sm text-text-primary">
                <span className="font-medium">类别（可多选，最多 {SKILL_CATEGORIES_MAX} 个）</span>
                <div className="flex flex-wrap gap-1.5">
                  {SKILL_CATEGORIES.map((category) => {
                    const isSelected = categories.includes(category);
                    const disabled =
                      importMutation.isLoading ||
                      (!isSelected && categories.length >= SKILL_CATEGORIES_MAX);
                    return (
                      <button
                        key={category}
                        type="button"
                        disabled={disabled}
                        onClick={() => toggleCategory(category)}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-40',
                          isSelected
                            ? 'border-blue-500 bg-blue-500/10 text-text-primary'
                            : 'border-border-medium text-text-secondary hover:bg-surface-hover',
                        )}
                      >
                        {category}
                      </button>
                    );
                  })}
                </div>
                <span className="text-xs text-text-secondary">
                  {categories.length === 0 ? '未分类' : `已选：${categories.join('、')}`}
                </span>
              </div>

              {isAdmin && (
                <label className="flex items-start gap-2 rounded-lg border border-border-light bg-surface-secondary p-3 text-text-secondary">
                  <input
                    type="checkbox"
                    checked={visibility === 'global'}
                    onChange={(event) => setVisibility(event.target.checked ? 'global' : 'private')}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-medium text-text-primary">公司级 Skill</span>
                    <span>勾选后，所有登录员工都可以在 Skill 列表中看到并使用。</span>
                  </span>
                </label>
              )}
              <div>
                <p className="font-medium">{localize('com_ui_skill_upload_requirements')}</p>
                <ul className="mt-1 list-inside list-disc">
                  <li>{localize('com_ui_skill_upload_req_md')}</li>
                  <li>{localize('com_ui_skill_upload_req_zip')}</li>
                  <li>{localize('com_ui_skill_upload_req_size', { 0: displayedSizeLimit })}</li>
                </ul>
              </div>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,.skill,.md"
            className="hidden"
            onChange={handleFileInput}
          />
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
