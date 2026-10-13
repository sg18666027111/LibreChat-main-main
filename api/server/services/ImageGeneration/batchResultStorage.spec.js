const mockUploadImageBuffer = jest.fn();
const mockFindFileById = jest.fn();
const mockUpdateFile = jest.fn();
const mockGetDownloadStream = jest.fn();
const { Readable } = require('stream');

jest.mock('~/server/services/Files/process', () => ({
  uploadImageBuffer: mockUploadImageBuffer,
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: () => ({ getDownloadStream: mockGetDownloadStream }),
}));

jest.mock('~/models', () => ({
  findFileById: mockFindFileById,
  updateFile: mockUpdateFile,
}));

const {
  BATCH_RESULT_FILE_TTL_MS,
  getAuthorizedBatchResultFile,
  getBatchResultBuffer,
  getBatchResultFilePath,
  getBatchResultStream,
  saveBatchResultImage,
  toClientBatchResultImage,
  toStoredBatchResultImage,
} = require('./batchResultStorage');

describe('batch result storage', () => {
  const task = {
    id: 'batch_0123456789abcdef0123456789abcdef',
    userId: 'user-1',
    tenantId: 'tenant-1',
    storageConfig: { fileStrategy: 'local' },
    items: [
      {
        itemId: 'item_0123456789abcdef0123456789abcdef',
        resultImage: { fileId: 'file-result-1' },
      },
    ],
  };

  beforeEach(() => {
    mockUploadImageBuffer.mockReset();
    mockFindFileById.mockReset();
    mockUpdateFile.mockReset();
    mockGetDownloadStream.mockReset();
  });

  test('writes normalized output through the configured storage adapter and persists only stable metadata', async () => {
    mockUploadImageBuffer.mockResolvedValue({
      filename: 'stored-image.png',
      type: 'image/png',
      bytes: 123,
      width: 800,
      height: 800,
      filepath: '/images/user-1/not-exposed.png',
      storageKey: 'private/not-exposed.png',
    });
    mockUpdateFile.mockResolvedValue({ file_id: expect.any(String) });

    const resultImage = await saveBatchResultImage({
      task,
      item: task.items[0],
      output: {
        buffer: Buffer.from('png'),
        mimeType: 'image/png',
        width: 800,
        height: 800,
      },
    });

    expect(mockUploadImageBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        context: 'image_generation',
        resize: false,
        metadata: expect.objectContaining({
          file_id: expect.any(String),
          width: 800,
          height: 800,
          filename: expect.stringContaining(`${task.id}-${task.items[0].itemId}`),
        }),
      }),
    );
    expect(resultImage).toEqual({
      fileId: expect.any(String),
      filename: 'stored-image.png',
      contentType: 'image/png',
      bytes: 123,
      width: 800,
      height: 800,
    });
    expect(mockUpdateFile).toHaveBeenCalledWith(
      expect.objectContaining({ file_id: expect.any(String), expiredAt: expect.any(Date) }),
    );
    expect(JSON.stringify(resultImage)).not.toMatch(/not-exposed|base64|signature/i);
  });

  test('retains stored files longer than the 24-hour successful task TTL', () => {
    expect(BATCH_RESULT_FILE_TTL_MS).toBe(26 * 60 * 60 * 1000);
  });

  test('keeps fileId and contentType when the stored mapping is applied twice (double-mapping regression)', () => {
    const rawSavedFile = {
      file_id: 'file-raw-1',
      filename: 'batch-main-image.png',
      type: 'image/png',
      bytes: 1024,
      width: 800,
      height: 800,
    };

    const storedOnce = toStoredBatchResultImage(rawSavedFile);
    expect(storedOnce).toMatchObject({ fileId: 'file-raw-1', contentType: 'image/png' });

    /**
     * 成功转移处会把 createClientImage 的 client 形态（fileId/contentType + url 字段）
     * 再次传入本函数。双重映射不得把 fileId/contentType 覆写为空，否则落库即产生
     * “succeeded 但 resultImage.fileId 为空”的坏成功态。
     */
    const clientShape = {
      ...storedOnce,
      url: '/api/batch/image-generation/b/items/i/file',
      proxiedUrl: '/api/batch/image-generation/b/items/i/file',
      downloadUrl: '/api/batch/image-generation/b/items/i/file?download=1',
    };
    const storedTwice = toStoredBatchResultImage(clientShape);
    expect(storedTwice).toEqual({
      fileId: 'file-raw-1',
      filename: 'batch-main-image.png',
      contentType: 'image/png',
      bytes: 1024,
      width: 800,
      height: 800,
    });
    expect(storedTwice.fileId).not.toBeNull();
  });

  test('creates a stable same-origin preview and download path from task identifiers', () => {
    const url = getBatchResultFilePath(task.id, task.items[0].itemId);
    expect(toClientBatchResultImage({ batchId: task.id, itemId: task.items[0].itemId, resultImage: { fileId: 'file-result-1' } })).toEqual(
      expect.objectContaining({ url, proxiedUrl: url, downloadUrl: `${url}?download=1` }),
    );
  });

  test('loads a result file only for the owning user and tenant', async () => {
    mockFindFileById.mockResolvedValue({ file_id: 'file-result-1' });

    await expect(
      getAuthorizedBatchResultFile({
        task,
        itemId: task.items[0].itemId,
        userId: 'user-1',
        tenantId: 'tenant-1',
      }),
    ).resolves.toEqual({ file_id: 'file-result-1' });
    expect(mockFindFileById).toHaveBeenCalledWith('file-result-1', {
      user: 'user-1',
      tenantId: 'tenant-1',
    });

    await expect(
      getAuthorizedBatchResultFile({
        task,
        itemId: task.items[0].itemId,
        userId: 'another-user',
        tenantId: 'tenant-1',
      }),
    ).resolves.toBeNull();
  });

  test('uses the same configured storage adapter for result reads', async () => {
    const stream = Readable.from([Buffer.from('image')]);
    mockGetDownloadStream.mockResolvedValue(stream);

    await expect(
      getBatchResultStream({ config: task.storageConfig }, { source: 'local', filepath: '/images/x.png' }),
    ).resolves.toBe(stream);
    expect(mockGetDownloadStream).toHaveBeenCalledWith(
      expect.any(Object),
      '/images/x.png',
    );
  });

  test('rejects a stored result when its magic bytes do not match the recorded MIME type', async () => {
    mockGetDownloadStream.mockResolvedValue(Readable.from([Buffer.from('not-an-image')]));

    await expect(
      getBatchResultBuffer(
        { config: task.storageConfig },
        { source: 'local', filepath: '/images/x.png', type: 'image/png' },
      ),
    ).rejects.toMatchObject({ code: 'RESULT_FILE_INVALID' });
  });
});
