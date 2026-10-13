const {
  getResultImage,
  registerResultImageBuffer,
} = require('~/server/services/ImageGeneration/resultProxy');

describe('resultProxy buffered images', () => {
  test('registers normalized bytes without requiring a remote host', () => {
    const buffer = Buffer.from('normalized-image');

    const registered = registerResultImageBuffer({
      buffer,
      contentType: 'image/png',
      provider: 'apimart',
      filename: 'batch-main-image.png',
    });
    const entry = getResultImage(registered.token);

    expect(entry).toMatchObject({
      buffer,
      contentType: 'image/png',
      provider: 'apimart',
      filename: 'batch-main-image.png',
      host: null,
      resultUrl: null,
    });
  });
});
