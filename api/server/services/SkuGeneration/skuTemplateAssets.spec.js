const sharp = require('sharp');

const { readSkuTemplateAsset } = require('./skuTemplateAssets');
const { SKU_TEMPLATE_V1 } = require('./skuTemplate');

describe('SKU template assets', () => {
  test.each(['leftIcon', 'rightIcon'])('reads the built-in %s asset', async (slot) => {
    const asset = await readSkuTemplateAsset({ templateKey: SKU_TEMPLATE_V1.key, slot });
    const metadata = await sharp(asset.buffer).metadata();

    expect(asset).toMatchObject({
      contentType: expect.stringMatching(/^image\//),
      filename: expect.any(String),
    });
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.height).toBeGreaterThan(0);
  });

  test('keeps the delivery asset background transparent', async () => {
    const asset = await readSkuTemplateAsset({
      templateKey: SKU_TEMPLATE_V1.key,
      slot: 'rightIcon',
    });
    const { data, info } = await sharp(asset.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBe(0);
  });

  test('rejects an unknown template asset slot', async () => {
    await expect(
      readSkuTemplateAsset({ templateKey: SKU_TEMPLATE_V1.key, slot: 'unknown' }),
    ).rejects.toMatchObject({ code: 'SKU_TEMPLATE_ASSET_UNKNOWN' });
  });
});
