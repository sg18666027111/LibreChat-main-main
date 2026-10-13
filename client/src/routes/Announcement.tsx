import { useCallback, useEffect, useState } from 'react';
import { Megaphone, X } from 'lucide-react';

type AnnouncementSection = { title: string; items: string[] };

type AnnouncementData = {
  enabled: boolean;
  id?: string | null;
  _id?: string | null;
  version?: string | null;
  title?: string | null;
  content?: string | null;
  level?: 'normal' | 'important' | string | null;
  publishedAt?: string | null;
  sections?: AnnouncementSection[];
  announcement?: AnnouncementData | null;
};

const PRODUCTION_POLL_INTERVAL_MS = 5 * 60 * 1000;
const LOCAL_POLL_INTERVAL_MS = 15 * 1000;

function isLocalhost() {
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
}

function shouldLogDiagnostics() {
  return import.meta.env.DEV || isLocalhost();
}

function getPollIntervalMs() {
  return shouldLogDiagnostics() ? LOCAL_POLL_INTERVAL_MS : PRODUCTION_POLL_INTERVAL_MS;
}

function logDiagnostic(message: string, details?: Record<string, unknown>) {
  if (!shouldLogDiagnostics()) {
    return;
  }
  console.info(`[Announcement] ${message}`, details ?? {});
}

function normalizeAnnouncement(res: AnnouncementData): AnnouncementData {
  const announcement = res.announcement && typeof res.announcement === 'object' ? res.announcement : res;
  return {
    ...announcement,
    enabled: Boolean(res.enabled ?? announcement.enabled),
  };
}

function getAnnouncementId(data?: AnnouncementData | null) {
  return data?.id || data?._id || 'config-announcement';
}

function getAnnouncementVersion(data?: AnnouncementData | null) {
  return data?.version == null ? null : String(data.version);
}

function getSeenKey(data?: AnnouncementData | null) {
  const id = getAnnouncementId(data);
  const version = getAnnouncementVersion(data);
  return id && version ? `announcement_seen_${id}_${version}` : null;
}

function readSeen(data?: AnnouncementData | null) {
  const key = getSeenKey(data);
  if (!key) {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSeen(data?: AnnouncementData | null) {
  const key = getSeenKey(data);
  if (!key) {
    return;
  }

  try {
    window.localStorage.setItem(key, 'true');
  } catch {
    /* localStorage unavailable (private mode) — ignore */
  }
}

export default function Announcement() {
  const [data, setData] = useState<AnnouncementData | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);

  const loadAnnouncement = useCallback(async () => {
    try {
      const response = await fetch(`/api/announcement/current?t=${Date.now()}`, {
        cache: 'no-store',
      });
      logDiagnostic('fetch status', { status: response.status, ok: response.ok });

      if (!response.ok) {
        return;
      }

      const res = normalizeAnnouncement((await response.json()) as AnnouncementData);
      const seen = readSeen(res);
      const announcementVersion = getAnnouncementVersion(res);
      const hasUnreadVersion = Boolean(res?.enabled && announcementVersion && seen !== 'true');

      logDiagnostic('fetched announcement', {
        enabled: Boolean(res?.enabled),
        fetchedVersion: announcementVersion,
        seen,
        hasUnread: hasUnreadVersion,
      });

      if (!res?.enabled || !announcementVersion) {
        setData(null);
        setIsOpen(false);
        setHasUnread(false);
        return;
      }

      setData(res);
      setHasUnread(hasUnreadVersion);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[Announcement] failed to load current announcement', error);
      }
    }
  }, []);

  useEffect(() => {
    const pollIntervalMs = getPollIntervalMs();
    logDiagnostic('mounted');
    logDiagnostic('poll started', { pollIntervalMs });
    void loadAnnouncement();
    const intervalId = window.setInterval(() => {
      void loadAnnouncement();
    }, pollIntervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadAnnouncement]);

  const markSeen = () => {
    writeSeen(data);
    setHasUnread(false);
  };

  const openAnnouncement = () => {
    markSeen();
    setIsOpen(true);
  };

  const markSeenAndClose = () => {
    markSeen();
    setIsOpen(false);
  };

  const closeWithoutMarkingSeen = () => {
    setIsOpen(false);
  };

  if (!data?.enabled) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={openAnnouncement}
        className={[
          'fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium shadow-lg transition-colors hover:bg-surface-hover',
          hasUnread
            ? 'border-red-400 bg-surface-primary text-text-primary ring-2 ring-red-500/20'
            : 'border-border-medium bg-surface-primary',
        ].join(' ')}
      >
        <span className="relative flex">
          <Megaphone className="h-4 w-4" aria-hidden="true" />
          {hasUnread && (
            <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
          )}
        </span>
        更新公告
        {hasUnread && (
          <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
            NEW
          </span>
        )}
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={data.title || '更新公告'}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={closeWithoutMarkingSeen}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-light bg-surface-primary shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border-light px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">{data.title || '更新公告'}</h2>
                {data.publishedAt && (
                  <p className="mt-1 text-xs text-text-secondary">发布时间：{data.publishedAt}</p>
                )}
              </div>
              <button
                type="button"
                aria-label="关闭公告"
                onClick={closeWithoutMarkingSeen}
                className="rounded-lg p-1 text-text-secondary hover:bg-surface-hover"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
              {data.content ? (
                <p className="whitespace-pre-wrap text-sm leading-6 text-text-secondary">{data.content}</p>
              ) : (
                (data.sections ?? []).map((section, sectionIndex) => (
                  <section key={`${section.title}-${sectionIndex}`} className="grid gap-2">
                    <h3 className="text-sm font-semibold text-text-primary">{section.title}</h3>
                    <ul className="grid gap-1.5">
                      {(section.items ?? []).map((item, itemIndex) => (
                        <li
                          key={`${section.title}-${itemIndex}`}
                          className="flex gap-2 text-sm leading-6 text-text-secondary"
                        >
                          <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-text-secondary" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </div>

            <div className="border-t border-border-light px-5 py-4">
              <button
                type="button"
                onClick={markSeenAndClose}
                className="flex h-10 w-full items-center justify-center rounded-lg bg-text-primary px-4 text-sm font-medium text-surface-primary transition-opacity hover:opacity-90"
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
