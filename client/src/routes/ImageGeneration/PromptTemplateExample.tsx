/* eslint-disable i18next/no-literal-string */
import { useEffect, useRef, useState } from 'react';
import { request } from 'librechat-data-provider';

export default function PromptTemplateExample({
  url,
  name,
  className = 'max-h-48 max-w-full rounded-lg border border-border-light object-contain',
  deferUntilVisible = false,
}: {
  url?: string;
  name: string;
  className?: string;
  deferUntilVisible?: boolean;
}) {
  const [image, setImage] = useState<{ url: string; src: string } | null>(null);
  const [failedUrl, setFailedUrl] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [isVisible, setIsVisible] = useState(!deferUntilVisible);
  const observerTarget = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!url || isVisible) return;
    if (!deferUntilVisible) {
      setIsVisible(true);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }
    const target = observerTarget.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setIsVisible(true);
      },
      { rootMargin: '320px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [deferUntilVisible, isVisible, url]);

  useEffect(() => {
    if (!url || !isVisible) return;
    let disposed = false;
    let objectUrl = '';
    void (async () => {
      try {
        const response = (await request.getResponse(url, { responseType: 'blob' })) as {
          data: Blob;
        };
        if (disposed) return;
        objectUrl = URL.createObjectURL(response.data);
        setImage({ url, src: objectUrl });
        setFailedUrl('');
      } catch {
        if (!disposed) setFailedUrl(url);
      }
    })();
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isVisible, reloadToken, url]);

  if (!url) return null;
  if (!isVisible) {
    return (
      <span
        ref={observerTarget}
        className={`inline-flex items-center justify-center text-xs text-text-secondary ${className}`}
      >
        图例等待加载
      </span>
    );
  }
  if (failedUrl === url) {
    return (
      <button
        type="button"
        className={`inline-flex items-center justify-center text-xs text-text-secondary underline-offset-2 hover:underline ${className}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setFailedUrl('');
          setImage(null);
          setReloadToken((current) => current + 1);
        }}
      >
        重试加载图例
      </button>
    );
  }
  if (image?.url !== url) {
    return (
      <span
        className={`inline-flex items-center justify-center text-xs text-text-secondary ${className}`}
      >
        图例加载中...
      </span>
    );
  }
  return (
    <img
      src={image.src}
      alt={`${name} 图例`}
      className={className}
      onError={() => setFailedUrl(url)}
    />
  );
}
