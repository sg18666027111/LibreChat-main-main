import { useEffect, useMemo, useState } from 'react';
import { Info, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useForm, Controller, FormProvider } from 'react-hook-form';
import { Input, Button, Skeleton, TextareaAutosize, useToastContext } from '@librechat/client';
import {
  InvocationMode,
  SKILL_NAME_PATTERN,
  SKILL_NAME_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  normalizeSkillCategories,
} from 'librechat-data-provider';
import type { TSkill, TSkillWarning, TUpdateSkillPayload } from 'librechat-data-provider';
import { useGetSkillQuery, useUpdateSkillMutation } from '~/data-provider';
import { useLocalize, useSkillPermissions } from '~/hooks';
import SkillContentEditor from './SkillContentEditor';
import InvocationModePicker from './InvocationModePicker';
import SkillCategoriesSelector from './SkillCategoriesSelector';
import DeleteSkill from '../dialogs/DeleteSkill';
import { ShareSkill } from '../buttons';
import { cn } from '~/utils';

interface SkillFormValues {
  name: string;
  displayTitle: string;
  description: string;
  body: string;
  categories: string[];
  invocationMode: InvocationMode;
}

interface SkillFormProps {
  skillId: string;
}

function toValues(skill: TSkill | undefined): SkillFormValues | undefined {
  if (!skill) {
    return undefined;
  }
  return {
    name: skill.name,
    displayTitle: skill.displayTitle ?? '',
    description: skill.description,
    body: skill.body ?? '',
    categories: normalizeSkillCategories(skill.categories, skill.category),
    // Phase 1: backend doesn't persist invocationMode yet — default to `auto`
    // so the picker has a selection. UI state only; discarded on save until
    // the backend lands the column.
    invocationMode: skill.invocationMode ?? InvocationMode.auto,
  };
}

