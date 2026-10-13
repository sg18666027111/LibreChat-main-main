import type { CSSProperties } from 'react';
import { SKU_TEMPLATE_V1 } from './skuTemplate';

type SkuPreviewProps = {
  sourceUrl?: string;
  leftIconUrl?: string;
  rightIconUrl?: string;
  text: string;
};

const previewStyle: CSSProperties = {
  aspectRatio: '1 / 1',
  maxWidth: 480,
};

export default function SkuPreview({
  sourceUrl,
  leftIconUrl,
  rightIconUrl,
  text,
}: SkuPreviewProps) {
  const { preview } = SKU_TEMPLATE_V1;
  return (
    <div
      className="relative mx-auto w-full overflow-hidden rounded-xl border border-border-light bg-white"
      style={previewStyle}
      data-testid="sku-live-preview"
    >
      {sourceUrl && (
        <img
          src={sourceUrl}
          alt="SKU 源图预览"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {leftIconUrl && (
        <img
          data-testid="sku-preview-left-asset"
          src={leftIconUrl}
          alt="模板左上素材"
          className="absolute object-contain"
          style={preview.leftIcon}
        />
      )}
      {rightIconUrl && (
        <img
          data-testid="sku-preview-right-asset"
          src={rightIconUrl}
          alt="模板右上素材"
          className="absolute object-contain"
          style={preview.rightIcon}
        />
      )}
      <div
        data-testid="sku-template-badge"
        className="absolute inline-flex items-center whitespace-nowrap font-semibold leading-none text-white"
        style={{
          ...preview.badge,
          width: 'max-content',
          maxWidth: 'calc(100% - 3%)',
          backgroundColor: '#d71920',
        }}
      >
        {text.trim() || '预览文字'}
      </div>
    </div>
  );
}
