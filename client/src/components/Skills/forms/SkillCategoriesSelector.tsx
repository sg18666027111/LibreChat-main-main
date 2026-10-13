import { useState } from 'react';
import { Tags, X, Check } from 'lucide-react';
import { useFormContext } from 'react-hook-form';
import { SKILL_CATEGORIES, SKILL_CATEGORIES_MAX } from 'librechat-data-provider';
import { cn } from '~/utils';

interface SkillCategoriesSelectorProps {
  readOnly?: boolean;
}

/**
 * 业务类别多选器：从固定清单多选（最多 5 个），写入表单字段 `categories: string[]`。
 * 仅用于展示/筛选，不参与 Skill 调用。
 */
export default function SkillCategoriesSelector({ readOnly = false }: SkillCategoriesSelectorProps) {
  const { watch, setValue } = useFormContext();
  const [open, setOpen] = useState(false);
  const selected = (watch('categories') as string[] | undefined) ?? [];

  const toggle = (category: string) => {
    const next = selected.includes(category)
      ? selected.filter((item) => item !== category)
      : selected.length >= SKILL_CATEGORIES_MAX
        ? selected
        : [...selected, category];
    setValue('categories', next, { shouldDirty: true, shouldValidate: true });
  };

  const remove = (category: string) => {
    setValue(
      'categories',
      selected.filter((item) => item !== category),
      { shouldDirty: true, shouldValidate: true },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <button
          type="button"
          disabled={readOnly}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border-medium bg-transparent px-3 text-sm text-text-primary transition-colors hover:bg-surface-hover disabled:opacity-60"
          aria-label="选择业务类别"
        >
          <Tags className="h-4 w-4" />
          类别{selected.length > 0 ? `（${selected.length}）` : ''}
        </button>

        {open && !readOnly && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute right-0 z-50 mt-2 w-56 rounded-xl border border-border-light bg-surface-primary p-1.5 shadow-xl">
              <div className="px-2 py-1 text-xs text-text-secondary">最多选择 {SKILL_CATEGORIES_MAX} 个</div>
              {SKILL_CATEGORIES.map((category) => {
                const isSelected = selected.includes(category);
                const disabled = !isSelected && selected.length >= SKILL_CATEGORIES_MAX;
                return (
                  <button
                    key={category}
                    type="button"
                    disabled={disabled}
                    onClick={() => toggle(category)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-surface-hover disabled:opacity-40',
                      isSelected ? 'text-text-primary' : 'text-text-secondary',
                    )}
                  >
                    {category}
                    {isSelected && <Check className="h-4 w-4 text-green-600" />}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {selected.length === 0 ? (
          <span className="text-xs text-text-secondary">未分类</span>
        ) : (
          selected.map((category) => (
            <span
              key={category}
              className="flex items-center gap-1 rounded-full bg-surface-active-alt px-2.5 py-1 text-xs text-text-primary"
            >
              {category}
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`移除类别 ${category}`}
                  onClick={() => remove(category)}
                  className="rounded p-0.5 text-text-secondary hover:bg-surface-hover"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