export default function SkillForm({ skillId }: SkillFormProps) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const [warnings, setWarnings] = useState<TSkillWarning[] | null>(null);

  const skillQuery = useGetSkillQuery(skillId);
  const skill = skillQuery.data;
  const permissions = useSkillPermissions(skill);

  const values = useMemo(() => toValues(skill), [skill]);
  const [isEditingContent, setIsEditingContent] = useState(false);

  const methods = useForm<SkillFormValues>({
    defaultValues: {
      name: '',
      displayTitle: '',
      description: '',
      body: '',
      categories: [],
      invocationMode: InvocationMode.auto,
    },
    values,
    mode: 'onChange',
  });
  const {
    control,
    handleSubmit,
    reset,
    setError,
    formState: { isDirty, isValid, isSubmitting, errors },
  } = methods;

  useEffect(() => {
    setWarnings(null);
  }, [skillId]);

  const updateSkill = useUpdateSkillMutation({
    onSuccess: (updated) => {
      showToast({
        status: updated.warnings && updated.warnings.length > 0 ? 'warning' : 'success',
        message: localize('com_ui_skill_updated'),
      });
      setWarnings(updated.warnings ?? null);
      reset(toValues(updated));
    },
    onError: (error: unknown) => {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        showToast({ status: 'warning', message: localize('com_ui_skill_update_conflict') });
        skillQuery.refetch();
        return;
      }
      const message =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        localize('com_ui_skill_update_error');
      showToast({ status: 'error', message });
    },
  });

  // `useCallback` would be a no-op: `updateSkill` is a React Query mutation
  // result with an unstable identity, and `handleSubmit` doesn't use
  // `onSubmit` as a memo dependency.
  const onSubmit = (data: SkillFormValues) => {
    if (!skill || updateSkill.isLoading) {
      return;
    }
    const trimmedName = data.name.trim();
    if (!SKILL_NAME_PATTERN.test(trimmedName)) {
      setError('name', { message: localize('com_ui_skill_name_invalid') });
      return;
    }
    const payload: TUpdateSkillPayload = {
      name: trimmedName,
      displayTitle: data.displayTitle.trim(),
      description: data.description.trim(),
      body: data.body,
      categories: data.categories ?? [],
      // `invocationMode` is deliberately NOT forwarded to the backend: the
      // column doesn't exist yet. Phase 2 will promote it to a first-class
      // payload field.
    };
    updateSkill.mutate({
      id: skill._id,
      expectedVersion: skill.version,
      payload,
    });
  };

  if (skillQuery.isLoading || permissions.isLoading) {
    return (
      <div className="w-full px-4 py-2">
        <Skeleton className="mb-3 h-10 w-72" />
        <Skeleton className="mb-3 h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (skillQuery.isError || !skill) {
    return (
      <div className="w-full px-4 py-6 text-sm text-text-secondary">
        <p className="font-medium text-text-primary">{localize('com_ui_skill_not_found')}</p>
        <p>{localize('com_ui_skill_not_found_description')}</p>
      </div>
    );
  }

  const readOnly = !permissions.canEdit;
  const saveDisabled = !isDirty || !isValid || isSubmitting || updateSkill.isLoading;

  return (
    <FormProvider {...methods}>
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="w-full px-4 py-2"
        aria-label={localize('com_ui_skill_edit_title')}
      >
        <h1 className="sr-only">{localize('com_ui_skill_edit_title')}</h1>

        <div className="mb-1 flex flex-col items-center justify-between font-bold sm:text-xl md:mb-0 md:text-2xl">
          <div className="flex w-full flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
            <Controller
              name="name"
              control={control}
              rules={{
                required: localize('com_ui_skill_name_required'),
                pattern: {
                  value: SKILL_NAME_PATTERN,
                  message: localize('com_ui_skill_name_invalid'),
                },
                maxLength: {
                  value: SKILL_NAME_MAX_LENGTH,
                  message: localize('com_ui_skill_name_too_long', {
                    0: String(SKILL_NAME_MAX_LENGTH),
                  }),
                },
              }}
              render={({ field }) => (
                <div className="relative mb-1 flex w-full flex-col sm:w-auto md:mb-0">
                  <Input
                    {...field}
                    id="skill-name"
                    type="text"
                    readOnly={readOnly}
                    className="peer mr-2 w-full border border-border-medium p-2 text-2xl text-text-primary"
                    placeholder=" "
                    tabIndex={0}
                    aria-label="内部名称"
                    aria-required="true"
                    aria-invalid={errors.name ? 'true' : 'false'}
                    aria-describedby={errors.name ? 'skill-name-error' : undefined}
                  />
                  <label
                    htmlFor="skill-name"
                    className="pointer-events-none absolute -top-1 left-3 origin-[0] translate-y-3 scale-100 rounded bg-presentation px-1 text-base text-text-secondary transition-transform duration-200 peer-placeholder-shown:translate-y-3 peer-placeholder-shown:scale-100 peer-focus:-translate-y-2 peer-focus:scale-75 peer-focus:text-text-primary peer-[:not(:placeholder-shown)]:-translate-y-2 peer-[:not(:placeholder-shown)]:scale-75"
                  >
                    内部名称*
                  </label>
                  <p className="mt-1 w-64 text-xs font-normal text-text-secondary">
                    系统内部使用的英文 slug，只支持小写字母、数字和短横线。
                  </p>
                  <div
                    id="skill-name-error"
                    className={cn(
                      'mt-1 w-56 text-sm text-red-500',
                      errors.name ? 'visible h-auto' : 'invisible h-0',
                    )}
                    role={errors.name ? 'alert' : undefined}
                  >
                    {errors.name ? errors.name.message : ' '}
                  </div>
                </div>
              )}
            />
            <div className="flex shrink-0 items-start gap-2">
              {!readOnly && (
                <Button
                  type="submit"
                  disabled={saveDisabled}
                  aria-disabled={saveDisabled || undefined}
                  className={cn('h-9 shrink-0', saveDisabled && 'opacity-50')}
                >
                  {localize('com_ui_save')}
                </Button>
              )}
              <SkillCategoriesSelector readOnly={readOnly} />
              <ShareSkill skill={skill} />
              {permissions.canDelete && (
                <DeleteSkill
                  skillId={skill._id}
                  skillName={skill.name}
                  onDelete={() => navigate('/skills', { replace: true })}
                />
              )}
            </div>
          </div>
        </div>

        <div className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
          <span>{localize('com_ui_skill_version', { 0: String(skill.version) })}</span>
          <span aria-hidden="true">·</span>
          <span>{skill.authorName}</span>
        </div>

        {readOnly && (
          <div
            role="note"
            className="mt-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-600 dark:text-amber-400"
          >
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{localize('com_ui_skill_no_edit_permission')}</span>
          </div>
        )}

        {warnings && warnings.length > 0 && (
          <div
            role="alert"
            className="mt-4 flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-600 dark:text-amber-400"
          >
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="size-4" aria-hidden="true" />
              {localize('com_ui_skill_warnings')}
            </div>
            <ul className="ml-6 list-disc">
              {warnings.map((w) => (
                <li key={`${w.field}:${w.code}`}>{w.message}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 flex w-full flex-col gap-4">
          <Controller
            name="displayTitle"
            control={control}
            rules={{
              maxLength: {
                value: 50,
                message: '中文展示名不能超过 50 字',
              },
              validate: (value) =>
                /[<>]/.test(value) ? '中文展示名不能包含 HTML 字符' : true,
            }}
            render={({ field }) => (
              <div className="flex flex-col">
                <label
                  htmlFor="skill-display-title"
                  className="mb-1 text-sm font-medium text-text-secondary"
                >
                  中文展示名（可选）
                </label>
                <Input
                  {...field}
                  id="skill-display-title"
                  type="text"
                  readOnly={readOnly}
                  maxLength={50}
                  aria-label="中文展示名"
                  aria-invalid={errors.displayTitle ? 'true' : 'false'}
                  aria-describedby={
                    errors.displayTitle ? 'skill-display-title-error' : 'skill-display-title-hint'
                  }
                  onChange={(event) => {
                    const nextValue = event.target.value.replace(/[<>]/g, '');
                    field.onChange(Array.from(nextValue).slice(0, 50).join(''));
                  }}
                  placeholder="例如：天猫店铺诊断"
                  className="w-full rounded-xl border border-border-medium bg-transparent p-3 text-sm text-text-primary placeholder:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
                />
                <p id="skill-display-title-hint" className="mt-1 text-xs text-text-secondary">
                  展示给同事看的中文名称，例如：天猫店铺诊断。内部名称仍使用英文。
                </p>
                {errors.displayTitle && (
                  <p
                    id="skill-display-title-error"
                    className="mt-1 text-sm text-red-500"
                    role="alert"
                  >
                    {errors.displayTitle.message}
                  </p>
                )}
              </div>
            )}
          />

          <Controller
            name="description"
            control={control}
            rules={{
              required: localize('com_ui_skill_description_required'),
              maxLength: {
                value: SKILL_DESCRIPTION_MAX_LENGTH,
                message: localize('com_ui_skill_description_too_long', {
                  0: String(SKILL_DESCRIPTION_MAX_LENGTH),
                }),
              },
            }}
            render={({ field }) => (
              <div className="flex flex-col">
                <label
                  htmlFor="skill-description"
                  className="mb-1 text-sm font-medium text-text-secondary"
                >
                  {localize('com_ui_description')}
                  <span className="ml-0.5 text-red-500">*</span>
                </label>
                <TextareaAutosize
                  {...field}
                  id="skill-description"
                  readOnly={readOnly}
                  minRows={2}
                  maxRows={6}
                  aria-label={localize('com_ui_description')}
                  aria-invalid={errors.description ? 'true' : 'false'}
                  aria-describedby={errors.description ? 'skill-description-error' : undefined}
                  className="w-full resize-none rounded-xl border border-border-medium bg-transparent p-3 text-sm text-text-primary placeholder:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
                />
                <p className="mt-1 text-xs text-text-secondary">
                  {localize('com_ui_skill_description_field_hint')}
                </p>
                {errors.description && (
                  <p
                    id="skill-description-error"
                    className="mt-1 text-sm text-red-500"
                    role="alert"
                  >
                    {errors.description.message}
                  </p>
                )}
              </div>
            )}
          />

          <SkillContentEditor
            name="body"
            isEditing={isEditingContent}
            setIsEditing={setIsEditingContent}
          />

          {!readOnly && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => reset(values)}
                disabled={!isDirty}
                className={cn(!isDirty && 'opacity-50')}
              >
                {localize('com_ui_reset')}
              </Button>
              <Button
                type="submit"
                disabled={saveDisabled}
                aria-disabled={saveDisabled || undefined}
                className={cn('w-full sm:w-auto', saveDisabled && 'opacity-50')}
              >
                {localize('com_ui_save')}
              </Button>
            </div>
          )}
        </div>
      </form>
    </FormProvider>
  );
}
