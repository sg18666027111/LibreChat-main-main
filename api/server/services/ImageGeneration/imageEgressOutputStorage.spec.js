const sharp = require('sharp');

const {
  downloadImageEgressOutput,
  sanitizeImageEgressOutputUrl,
  storeImageEgressOutput,
} = require('./imageEgressOutputStorage');

async function createPng() {
  return sharp({
    create: { width: 2, height: 2, channels: 4, background: '#2563eb' },
  })
    .png()
    .toBuffer();
}

describe('image egress output storage', () => {
  it('retries the identical output URL after one transient download timeout', async () => {
    const png = await createPng();
    const signedURL = 'https://cdn.example/image.png?signature=secret-token';
    const downloadProviderResult = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('timeout'), { code: 'RESULT_DOWNLOAD_TIMEOUT' }),
      )
      .mockResolvedValueOnce({
        buffer: png,
        contentType: 'image/png',
        hostname: 'cdn.example',
        redirectHostnames: [],
      });

    const result = await downloadImageEgressOutput({
      url: signedURL,
      provider: 'fal',
      deps: {
        downloadProviderResult,
        sleep: async () => {},
        monotonicNow: () => 0,
        random: () => 0.5,
      },
    });

    expect(downloadProviderResult.mock.calls.map(([input]) => input.url)).toEqual([
      signedURL,
      signedURL,
    ]);
    expect(result).toMatchObject({
      buffer: png,
      contentType: 'image/png',
      retryDiagnostics: { attempts: 2 },
      sourceMetadata: {
        hostname: 'cdn.example',
        hasQuery: true,
        pathHash: expect.any(String),
        urlHash: expect.any(String),
      },
    });
    expect(JSON.stringify(result.sourceMetadata)).not.toContain('secret-token');
  });

  it('does not retry an invalid image response', async () => {
    const error = Object.assign(new Error('invalid'), { code: 'INVALID_RESULT_IMAGE' });
    const downloadProviderResult = jest.fn().mockRejectedValue(error);

    await expect(
      downloadImageEgressOutput({
        url: 'https://cdn.example/image.png',
        provider: 'apimart',
        deps: {
          downloadProviderResult,
          sleep: async () => {},
          monotonicNow: () => 0,
          random: () => 0.5,
        },
      }),
    ).rejects.toBe(error);
    expect(downloadProviderResult).toHaveBeenCalledTimes(1);
  });

  it('stores output bytes through durable file storage and returns metadata only', async () => {
    const png = await createPng();
    const uploadImageBuffer = jest.fn().mockResolvedValue({
      file_id: 'output-file-1',
      filename: 'output.png',
      type: 'image/png',
      bytes: png.length,
      source: 'local',
      filepath: '/private/output.png',
    });
    const result = await storeImageEgressOutput({
      job: { internalTaskId: 'task-1', userId: 'user-1', tenantId: 'tenant-1' },
      downloaded: { buffer: png, contentType: 'image/png' },
      storageConfig: { fileStrategy: 'local' },
      deps: { uploadImageBuffer },
    });

    expect(result).toEqual({
      fileRef: {
        fileId: 'output-file-1',
        filename: 'output.png',
        contentType: 'image/png',
        bytes: png.length,
      },
      expiresAt: expect.any(Date),
    });
    expect(JSON.stringify(result)).not.toMatch(/private\/output|base64/);
    expect(uploadImageBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        durableIntent: true,
        metadata: expect.objectContaining({ expiredAt: result.expiresAt }),
      }),
    );
  });

  it('does not require a second retention update after the durable file create', async () => {
    const png = await createPng();
    const saved = {
      file_id: 'output-file-unretained',
      filename: 'output.png',
      type: 'image/png',
      bytes: png.length,
      source: 'local',
      filepath: '/private/output.png',
    };
    await expect(
      storeImageEgressOutput({
        job: { internalTaskId: 'task-1', userId: 'user-1', tenantId: 'tenant-1' },
        downloaded: { buffer: png, contentType: 'image/png' },
        storageConfig: { fileStrategy: 'local' },
        deps: {
          uploadImageBuffer: jest.fn().mockResolvedValue(saved),
          updateFile: jest.fn().mockResolvedValue(null),
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        fileRef: expect.objectContaining({ fileId: 'output-file-unretained' }),
      }),
    );
  });

  it('sanitizes signed URLs to non-secret diagnostic hashes', () => {
    const metadata = sanitizeImageEgressOutputUrl(
      'https://cdn.example/path/image.png?X-Amz-Signature=top-secret',
    );

    expect(metadata).toEqual({
      hostname: 'cdn.example',
      pathHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      urlHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      hasQuery: true,
    });
    expect(JSON.stringify(metadata)).not.toMatch(/top-secret|X-Amz/i);
  });
});
