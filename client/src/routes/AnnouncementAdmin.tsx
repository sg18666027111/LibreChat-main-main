import { useEffect, useState } from 'react';
import { Loader2, Megaphone, RefreshCw, Save, ToggleLeft, ToggleRight } from 'lucide-react';
import { useToastContext } from '@librechat/client';
import { getTokenHeader } from 'librechat-data-provider';

type AnnouncementLevel = 'normal' | 'important';

type AdminAnnouncement = {
  id: string;
  _id: string;
  title: string;
  content: string;
  enabled: boolean;
  level: AnnouncementLevel;
  version: number;
  publishedAt?: string | null;
  updatedAt?: string | null;
};

async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const authorization = getTokenHeader();
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.message || '操作失败，请稍后重试。');
  }

  return response.json();
}

function formatDate(value?: string | null) {
  if (!value) {
    return '-';
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export default function AnnouncementAdmin() {
  const { showToast } = useToastContext();
  const [announcements, setAnnouncements] = useState<AdminAnnouncement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [level, setLevel] = useState<AnnouncementLevel>('normal');
  const [enabled, setEnabled] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const loadAnnouncements = async () => {
    setIsLoading(true);
    try {
      const response = await apiFetch<{ announcements: AdminAnnouncement[] }>('/api/admin/announcements');
      setAnnouncements(response.announcements || []);
      const latest = response.announcements?.[0];
      if (latest && !selectedId) {
        setSelectedId(latest.id || latest._id);
        setTitle(latest.title || '');
        setContent(latest.content || '');
        setLevel(latest.level || 'normal');
        setEnabled(Boolean(latest.enabled));
      }
    } catch (error) {
      showToast({
        status: 'error',
        message: error instanceof Error ? error.message : '公告加载失败，请稍后重试。',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadAnnouncements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetForm = () => {
    setSelectedId(null);
    setTitle('');
    setContent('');
    setLevel('normal');
    setEnabled(true);
  };

  const selectAnnouncement = (announcement: AdminAnnouncement) => {
    setSelectedId(announcement.id || announcement._id);
    setTitle(announcement.title || '');
    setContent(announcement.content || '');
    setLevel(announcement.level || 'normal');
    setEnabled(Boolean(announcement.enabled));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const body = JSON.stringify({ title, content, level, enabled });
      const response = selectedId
        ? await apiFetch<{ announcement: AdminAnnouncement }>(`/api/admin/announcements/${selectedId}`, {
            method: 'PATCH',
            body,
          })
        : await apiFetch<{ announcement: AdminAnnouncement }>('/api/admin/announcements', {
            method: 'POST',
            body,
          });

      const saved = response.announcement;
      setSelectedId(saved.id || saved._id);
      setAnnouncements((current) => {
        const filtered = current.filter((item) => (item.id || item._id) !== (saved.id || saved._id));
        return [saved, ...filtered];
      });
      showToast({ status: 'success', message: saved.enabled ? '公告已发布' : '公告已保存' });
    } catch (error) {
      showToast({
        status: 'error',
        message: error instanceof Error ? error.message : '公告保存失败，请稍后重试。',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisable = async () => {
    if (!selectedId) {
      return;
    }
    setIsSaving(true);
    try {
      const response = await apiFetch<{ announcement: AdminAnnouncement }>(
        `/api/admin/announcements/${selectedId}/enabled`,
        {
          method: 'PATCH',
          body: JSON.stringify({ enabled: false }),
        },
      );
      const disabled = response.announcement;
      setEnabled(false);
      setAnnouncements((current) =>
        current.map((item) => ((item.id || item._id) === (disabled.id || disabled._id) ? disabled : item)),
      );
      showToast({ status: 'success', message: '公告已停用' });
    } catch (error) {
      showToast({
        status: 'error',
        message: error instanceof Error ? error.message : '公告停用失败，请稍后重试。',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const titleCount = title.trim().length;
  const contentCount = content.trim().length;
  const canSave = titleCount > 0 && titleCount <= 80 && contentCount > 0 && contentCount <= 3000;

  return (
    <div className="h-full overflow-y-auto bg-surface-primary text-text-primary">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
        <header className="flex flex-col gap-2 border-b border-border-light pb-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-active-alt">
              <Megaphone className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-2xl font-semibold">公告管理</h1>
              <p className="text-sm text-text-secondary">
                发布纯文本更新公告，登录用户会在全局公告入口看到未读提醒。
              </p>
            </div>
          </div>
        </header>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="rounded-lg border border-border-light bg-surface-primary-alt p-5">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{selectedId ? '编辑公告' : '新建公告'}</h2>
                <p className="text-sm text-text-secondary">第一版只支持纯文本，换行会安全保留。</p>
              </div>
              <button
                type="button"
                className="rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                onClick={resetForm}
              >
                新建公告
              </button>
            </div>

            <div className="grid gap-4">
              <label className="grid gap-2 text-sm font-medium">
                公告标题
                <input
                  value={title}
                  maxLength={80}
                  className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm"
                  placeholder="例如：本周功能更新"
                  onChange={(event) => setTitle(event.target.value)}
                />
                <span className="text-xs text-text-secondary">{titleCount} / 80</span>
              </label>

              <label className="grid gap-2 text-sm font-medium">
                公告内容
                <textarea
                  value={content}
                  maxLength={3000}
                  rows={10}
                  className="resize-y rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm leading-6"
                  placeholder="请输入公告内容。支持换行，不支持 HTML。"
                  onChange={(event) => setContent(event.target.value)}
                />
                <span className="text-xs text-text-secondary">{contentCount} / 3000</span>
              </label>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-sm font-medium">
                  重要程度
                  <select
                    value={level}
                    className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm"
                    onChange={(event) => setLevel(event.target.value as AnnouncementLevel)}
                  >
                    <option value="normal">普通</option>
                    <option value="important">重要</option>
                  </select>
                </label>

                <label className="grid gap-2 text-sm font-medium">
                  启用状态
                  <button
                    type="button"
                    className="inline-flex h-10 items-center gap-2 rounded-lg border border-border-medium px-3 text-sm hover:bg-surface-hover"
                    onClick={() => setEnabled((current) => !current)}
                  >
                    {enabled ? <ToggleRight className="h-5 w-5 text-green-600" /> : <ToggleLeft className="h-5 w-5" />}
                    {enabled ? '发布后启用' : '仅保存，不启用'}
                  </button>
                </label>
              </div>

              <div className="flex flex-wrap gap-3 pt-2">
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-surface-primary disabled:opacity-60"
                  onClick={handleSave}
                  disabled={!canSave || isSaving}
                >
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {enabled ? '保存 / 发布' : '保存'}
                </button>
                {selectedId && enabled && (
                  <button
                    type="button"
                    className="inline-flex h-10 items-center justify-center rounded-lg border border-border-medium px-4 text-sm hover:bg-surface-hover disabled:opacity-60"
                    onClick={handleDisable}
                    disabled={isSaving}
                  >
                    停用公告
                  </button>
                )}
              </div>
            </div>
          </section>

          <aside className="rounded-lg border border-border-light bg-surface-primary-alt p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">历史公告</h2>
                <p className="text-sm text-text-secondary">用户侧只展示最新启用公告。</p>
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                onClick={loadAnnouncements}
                disabled={isLoading}
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                刷新
              </button>
            </div>

            <div className="grid gap-3">
              {announcements.map((item) => (
                <button
                  key={item.id || item._id}
                  type="button"
                  className={[
                    'rounded-lg border p-3 text-left text-sm hover:bg-surface-hover',
                    selectedId === (item.id || item._id)
                      ? 'border-text-primary bg-surface-active-alt'
                      : 'border-border-light',
                  ].join(' ')}
                  onClick={() => selectAnnouncement(item)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{item.title}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        item.enabled ? 'bg-green-100 text-green-700' : 'bg-surface-active-alt text-text-secondary'
                      }`}
                    >
                      {item.enabled ? '启用' : '停用'}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-text-secondary">{item.content}</p>
                  <p className="mt-2 text-xs text-text-secondary">更新：{formatDate(item.updatedAt)}</p>
                </button>
              ))}

              {!announcements.length && (
                <div className="rounded-lg border border-dashed border-border-medium px-4 py-8 text-center text-sm text-text-secondary">
                  暂无公告
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
