import sharp from 'sharp';
import { createHash, randomBytes } from 'crypto';
import { crc32 } from 'node:zlib';
import { createAPIMartImageTiming } from './timing';
import { uploadAPIMartImages } from './apimart';

const asFetch = (request: jest.Mock): typeof fetch =>
  Object.assign(request, { preconnect: jest.fn() });

const input = `data:image/png;base64,${Buffer.from('reference').toString('base64')}`;
const options = {
  imageInputs: [input],
  apiKey: 'test-key',
  baseURL: 'https://api.apimart.ai/v1',
};

describe('APIMart reference uploads', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  test('losslessly optimizes an oversized staged PNG before uploading', async () => {
    const source = await sharp({
      create: { width: 2400, height: 2400, channels: 4, background: '#14517966' },
    })
      .withMetadata({ orientation: 6 })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(source.length).toBeGreaterThan(20 * 1024 * 1024);
    expect(source.length).toBeLessThanOrEqual(25 * 1024 * 1024);
    let uploaded = Buffer.alloc(0);
    global.fetch = asFetch(
      jest.fn(async (_url, request: RequestInit) => {
        const file = (request.body as FormData).get('file') as Blob;
        uploaded = Buffer.from(await file.arrayBuffer());
        return new Response(JSON.stringify({ url: 'https://example.com/optimized.png' }));
      }),
    );
    await expect(
      uploadAPIMartImages({
        ...options,
        imageInputs: [`data:image/png;base64,${source.toString('base64')}`],
      }),
    ).resolves.toEqual(['https://example.com/optimized.png']);
    expect(uploaded.length).toBeLessThanOrEqual(20 * 1024 * 1024);
    const hash = async (bytes: Buffer) =>
      createHash('sha256')
        .update(await sharp(bytes).raw().toBuffer())
        .digest('hex');
    expect(await hash(uploaded)).toBe(await hash(source));
    const metadata = await sharp(source).metadata();
    expect(await sharp(uploaded).metadata()).toMatchObject({
      width: metadata.width,
      height: metadata.height,
      hasAlpha: metadata.hasAlpha,
      orientation: metadata.orientation,
      exif: metadata.exif,
      icc: metadata.icc,
    });
  });

  test('rejects an incompressible PNG before uploading any reference with actionable guidance', async () => {
    const bytes = await sharp(randomBytes(2400 * 2400 * 4), {
      raw: { width: 2400, height: 2400, channels: 4 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    global.fetch = asFetch(jest.fn());
    await expect(
      uploadAPIMartImages({
        ...options,
        imageInputs: [input, `data:image/png;base64,${bytes.toString('base64')}`],
      }),
    ).rejects.toMatchObject({
      code: 'APIMART_INPUT_UPLOAD_TOO_LARGE',
      statusCode: 413,
      submittedToProvider: false,
      message: expect.stringContaining('20 MiB'),
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects inputs above staging capacity as oversized before uploading', async () => {
    global.fetch = asFetch(jest.fn());
    await expect(
      uploadAPIMartImages({
        ...options,
        imageInputs: [
          `data:image/png;base64,${Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64')}`,
        ],
      }),
    ).rejects.toMatchObject({ code: 'APIMART_INPUT_UPLOAD_TOO_LARGE', statusCode: 413 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('reports provider upload 413 as an actionable size error without retry', async () => {
    global.fetch = asFetch(jest.fn(async () => new Response('{}', { status: 413 })));
    await expect(uploadAPIMartImages(options)).rejects.toMatchObject({
      code: 'APIMART_INPUT_UPLOAD_TOO_LARGE',
      statusCode: 413,
      message: expect.stringContaining('20 MiB'),
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('preserves original bytes for references within the provider limit', async () => {
    const source = await sharp({
      create: { width: 16, height: 16, channels: 4, background: '#14517966' },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    let uploaded = Buffer.alloc(0);
    global.fetch = asFetch(
      jest.fn(async (_url, request: RequestInit) => {
        const file = (request.body as FormData).get('file') as Blob;
        uploaded = Buffer.from(await file.arrayBuffer());
        return new Response(JSON.stringify({ url: 'https://example.com/original.png' }));
      }),
    );
    await uploadAPIMartImages({
      ...options,
      imageInputs: [`data:image/png;base64,${source.toString('base64')}`],
    });
    expect(uploaded.equals(source)).toBe(true);
  });

  test('times the entire upload response body and preserves failure when logging fails', async () => {
    jest.useFakeTimers();
    const messages: string[] = [];
    const timing = createAPIMartImageTiming({
      log: (message) => {
        messages.push(message);
        throw new Error('logging failed');
      },
    });
    global.fetch = asFetch(
      jest.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                setTimeout(() => {
                  controller.enqueue(
                    new TextEncoder().encode('{"url":"https://example.test/result.png"}'),
                  );
                  controller.close();
                }, 400);
              },
            }),
          ),
      ),
    );
    const upload = uploadAPIMartImages({ ...options, timing });
    await jest.advanceTimersByTimeAsync(400);
    await expect(upload).resolves.toEqual(['https://example.test/result.png']);
    expect(JSON.parse(messages[0].split(' timing ')[1])).toMatchObject({
      stage: 'upload',
      durationMs: 400,
      outcome: 'success',
      bytes: 9,
    });
    global.fetch = asFetch(jest.fn(async () => new Response('{}', { status: 503 })));
    await expect(uploadAPIMartImages({ ...options, timing })).rejects.toMatchObject({
      code: 'APIMART_INPUT_UPLOAD_HTTP_ERROR',
    });
    expect(JSON.parse(messages[1].split(' timing ')[1])).toMatchObject({
      stage: 'upload',
      outcome: 'failure',
    });
  });

  test('preserves mixed URL and uploaded image ordering', async () => {
    global.fetch = asFetch(
      jest.fn(
        async () =>
          new Response(JSON.stringify({ url: 'https://upload.apimart.ai/f/image/reference.png' })),
      ),
    );
    await expect(
      uploadAPIMartImages({
        ...options,
        imageInputs: ['https://example.com/first.png', input, 'https://example.com/last.png'],
      }),
    ).resolves.toEqual([
      'https://example.com/first.png',
      'https://upload.apimart.ai/f/image/reference.png',
      'https://example.com/last.png',
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test.each(['invalid', 'data:image/png;base64,@@@', 'data:image/svg+xml;base64,YQ=='])(
    'validates every reference before any upload: %s',
    async (invalid) => {
      global.fetch = asFetch(jest.fn());
      await expect(
        uploadAPIMartImages({ ...options, imageInputs: [input, invalid] }),
      ).rejects.toMatchObject({ code: 'APIMART_INPUT_UPLOAD_INVALID_IMAGE' });
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  test('rejects images above the provider 20 MiB limit before sending bytes', async () => {
    global.fetch = asFetch(jest.fn());
    const oversized = `data:image/png;base64,${Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64')}`;
    await expect(
      uploadAPIMartImages({ ...options, imageInputs: [oversized] }),
    ).rejects.toMatchObject({
      code: 'APIMART_INPUT_UPLOAD_INVALID_IMAGE',
      submittedToProvider: false,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an expired upload budget is a pre-submission failure without automatic retry', async () => {
    jest.useFakeTimers();
    global.fetch = asFetch(
      jest.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const outcome = uploadAPIMartImages(options).catch((error: Error) => error);
    await jest.advanceTimersByTimeAsync(180000);
    expect(await outcome).toMatchObject({
      code: 'APIMART_INPUT_UPLOAD_TIMEOUT',
      submittedToProvider: false,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('already cancelled work makes no provider request', async () => {
    const controller = new AbortController();
    controller.abort();
    global.fetch = asFetch(jest.fn());
    await expect(
      uploadAPIMartImages({ ...options, signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'APIMART_INPUT_UPLOAD_ABORTED',
      submittedToProvider: false,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('preserves cancellation when oversized PNG decompression fails', async () => {
    const source = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#14517966' },
    })
      .png()
      .toBuffer();
    for (let offset = 8; offset < source.length; ) {
      const length = source.readUInt32BE(offset);
      if (source.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
        source.fill(0, offset + 8, offset + 8 + length);
        source.writeUInt32BE(
          crc32(source.subarray(offset + 4, offset + 8 + length)),
          offset + 8 + length,
        );
      }
      offset += length + 12;
    }
    const padding = Buffer.alloc(20 * 1024 * 1024 + 12);
    padding.writeUInt32BE(padding.length - 12, 0);
    padding.write('tEXt', 4);
    padding.writeUInt32BE(crc32(padding.subarray(4, -4)), padding.length - 4);
    const bytes = Buffer.concat([source.subarray(0, 33), padding, source.subarray(33)]);
    const controller = new AbortController();
    global.fetch = asFetch(jest.fn());
    const result = uploadAPIMartImages({
      ...options,
      imageInputs: [`data:image/png;base64,${bytes.toString('base64')}`],
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'APIMART_INPUT_UPLOAD_ABORTED' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    {},
    { url: 'http://127.0.0.1/private' },
    { url: 'https://user:secret@example.com/x' },
  ])('does not pass malformed provider upload responses to generation', async (body) => {
    global.fetch = asFetch(jest.fn(async () => new Response(JSON.stringify(body))));
    await expect(uploadAPIMartImages(options)).rejects.toMatchObject({
      code: 'APIMART_INPUT_UPLOAD_INVALID_RESPONSE',
      submittedToProvider: false,
    });
  });
});
