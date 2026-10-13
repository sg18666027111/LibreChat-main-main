import React, { useState, useRef, useMemo, useEffect } from 'react';
import { Skeleton, useToastContext } from '@librechat/client';
import { apiBaseUrl } from 'librechat-data-provider';
import DialogImage from './DialogImage';
import { cn } from '~/utils';
import { downloadImageAsset } from '~/utils/downloadFile';

/** Max display height for chat images (Tailwind JIT class) */
export const IMAGE_MAX_H = 'max-h-[45vh]' as const;
/** Matches the `max-w-lg` Tailwind class on the wrapper button (32rem = 512px at 16px base) */
const IMAGE_MAX_W_PX = 512;

/** Caches image dimensions by src so remounts can reserve space */
const dimensionCache = new Map<string, { width: number; height: number }>();
/** Tracks URLs that have been fully painted — skip skeleton on remount */
const paintedUrls = new Set<string>();

/** Test-only: resets module-level caches */
export function _resetImageCaches(): void {
  dimensionCache.clear();
  paintedUrls.clear();
}

function computeHeightStyle(w: number, h: number): React.CSSProperties {
  return { height: `min(45vh, ${(h / w) * 100}vw, ${(h / w) * IMAGE_MAX_W_PX}px)` };
}

const Image = ({
  imagePath,
  altText,
  className,
  args,
  width,
  height,
}: {
  imagePath: string;
  altText: string;
  className?: string;
  args?: {
    prompt?: string;
    quality?: 'low' | 'medium' | 'high';
    size?: string;
    style?: string;
    [key: string]: unknown;
  };
  width?: number;
  height?: number;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [hasLoadError, setHasLoadError] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { showToast } = useToastContext();

  const absoluteImageUrl = useMemo(() => {
    if (!imagePath) return imagePath;

    if (
      imagePath.startsWith('http') ||
      imagePath.startsWith('data:') ||
      !imagePath.startsWith('/images/')
    ) {
      return imagePath;
    }

    const baseURL = apiBaseUrl();
    return `${baseURL}${imagePath}`;
  }, [imagePath]);

  useEffect(() => {
    setHasLoadError(false);
    setIsOpen(false);
  }, [absoluteImageUrl]);

  const downloadImage = async () => {
    try {
      await downloadImageAsset({
        source: absoluteImageUrl,
        filename: altText || 'image.png',
      });
    } catch (error) {
      console.error('Download failed:', error);
      showToast({
        status: 'error',
        message: '下载失败：服务器返回的不是图片文件。',
      });
    }
  };

  useEffect(() => {
    if (width && height && absoluteImageUrl) {
      dimensionCache.set(absoluteImageUrl, { width, height });
    }
  }, [absoluteImageUrl, width, height]);

  const dims = width && height ? { width, height } : dimensionCache.get(absoluteImageUrl);
  const hasDimensions = !!(dims?.width && dims?.height);
  const heightStyle = hasDimensions ? computeHeightStyle(dims.width, dims.height) : undefined;
  const showSkeleton = hasDimensions && !paintedUrls.has(absoluteImageUrl) && !hasLoadError;

  if (hasLoadError) {
    return (
      <div>
        <button
          ref={triggerRef}
          type="button"
          aria-label="图片文件已失效"
          disabled
          className={cn(
            'relative mt-1 flex min-h-24 w-full max-w-lg cursor-not-allowed items-center justify-center overflow-hidden rounded-lg border border-border-light bg-surface-secondary px-4 py-6 text-sm text-text-secondary shadow-md',
            className,
          )}
          style={heightStyle}
        >
          图片文件已失效
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`View ${altText} in dialog`}
        aria-haspopup="dialog"
        onClick={() => setIsOpen(true)}
        className={cn(
          'relative mt-1 w-full max-w-lg cursor-pointer overflow-hidden rounded-lg border border-border-light text-text-secondary-alt shadow-md transition-shadow',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-primary',
          className,
        )}
        style={heightStyle}
      >
        {showSkeleton && <Skeleton className="absolute inset-0" aria-hidden="true" />}
        <img
          alt={altText}
          src={absoluteImageUrl}
          onLoad={() => paintedUrls.add(absoluteImageUrl)}
          onError={() => setHasLoadError(true)}
          className={cn(
            'relative block text-transparent',
            hasDimensions
              ? 'size-full object-contain'
              : cn('h-auto w-auto max-w-full', IMAGE_MAX_H),
          )}
        />
      </button>
      <DialogImage
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        src={absoluteImageUrl}
        downloadImage={downloadImage}
        args={args}
        triggerRef={triggerRef}
      />
    </div>
  );
};

export default Image;
