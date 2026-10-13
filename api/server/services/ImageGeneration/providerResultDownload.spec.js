const sharp = require('sharp');

const {
  downloadProviderResult,
} = require('~/server/services/ImageGeneration/providerResultDownload');

async function createPng(width = 8, height = 8) {
  return sharp({
    create: { width, height, channels: 4, background: '#2563eb' },
  })
    .png()
    .toBuffer();
}

function publicLookup() {
  return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
}

describe('downloadProviderResult', () => {
  test('downloads an image from a dynamic public APIMart result hostname', async () => {
    const png = await createPng();
    const fetchImpl = jest.fn(async (_url, options) => {
      expect(options.redirect).toBe('manual');
      expect(options.headers).toEqual({ Accept: 'image/*' });
      expect(options.headers).not.toHaveProperty('Authorization');
      expect(options.headers).not.toHaveProperty('Cookie');
      return new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
      });
    });

    const result = await downloadProviderResult({
      url: 'https://temporary-result-cdn.example/signed/image.png?signature=secret',
      provider: 'apimart',
      fetchImpl,
      lookup: publicLookup,
    });

    expect(result.buffer).toEqual(png);
    expect(result).toMatchObject({
      contentType: 'image/png',
      hostname: 'temporary-result-cdn.example',
      redirectHostnames: [],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('downloads an image from a dynamic public Fal result hostname', async () => {
    const png = await createPng();
    const result = await downloadProviderResult({
      url: 'https://fal-output.example/signed/image.png?token=secret',
      provider: 'fal',
      fetchImpl: jest.fn(
        async () =>
          new Response(png, {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
          }),
      ),
      lookup: publicLookup,
    });

    expect(result).toMatchObject({ contentType: 'image/png', hostname: 'fal-output.example' });
  });

  test('rejects providers outside the explicit APIMart/Fal output allowset', async () => {
    await expect(
      downloadProviderResult({
        url: 'https://public-result.example/image.png',
        provider: 'unknown-provider',
        fetchImpl: jest.fn(),
        lookup: publicLookup,
      }),
    ).rejects.toMatchObject({ code: 'RESULT_URL_REJECTED' });
  });

  test('keeps the pinned dispatcher alive until the response body is consumed', async () => {
    const png = await createPng();
    let dispatcher;
    let readCount = 0;
    const fetchImpl = jest.fn(async (_url, options) => {
      dispatcher = options.dispatcher;
      return {
        status: 200,
        ok: true,
        headers: new Headers({
          'content-type': 'image/png',
          'content-length': String(png.length),
        }),
        body: {
          getReader() {
            return {
              async read() {
                if (dispatcher.destroyed) {
                  throw new Error('dispatcher destroyed before body read');
                }
                readCount += 1;
                return readCount === 1 ? { done: false, value: png } : { done: true };
              },
            };
          },
        },
      };
    });

    const result = await downloadProviderResult({
      url: 'https://temporary-result-cdn.example/image.png',
      provider: 'apimart',
      fetchImpl,
      lookup: publicLookup,
    });

    expect(result.buffer).toEqual(png);
    expect(dispatcher.destroyed).toBe(true);
  });

  test.each([
    ['https://localhost/image.png', 'localhost'],
    ['https://127.0.0.1/image.png', '127.0.0.1'],
    ['https://10.0.0.8/image.png', '10.0.0.8'],
    ['https://192.168.1.8/image.png', '192.168.1.8'],
    ['https://[::1]/image.png', '[::1]'],
    ['https://[fe80::1]/image.png', '[fe80::1]'],
  ])('rejects restricted provider result URL %s', async (url, expectedHostname) => {
    await expect(
      downloadProviderResult({
        url,
        provider: 'apimart',
        fetchImpl: jest.fn(),
        lookup: publicLookup,
      }),
    ).rejects.toMatchObject({
      code: 'RESULT_URL_REJECTED',
      errorKind: 'result_url_rejected',
      hostname: expectedHostname,
    });
  });

  test('rejects a hostname when any resolved address is private', async () => {
    await expect(
      downloadProviderResult({
        url: 'https://mixed-dns.example/image.png',
        provider: 'apimart',
        fetchImpl: jest.fn(),
        lookup: jest.fn(async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.8', family: 4 },
        ]),
      }),
    ).rejects.toMatchObject({
      code: 'RESULT_URL_REJECTED',
      errorKind: 'result_url_rejected',
      hostname: 'mixed-dns.example',
    });
  });

  test('revalidates redirects and rejects a public URL redirecting to private IP', async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/image.png' } }),
    );

    await expect(
      downloadProviderResult({
        url: 'https://public-result.example/image.png',
        provider: 'apimart',
        fetchImpl,
        lookup: publicLookup,
      }),
    ).rejects.toMatchObject({
      code: 'RESULT_URL_REJECTED',
      errorKind: 'result_url_rejected',
      hostname: '127.0.0.1',
      redirectHostname: '127.0.0.1',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('rejects non-image content even when the HTTP response succeeds', async () => {
    await expect(
      downloadProviderResult({
        url: 'https://public-result.example/image.png',
        provider: 'apimart',
        fetchImpl: jest.fn(
          async () =>
            new Response('<html>not an image</html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            }),
        ),
        lookup: publicLookup,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESULT_IMAGE', errorKind: 'invalid_image' });
  });

  test('rejects image content with invalid magic bytes', async () => {
    await expect(
      downloadProviderResult({
        url: 'https://public-result.example/image.png',
        provider: 'apimart',
        fetchImpl: jest.fn(
          async () =>
            new Response('not-image-bytes', {
              status: 200,
              headers: { 'content-type': 'image/png' },
            }),
        ),
        lookup: publicLookup,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESULT_IMAGE', errorKind: 'invalid_image' });
  });

  test('rejects a response larger than the configured byte limit', async () => {
    await expect(
      downloadProviderResult({
        url: 'https://public-result.example/large.png',
        provider: 'apimart',
        fetchImpl: jest.fn(
          async () =>
            new Response(Buffer.alloc(32), {
              status: 200,
              headers: { 'content-type': 'image/png', 'content-length': '32' },
            }),
        ),
        lookup: publicLookup,
        maxBytes: 16,
      }),
    ).rejects.toMatchObject({
      code: 'RESULT_DOWNLOAD_TOO_LARGE',
      errorKind: 'result_download_failed',
    });
  });

  test('classifies an aborted fetch as a result download timeout', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';

    await expect(
      downloadProviderResult({
        url: 'https://public-result.example/image.png',
        provider: 'apimart',
        fetchImpl: jest.fn(async () => {
          throw abortError;
        }),
        lookup: publicLookup,
      }),
    ).rejects.toMatchObject({
      code: 'RESULT_DOWNLOAD_TIMEOUT',
      errorKind: 'result_download_failed',
    });
  });

  test('propagates a worker lease abort into an in-flight output fetch', async () => {
    const controller = new AbortController();
    const fetchImpl = jest.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    );
    const pending = downloadProviderResult({
      url: 'https://public-result.example/image.png',
      provider: 'fal',
      fetchImpl,
      lookup: publicLookup,
      signal: controller.signal,
    });
    while (fetchImpl.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'RESULT_DOWNLOAD_TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('marks an expired signed result URL for task polling recovery', async () => {
    await expect(
      downloadProviderResult({
        url: 'https://public-result.example/expired.png',
        provider: 'apimart',
        fetchImpl: jest.fn(async () => new Response(null, { status: 403 })),
        lookup: publicLookup,
      }),
    ).rejects.toMatchObject({
      code: 'RESULT_URL_EXPIRED',
      errorKind: 'result_download_failed',
      retryMode: 'resume_polling',
    });
  });
});
