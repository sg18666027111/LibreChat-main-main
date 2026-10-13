import sharp from 'sharp';
import { randomBytes, createHash } from 'crypto';
import { uploadFalImages } from './fal';

const asFetch = (request: jest.Mock): typeof fetch =>
  Object.assign(request, { preconnect: jest.fn() });

const data = `data:image/png;base64,${Buffer.from('test-image').toString('base64')}`;
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
const init = () =>
  json({
    upload_url: 'https://v3b.fal.media/upload/test',
    file_url: 'https://v3b.fal.media/files/test.png',
  });

describe('fal input uploads', () => {
  test.each(['initiate', 'upload'])(
    'reports exhausted balance during %s without exposing provider details',
    async (phase) => {
      const rejection = json(
        {
          detail:
            'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing',
        },
        403,
      );
      const request = jest.fn();
      if (phase === 'upload') request.mockResolvedValueOnce(init());
      request.mockResolvedValueOnce(rejection);
      await expect(
        uploadFalImages({
          imageInputs: [data, data],
          apiKey: 'secret',
          fetchImpl: asFetch(request),
        }),
      ).rejects.toMatchObject({
        code: 'FAL_BALANCE_EXHAUSTED',
        statusCode: 403,
        message: '当前生图服务余额不足，请联系管理员充值后重试。此任务尚未提交生成。',
      });
      expect(request).toHaveBeenCalledTimes(phase === 'upload' ? 2 : 1);
    },
  );

  test.each([
    [403, { detail: 'User is locked. Reason: Account suspended.' }],
    [403, { detail: 'Permission denied' }],
    [401, { detail: 'User is locked. Reason: Exhausted balance.' }],
    [403, { detail: null }],
  ])('keeps unrelated HTTP rejection distinct: %s %j', async (status, body) => {
    const request = jest.fn().mockResolvedValue(json(body, status));
    await expect(
      uploadFalImages({ imageInputs: [data], apiKey: 'secret', fetchImpl: asFetch(request) }),
    ).rejects.toMatchObject({
      code: 'FAL_INPUT_UPLOAD_HTTP_ERROR',
      statusCode: status,
    });
  });

  test('keeps a malformed 403 response generic instead of leaking its body', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(new Response('<html>private upstream details</html>', { status: 403 }));
    await expect(
      uploadFalImages({ imageInputs: [data], apiKey: 'secret', fetchImpl: asFetch(request) }),
    ).rejects.toMatchObject({
      code: 'FAL_INPUT_UPLOAD_HTTP_ERROR',
      statusCode: 403,
      message: 'Fal input image upload failed before generation submission.',
    });
  });

  test.each(['', 'dGVzdA', 'dGVzdA===', 'dGVz dA==', 'dGVzdA==\n', '!!!!'])(
    'rejects noncanonical base64 without uploading: %j',
    async (encoded) => {
      const request = jest.fn();
      await expect(
        uploadFalImages({
          imageInputs: [`data:image/png;base64,${encoded}`],
          apiKey: 'secret',
          fetchImpl: asFetch(request),
        }),
      ).rejects.toMatchObject({ code: 'FAL_INPUT_UPLOAD_INVALID_IMAGE' });
      expect(request).not.toHaveBeenCalled();
    },
  );

  test('uploads a valid PNG above 8 MiB unchanged instead of rejecting a staged input', async () => {
    const bytes = await sharp(randomBytes(2048 * 1536 * 3), {
      raw: { width: 2048, height: 1536, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bytes.length).toBeGreaterThan(8 * 1024 * 1024);
    let uploadedHash = '';
    const request = jest.fn(async (_url: string, options: RequestInit) => {
      if (options.method === 'POST') {
        return init();
      }
      uploadedHash = createHash('sha256')
        .update(options.body as Uint8Array)
        .digest('hex');
      return new Response('', { status: 200 });
    });
    await expect(
      uploadFalImages({
        imageInputs: [`data:image/png;base64,${bytes.toString('base64')}`],
        apiKey: 'secret',
        fetchImpl: asFetch(request),
      }),
    ).resolves.toEqual(['https://v3b.fal.media/files/test.png']);
    expect(uploadedHash).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  test('accepts the staging limit of 25 MiB without truncating upload bytes', async () => {
    let uploadedBytes = 0;
    const request = jest.fn(async (_url: string, options: RequestInit) => {
      if (options.method === 'POST') {
        return init();
      }
      uploadedBytes = (options.body as Uint8Array).byteLength;
      return new Response('', { status: 200 });
    });
    await expect(
      uploadFalImages({
        imageInputs: [`data:image/png;base64,${Buffer.alloc(26214400).toString('base64')}`],
        apiKey: 'secret',
        fetchImpl: asFetch(request),
      }),
    ).resolves.toEqual(['https://v3b.fal.media/files/test.png']);
    expect(uploadedBytes).toBe(26214400);
  });

  test('reports oversized input distinctly and rejects the batch before any upload', async () => {
    const request = jest.fn();
    await expect(
      uploadFalImages({
        imageInputs: [data, `data:image/png;base64,${Buffer.alloc(26214401).toString('base64')}`],
        apiKey: 'secret',
        fetchImpl: asFetch(request),
      }),
    ).rejects.toMatchObject({ code: 'FAL_INPUT_UPLOAD_TOO_LARGE', statusCode: 413 });
    expect(request).not.toHaveBeenCalled();
  });

  test('uploads bytes separately and returns URLs in image order without exposing the key to PUT', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(init())
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    await expect(
      uploadFalImages({ imageInputs: [data], apiKey: 'secret', fetchImpl: asFetch(request) }),
    ).resolves.toEqual(['https://v3b.fal.media/files/test.png']);
    expect(request.mock.calls[0][1].body).not.toContain('test-image');
    expect(request.mock.calls[1][1].body).toEqual(Buffer.from('test-image'));
    expect(request.mock.calls[1][1].headers).toEqual({ 'Content-Type': 'image/png' });
    expect(request.mock.calls[1][1].redirect).toBe('error');
  });

  test('keeps existing URL inputs without uploading', async () => {
    const request = jest.fn();
    await expect(
      uploadFalImages({
        imageInputs: ['https://v3b.fal.media/files/existing.png'],
        apiKey: 'secret',
        fetchImpl: asFetch(request),
      }),
    ).resolves.toEqual(['https://v3b.fal.media/files/existing.png']);
    expect(request).not.toHaveBeenCalled();
  });

  test.each([
    'http://127.0.0.1/x',
    'https://fal.media.evil.test/x',
    'https://user:pass@v3b.fal.media/x',
  ])('rejects unexpected upload destinations: %s', async (url) => {
    const request = jest
      .fn()
      .mockResolvedValue(
        json({ upload_url: url, file_url: 'https://v3b.fal.media/files/test.png' }),
      );
    await expect(
      uploadFalImages({ imageInputs: [data], apiKey: 'secret', fetchImpl: asFetch(request) }),
    ).rejects.toMatchObject({ code: 'FAL_INPUT_UPLOAD_INVALID_RESPONSE' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('does not publish a URL after an unsuccessful PUT', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(init())
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(
      uploadFalImages({ imageInputs: [data], apiKey: 'secret', fetchImpl: asFetch(request) }),
    ).rejects.toMatchObject({ code: 'FAL_INPUT_UPLOAD_HTTP_ERROR', statusCode: 503 });
  });

  test('stops before network calls when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = jest.fn();
    await expect(
      uploadFalImages({
        imageInputs: [data],
        apiKey: 'secret',
        signal: controller.signal,
        fetchImpl: asFetch(request),
      }),
    ).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
  });

  test('does not continue to PUT when ownership signal aborts after initiation', async () => {
    const controller = new AbortController();
    const request = jest.fn().mockImplementation(async () => {
      controller.abort();
      return init();
    });
    await expect(
      uploadFalImages({
        imageInputs: [data],
        apiKey: 'secret',
        signal: controller.signal,
        fetchImpl: asFetch(request),
      }),
    ).rejects.toBeDefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('validates all image inputs before uploading any', async () => {
    const request = jest.fn();
    await expect(
      uploadFalImages({
        imageInputs: [data, 'data:image/png;base64,%%%'],
        apiKey: 'secret',
        fetchImpl: asFetch(request),
      }),
    ).rejects.toMatchObject({ code: 'FAL_INPUT_UPLOAD_INVALID_IMAGE' });
    expect(request).not.toHaveBeenCalled();
  });
});
