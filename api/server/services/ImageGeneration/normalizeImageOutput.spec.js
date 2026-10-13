const sharp = require('sharp');

const mockDownloadProviderResult = jest.fn();

jest.mock('~/server/services/ImageGeneration/providerResultDownload', () => ({
  downloadProviderResult: mockDownloadProviderResult,
}));

const {
  normalizeGeneratedImageOutput,
  normalizeGeneratedImageResult,
} = require('~/server/services/ImageGeneration/normalizeImageOutput');

async function createPng(width, height, colour = '#d946ef') {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: colour,
    },
  })
    .png()
    .toBuffer();
}

describe('normalizeGeneratedImageOutput', () => {
  test('keeps an exact 800x800 PNG without re-encoding it', async () => {
    const input = await createPng(800, 800);

    const result = await normalizeGeneratedImageOutput({
      image: { buffer: input },
      targetWidth: 800,
      targetHeight: 800,
    });

    expect(result.normalized).toBe(false);
    expect(result.buffer).toBe(input);
    expect(result).toMatchObject({
      originalWidth: 800,
      originalHeight: 800,
      width: 800,
      height: 800,
      mimeType: 'image/png',
    });
  });

  test.each([
    [1024, 1024],
    [768, 1024],
    [1024, 768],
  ])('cover-crops and resizes %ix%i to real 800x800 pixels', async (width, height) => {
    const input = await createPng(width, height);

    const result = await normalizeGeneratedImageOutput({
      image: { buffer: input },
      targetWidth: 800,
      targetHeight: 800,
    });
    const metadata = await sharp(result.buffer).metadata();

    expect(result.normalized).toBe(true);
    expect(result).toMatchObject({
      originalWidth: width,
      originalHeight: height,
      width: 800,
      height: 800,
      mimeType: 'image/png',
    });
    expect(metadata).toMatchObject({ width: 800, height: 800, format: 'png' });
  });

  test('loads and normalizes a data URI', async () => {
    const input = await createPng(768, 1024);

    const result = await normalizeGeneratedImageOutput({
      image: { b64_json: `data:image/png;base64,${input.toString('base64')}` },
      targetWidth: 1024,
      targetHeight: 1024,
    });

    expect(await sharp(result.buffer).metadata()).toMatchObject({ width: 1024, height: 1024 });
  });

  test('rejects damaged image bytes with a clear code', async () => {
    await expect(
      normalizeGeneratedImageOutput({
        image: { buffer: Buffer.from('not-an-image') },
        targetWidth: 800,
        targetHeight: 800,
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_OUTPUT_INVALID' });
  });

  test('uses the provider-result downloader for an internally trusted APIMart result', async () => {
    const input = await createPng(1024, 1024);
    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: input,
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: ['final-result-cdn.example'],
    });
    const strictUserUrlCheck = jest.fn(() => false);

    const result = await normalizeGeneratedImageOutput({
      image: { url: 'https://temporary-result-cdn.example/signed.png?signature=secret' },
      targetWidth: 800,
      targetHeight: 800,
      isRemoteUrlAllowed: strictUserUrlCheck,
      sourceContext: { sourceType: 'provider_result', provider: 'apimart' },
    });

    expect(mockDownloadProviderResult).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'apimart',
        url: 'https://temporary-result-cdn.example/signed.png?signature=secret',
      }),
    );
    expect(strictUserUrlCheck).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      width: 800,
      height: 800,
      sourceHostname: 'temporary-result-cdn.example',
      redirectHostnames: ['final-result-cdn.example'],
    });
  });

  test('reports download and normalization persistence phases in order', async () => {
    const input = await createPng(1024, 1024);
    mockDownloadProviderResult.mockResolvedValueOnce({
      buffer: input,
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    const phases = [];

    await normalizeGeneratedImageOutput({
      image: { url: 'https://temporary-result-cdn.example/signed.png' },
      targetWidth: 800,
      targetHeight: 800,
      sourceContext: { sourceType: 'provider_result', provider: 'apimart' },
      onProgress: async (phase) => phases.push(phase),
    });

    expect(phases).toEqual([
      'download_started',
      'download_completed',
      'normalization_started',
      'normalization_completed',
    ]);
  });

  test('does not let an ordinary remote URL bypass the strict URL callback', async () => {
    await expect(
      normalizeGeneratedImageOutput({
        image: { url: 'https://unlisted-user-url.example/image.png' },
        targetWidth: 800,
        targetHeight: 800,
        isRemoteUrlAllowed: () => false,
        fetchImpl: jest.fn(),
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_OUTPUT_SOURCE_NOT_ALLOWED' });
    expect(mockDownloadProviderResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://unlisted-user-url.example/image.png' }),
    );
  });
});

describe('normalizeGeneratedImageResult', () => {
  test.each([
    [1024, 1024, false],
    [768, 1024, true],
    [1024, 768, true],
  ])(
    'materializes a Fal %ix%i result as the selected 1024x1024 target',
    async (width, height, expectedNormalized) => {
      const input = await createPng(width, height);
      const result = await normalizeGeneratedImageResult({
        result: {
          resultUrl: `data:image/png;base64,${input.toString('base64')}`,
          taskId: 'fal-task-1',
        },
        targetWidth: 1024,
        targetHeight: 1024,
      });

      expect(result.taskId).toBe('fal-task-1');
      expect(result.images).toHaveLength(1);
      expect(result.images[0]).toMatchObject({
        width: 1024,
        height: 1024,
        originalWidth: width,
        originalHeight: height,
        normalized: expectedNormalized,
        contentType: 'image/png',
      });
      expect(await sharp(result.images[0].buffer).metadata()).toMatchObject({
        width: 1024,
        height: 1024,
      });
    },
  );
});
