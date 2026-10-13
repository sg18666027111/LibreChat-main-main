import {
  createImageObjectUrlFromSource,
  downloadImageAsset,
  isHttpDownloadTarget,
  triggerDownload,
} from '../downloadFile';

describe('downloadFile utilities', () => {
  let clickSpy: jest.SpyInstance;
  let appendSpy: jest.SpyInstance;
  let removeSpy: jest.SpyInstance;
  let revokeSpy: jest.Mock;
  let createObjectURLSpy: jest.Mock;
  let appendedLink: HTMLAnchorElement | null;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined;
  let originalCreateObjectURL: typeof URL.createObjectURL | undefined;
  let originalFetch: typeof globalThis.fetch | undefined;

  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00]);
  const webpBytes = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

  function response(body: Blob | BlobPart, headers: Record<string, string>, status = 200) {
    const headerEntries = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const blob = body instanceof Blob ? body : new Blob([body], { type: headerEntries['content-type'] });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => headerEntries[name.toLowerCase()] ?? null,
      },
      blob: async () => blob,
    } as Response;
  }

  function imageResponse(contentType: string, body: Uint8Array, headers: Record<string, string> = {}) {
    return response(new Blob([body], { type: contentType }), { 'Content-Type': contentType, ...headers });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    appendedLink = null;
    originalFetch = globalThis.fetch;
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });
    clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation();
    appendSpy = jest.spyOn(document.body, 'appendChild').mockImplementation((node: Node) => {
      appendedLink = node as HTMLAnchorElement;
      return node;
    });
    removeSpy = jest.spyOn(document.body, 'removeChild').mockImplementation((node: Node) => node);
    revokeSpy = jest.fn();
    createObjectURLSpy = jest.fn(() => 'blob:image-download');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURLSpy,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeSpy,
    });
  });

  afterEach(() => {
    clickSpy.mockRestore();
    appendSpy.mockRestore();
    removeSpy.mockRestore();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectURL,
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('detects absolute http download targets', () => {
    expect(isHttpDownloadTarget('https://cdn.example.com/file.pdf')).toBe(true);
    expect(isHttpDownloadTarget('http://cdn.example.com/file.pdf')).toBe(true);
    expect(isHttpDownloadTarget('blob:https://app.example.com/id')).toBe(false);
    expect(isHttpDownloadTarget('/api/files/code/download/session/file')).toBe(false);
    expect(isHttpDownloadTarget(undefined)).toBe(false);
  });

  it('navigates http URLs in the same tab without revoking them', () => {
    triggerDownload('https://cdn.example.com/file.pdf?Policy=abc', 'file.pdf');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(appendedLink?.href).toBe('https://cdn.example.com/file.pdf?Policy=abc');
    expect(appendedLink?.download).toBe('file.pdf');
    expect(appendedLink?.target).toBe('');
    expect(appendedLink?.rel).toBe('');
    jest.runOnlyPendingTimers();
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('revokes blob URLs after the click', () => {
    triggerDownload('blob:https://app.example.com/download-id', 'file.pdf');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(appendedLink?.target).toBe('');
    expect(appendedLink?.rel).toBe('');
    expect(revokeSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(revokeSpy).toHaveBeenCalledWith('blob:https://app.example.com/download-id');
  });

  it.each([
    ['image/png', pngBytes, 'generated.png'],
    ['image/jpeg', jpegBytes, 'generated.jpg'],
    ['image/webp', webpBytes, 'generated.webp'],
    ['image/gif', gifBytes, 'generated.gif'],
  ])('downloads %s responses using the real image extension', async (contentType, bytes, filename) => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(imageResponse(contentType, bytes));

    await downloadImageAsset({ source: 'https://cdn.example.com/signed-result?x=1', filename: 'generated.json' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://cdn.example.com/signed-result?x=1',
      expect.objectContaining({ credentials: 'omit' }),
    );
    expect(createObjectURLSpy).toHaveBeenCalledWith(expect.objectContaining({ type: contentType }));
    expect(appendedLink?.href).toBe('blob:image-download');
    expect(appendedLink?.download).toBe(filename);
    jest.advanceTimersByTime(1000);
    expect(revokeSpy).toHaveBeenCalledWith('blob:image-download');
  });

  it('uses a safe Content-Disposition filename while keeping the MIME extension', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      imageResponse('image/png', pngBytes, {
        'Content-Disposition': 'attachment; filename="../unsafe result.json"',
      }),
    );

    await downloadImageAsset({ source: '/api/image-generation/result-image/token?download=1', filename: 'fallback.webp' });

    expect(appendedLink?.download).toBe('unsafe result.png');
  });

  it('follows supported JSON metadata once and downloads the resolved image instead of the JSON body', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response(JSON.stringify({ url: '/api/image-generation/result-image/actual' }), {
          'Content-Type': 'application/json',
        }),
      )
      .mockResolvedValueOnce(imageResponse('image/png', pngBytes));

    await downloadImageAsset({ source: '/api/image-generation/result-image/meta?download=1', filename: 'wrapped.json' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      '/api/image-generation/result-image/meta?download=1',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      '/api/image-generation/result-image/actual',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(createObjectURLSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png' }));
    expect(appendedLink?.download).toBe('wrapped.png');
  });

  it('does not create a download when JSON metadata has no image URL', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(JSON.stringify({ message: 'expired' }), { 'Content-Type': 'application/json' }),
    );

    await expect(
      downloadImageAsset({ source: '/api/image-generation/result-image/expired?download=1', filename: 'expired.png' }),
    ).rejects.toMatchObject({
      userMessage: '下载失败：服务器返回的不是图片文件。',
    });

    expect(clickSpy).not.toHaveBeenCalled();
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 429, 500, 502, 503, 504])(
    'does not create a download for HTTP %s image responses',
    async (status) => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(response(JSON.stringify({ message: 'failed' }), { 'Content-Type': 'application/json' }, status));

      await expect(
        downloadImageAsset({ source: `/api/image-generation/result-image/error-${status}`, filename: 'error.png' }),
      ).rejects.toMatchObject({
        status,
      });

      expect(clickSpy).not.toHaveBeenCalled();
      expect(createObjectURLSpy).not.toHaveBeenCalled();
    },
  );

  it('does not create a download for empty image blobs', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(imageResponse('image/png', new Uint8Array()));

    await expect(downloadImageAsset({ source: '/api/image-generation/result-image/empty', filename: 'empty.png' })).rejects.toMatchObject({
      userMessage: '下载失败：服务器返回的不是图片文件。',
    });

    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('does not create a download when the declared image body is actually JSON', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(JSON.stringify({ url: 'https://cdn.example.com/not-an-image' }), { 'Content-Type': 'image/png' }),
    );

    await expect(downloadImageAsset({ source: '/api/image-generation/result-image/mismatch', filename: 'mismatch.png' })).rejects.toMatchObject({
      userMessage: '下载失败：服务器返回的不是图片文件。',
    });

    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('creates display object URLs only from real image responses', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(imageResponse('image/png', pngBytes));

    const objectUrl = await createImageObjectUrlFromSource('/api/canvas/assets/asset-1/file');

    expect(objectUrl).toBe('blob:image-download');
    expect(createObjectURLSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png' }));
  });
});
