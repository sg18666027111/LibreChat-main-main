import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useRecoilState } from 'recoil';
import { Wand2, X } from 'lucide-react';
import { useToastContext } from '@librechat/client';
import { dataService, Constants } from 'librechat-data-provider';
import type { TConversation, TPreset, TSkillSummary } from 'librechat-data-provider';
import type { ConvoGenerator } from '~/common';
import { useListSkillsQuery } from '~/data-provider';
import store from '~/store';

/** 经济舱：Skill 合并内容（SKILL.md + references）字符上限，超过则不允许引用。 */
const MAX_SKILL_CONTEXT_CHARS = 50000;
const NEW_CONVO_ID: string = Constants.NEW_CONVO;

function SkillReference({
  conversation,
  newConversation,
  variant = 'inline',
}: {
  conversation: TConversation | null;
  newConversation: ConvoGenerator;
  variant?: 'inline' | 'chip' | 'trigger';
}) {
  const { showToast } = useToastContext();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [referenced, setReferenced] = useRecoilState(store.referencedSkill);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** 标记“刚选/取消 Skill 触发了新建对话”，用于区分本会话改绑 vs 切到其它会话。 */
  const awaitingNewConvoRef = useRef(false);

  const currentConvoId = conversation?.conversationId ?? NEW_CONVO_ID;

  const { data, isLoading, isError } = useListSkillsQuery({ limit: 50 }, { enabled: open });
  const skills = data?.skills ?? [];

  useEffect(() => {
    if (open && isError) {
      showToast({ message: 'Skill 列表加载失败，请稍后重试。', status: 'error' });
    }
  }, [open, isError, showToast]);

  /**
   * 会话绑定维护：
   * - 本会话从 NEW_CONVO 拿到真实 id（首条消息后）→ 改绑到真实 id，标签延续。
   * - 用户切到其它/历史会话 → 清空引用，避免无感误注入。
   */
  useEffect(() => {
    if (variant === 'chip') {
      return;
    }
    if (!referenced) {
      return;
    }
    if (referenced.boundConvoId === currentConvoId) {
      return;
    }
    if (awaitingNewConvoRef.current && currentConvoId !== NEW_CONVO_ID) {
      awaitingNewConvoRef.current = false;
      setReferenced({ ...referenced, boundConvoId: currentConvoId });
      return;
    }
    setReferenced(null);
  }, [currentConvoId, referenced, setReferenced, variant]);

  /** 切换/取消 Skill 时自动新建对话，保留当前模型，避免上下文串台。 */
  const startNewConversationKeepingModel = () => {
    newConversation({
      template: {
        ...(conversation ?? {}),
        conversationId: Constants.NEW_CONVO,
      } as Partial<TConversation>,
      preset: (conversation ?? undefined) as Partial<TPreset> | undefined,
      keepAddedConvos: false,
    });
  };

  const handleSelect = async (skill: TSkillSummary) => {
    if (checking) {
      return;
    }
    setChecking(true);
    try {
      if (skill.visibility !== 'global') {
        const [detail, files] = await Promise.all([
          dataService.getSkill(skill._id),
          dataService.listSkillFiles(skill._id),
        ]);
        const bodyChars = (detail?.body ?? '').length;
        const refChars = (files?.files ?? []).reduce((sum, file) => sum + (file?.bytes ?? 0), 0);
        if (bodyChars + refChars > MAX_SKILL_CONTEXT_CHARS) {
          showToast({ message: 'Skill 内容过大，第一版暂不支持全量引用。', status: 'error' });
          return;
        }
      }
    } catch {
      showToast({ message: 'Skill 读取失败，请稍后重试。', status: 'error' });
      return;
    } finally {
      setChecking(false);
    }

    awaitingNewConvoRef.current = true;
    setReferenced({
      name: skill.name,
      displayTitle: skill.displayTitle,
      description: skill.description,
      version: skill.version,
      boundConvoId: NEW_CONVO_ID,
    });
    setOpen(false);
    startNewConversationKeepingModel();
  };

  const handleCancel = () => {
    awaitingNewConvoRef.current = false;
    setReferenced(null);
    setOpen(false);
    startNewConversationKeepingModel();
  };

  const updatePanelPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const width = 360;
    const margin = 12;
    const gap = 8;
    const left = Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin);
    const maxHeight = Math.min(360, Math.max(220, rect.top - margin - gap));
    const bottom = window.innerHeight - rect.top + gap;
    setPanelStyle({ left, bottom, width, maxHeight });
  }, []);

  const toggleOpen = () => {
    updatePanelPosition();
    setOpen((value) => !value);
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    updatePanelPosition();
    window.addEventListener('resize', updatePanelPosition);
    window.addEventListener('scroll', updatePanelPosition, true);

    return () => {
      window.removeEventListener('resize', updatePanelPosition);
      window.removeEventListener('scroll', updatePanelPosition, true);
    };
  }, [open, updatePanelPosition]);

  const renderTrigger = () => (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggleOpen}
        className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-text-secondary hover:bg-surface-hover"
      >
        <Wand2 className="h-4 w-4" />
        Skill
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 overflow-y-auto rounded-xl border border-border-light bg-surface-primary p-2 shadow-xl"
            style={panelStyle}
          >
            <div className="px-2 py-1 text-xs font-semibold text-text-secondary">选择已上传的 Skill</div>
            {isLoading ? (
              <div className="px-2 py-3 text-xs text-text-secondary">加载中...</div>
            ) : skills.length === 0 ? (
              <div className="px-2 py-3 text-xs text-text-secondary">暂无可用 Skill。</div>
            ) : (
              skills.map((skill) => (
                <button
                  key={skill._id}
                  type="button"
                  disabled={checking}
                  onClick={() => handleSelect(skill)}
                  className="flex w-full flex-col gap-0.5 rounded-lg p-2 text-left hover:bg-surface-hover disabled:opacity-60"
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                    <span className="min-w-0 truncate">{skill.displayTitle || skill.name}</span>
                    {skill.visibility === 'global' && (
                      <span className="shrink-0 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-300">
                        公司
                      </span>
                    )}
                  </span>
                  {(skill.categories ?? (skill.category ? [skill.category] : [])).length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {(skill.categories ?? (skill.category ? [skill.category] : []))
                        .slice(0, 3)
                        .map((category) => (
                          <span
                            key={category}
                            className="rounded bg-surface-active-alt px-1.5 py-0.5 text-[10px] text-text-secondary"
                          >
                            {category}
                          </span>
                        ))}
                    </span>
                  )}
                  {skill.description && (
                    <span className="line-clamp-2 text-xs text-text-secondary">
                      {skill.description}
                    </span>
                  )}
                  <span className="text-[11px] text-text-secondary">
                    v{skill.version}
                    {skill.updatedAt
                      ? ` · ${new Date(skill.updatedAt).toLocaleDateString('zh-CN')}`
                      : ''}
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );

  const renderChip = () =>
    referenced ? (
      <div className="flex px-4 pt-2">
        <span className="flex max-w-full items-center gap-1 rounded-full bg-surface-active-alt px-2.5 py-1 text-xs text-text-primary">
          <span className="truncate">Skill：{referenced.displayTitle || referenced.name}</span>
          <button
            type="button"
            aria-label="取消引用 Skill"
            onClick={handleCancel}
            className="shrink-0 rounded p-0.5 text-text-secondary hover:bg-surface-hover"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
    ) : null;

  if (variant === 'chip') {
    return renderChip();
  }

  if (variant === 'trigger') {
    return renderTrigger();
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
      {renderTrigger()}
      {renderChip()}
    </div>
  );
}

export default SkillReference;
