const crypto = require('crypto');
const sharp = require('sharp');

const { composeSkuImage, createTextSvg, validateSkuInput } = require('./composeSkuImage');
const { SKU_TEMPLATE_V1 } = require('./skuTemplate');

async function createImage({
  width = 320,
  height = 240,
  format = 'png',
  background = '#2f80ed',
} = {}) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background,
    },
  })
    [format]()
    .toBuffer();
}

function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

describe('SKU template one compositor', () => {
  test.each(['png', 'jpeg', 'webp'])(
    'composes %s inputs into a full-canvas PNG',
    async (format) => {
      const sourceBuffer = await createImage({ format, width: 1000, height: 600 });
      const leftIconBuffer = await createImage({
        format,
        width: 120,
        height: 240,
        background: '#27ae60',
      });
      const rightIconBuffer = await createImage({
        format,
        width: 240,
        height: 120,
        background: '#eb5757',
      });

      const result = await composeSkuImage({
        sourceBuffer,
        leftIconBuffer,
        rightIconBuffer,
        text: '夏日限定',
        templateKey: SKU_TEMPLATE_V1.key,
      });
      const metadata = await sharp(result.buffer).metadata();

      expect(result).toMatchObject({
        mimeType: 'image/png',
        width: 800,
        height: 800,
        templateKey: 'sku_red_delivery_label_v1',
      });
      expect(metadata).toMatchObject({ format: 'png', width: 800, height: 800 });
    },
  );

  test('renders one fixed red badge whose width grows with the text', () => {
    const shortSvg = createTextSvg({ text: '桂花蜜酱', template: SKU_TEMPLATE_V1 });
    const longSvg = createTextSvg({ text: '桂花蜜酱250g*2瓶', template: SKU_TEMPLATE_V1 });
    const shortWidth = Number(shortSvg.match(/A [\d.]+ [\d.]+ 0 0 1 ([\d.]+)/)?.[1]);
    const longWidth = Number(longSvg.match(/A [\d.]+ [\d.]+ 0 0 1 ([\d.]+)/)?.[1]);

    expect(shortSvg.match(/<text\b/g)).toHaveLength(1);
    expect(shortSvg).toContain('font-size: 26px');
    expect(SKU_TEMPLATE_V1.badge.height).toBe(72);
    expect(shortSvg).toContain('<path d="M 0 728');
    expect(shortSvg).not.toContain('<rect');
    expect(shortSvg).toContain(`fill="${SKU_TEMPLATE_V1.badge.background}"`);
    expect(shortSvg).toContain(`A ${SKU_TEMPLATE_V1.badge.radius} ${SKU_TEMPLATE_V1.badge.radius}`);
    expect(longWidth).toBeGreaterThan(shortWidth);
    expect(longSvg).not.toContain('<tspan');
  });

  test('rejects text that cannot fit in the single-line safe area', () => {
    const overflow = '字'.repeat(
      Math.ceil(SKU_TEMPLATE_V1.badge.maxTextWidth / SKU_TEMPLATE_V1.badge.fontSize) + 1,
    );

    expect(() =>
      validateSkuInput({ textRows: [overflow], templateKey: SKU_TEMPLATE_V1.key }),
    ).toThrow(expect.objectContaining({ code: 'SKU_TEXT_TOO_LONG', field: 'textRows[0]' }));
  });

  test('filters blank rows and preserves non-empty row order', () => {
    expect(
      validateSkuInput({
        textRows: ['  第一张  ', '', '  ', '第二张'],
        templateKey: SKU_TEMPLATE_V1.key,
      }).textRows,
    ).toEqual(['第一张', '第二张']);
  });

  test('rejects unknown templates and too many rows', () => {
    expect(() => validateSkuInput({ textRows: ['商品'], templateKey: 'unknown' })).toThrow(
      expect.objectContaining({ code: 'SKU_TEMPLATE_UNKNOWN', field: 'templateKey' }),
    );
    expect(() =>
      validateSkuInput({
        textRows: Array.from(
          { length: SKU_TEMPLATE_V1.maxTextRows + 1 },
          (_, index) => `第${index}`,
        ),
        templateKey: SKU_TEMPLATE_V1.key,
      }),
    ).toThrow(expect.objectContaining({ code: 'SKU_TEXT_ROWS_TOO_MANY', field: 'textRows' }));
  });

  test('escapes SVG-sensitive text before rendering it', () => {
    const svg = createTextSvg({ text: '<b>&"SKU"', template: SKU_TEMPLATE_V1 });

    expect(svg).toContain('&lt;b&gt;&amp;&quot;SKU&quot;');
    expect(svg).not.toContain('<b>');
  });

  test('produces a stable output for the same source, icons, and text', async () => {
    const inputs = {
      sourceBuffer: await createImage({ width: 720, height: 480 }),
      leftIconBuffer: await createImage({ width: 96, height: 96, background: '#9b51e0' }),
      rightIconBuffer: await createImage({ width: 96, height: 96, background: '#f2994a' }),
      text: '同一批次应保持一致',
      templateKey: SKU_TEMPLATE_V1.key,
    };

    const first = await composeSkuImage(inputs);
    const second = await composeSkuImage(inputs);

    expect(hash(first.buffer)).toBe(hash(second.buffer));
  });

  test('rejects invalid image bytes with a field-specific error', async () => {
    await expect(
      composeSkuImage({
        sourceBuffer: Buffer.from('not-an-image'),
        leftIconBuffer: await createImage(),
        rightIconBuffer: await createImage(),
        text: '商品',
        templateKey: SKU_TEMPLATE_V1.key,
      }),
    ).rejects.toMatchObject({ code: 'SKU_IMAGE_INVALID', field: 'sourceBuffer' });
  });
});
