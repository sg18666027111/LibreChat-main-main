export const SKU_TEMPLATE_V1_KEY = 'sku_red_delivery_label_v1';

export type SkuTemplateAssetSlot = 'leftIcon' | 'rightIcon';

export const SKU_TEMPLATE_V1 = {
  key: SKU_TEMPLATE_V1_KEY,
  assetVersion: 2,
  name: '模板一：左上/右上固定素材 + 左下动态文字',
  description: '左上和右上素材由模板提供，第一版不可替换。',
  assets: {
    leftIcon: 'leftIcon' as const,
    rightIcon: 'rightIcon' as const,
  },
  preview: {
    leftIcon: { left: '3%', top: '2.5%', width: '18%', height: '27.5%' },
    rightIcon: { right: '3%', top: '2.5%', width: '32%', height: '11.25%' },
    badge: {
      left: '0%',
      bottom: '0%',
      minHeight: '9%',
      padding: '0 2%',
      borderRadius: '0 9999px 9999px 0',
      fontSize: 'clamp(1rem, 3vw, 1.625rem)',
    },
  },
} as const;
