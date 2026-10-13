const { createAPIMartImageTiming } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { Readable } = require('stream');
const { BSON } = require('bson');

const mockUploadImageBuffer = jest.fn();
const mockGetStrategyFunctions = jest.fn();
const mockFindFileById = jest.fn();
const mockUpdateFile = jest.fn();
const mockDeleteFile = jest.fn();
const mockGetAppConfig = jest.fn();

jest.mock('~/server/services/Files/process', () => ({
  uploadImageBuffer: (...args) => mockUploadImageBuffer(...args),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: (...args) => mockGetStrategyFunctions(...args),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/models', () => ({
  findFileById: (...args) => mockFindFileById(...args),
  updateFile: (...args) => mockUpdateFile(...args),
  deleteFile: (...args) => mockDeleteFile(...args),
}));

function toDataUrl(buffer, mimeType = 'image/png') {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function createStorageReq(overrides = {}) {
  return {
    user: { id: 'user-1', tenantId: 'tenant-1' },
    config: { fileStrategy: 's3', paths: { publicPath: '/tmp/public', uploads: '/tmp/uploads' } },
    ...overrides,
  };
}

describe('APIMart img2 input storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUploadImageBuffer.mockImplementation(async ({ metadata }) => ({
      file_id: metadata.file_id,
      filename: metadata.filename,
      type: metadata.type,
      bytes: metadata.bytes,
      width: metadata.width,
      height: metadata.height,
      source: 's3',
      filepath: `https://cdn.example.test/images/user-1/${metadata.filename}`,
      storageKey: `r/us-east-2/images/user-1/${metadata.filename}`,
      storageRegion: 'us-east-2',
    }));
    mockUpdateFile.mockResolvedValue({ file_id: 'updated-file' });
    mockDeleteFile.mockResolvedValue({});
    mockGetStrategyFunctions.mockReturnValue({
      deleteFile: jest.fn(async () => undefined),
      getDownloadStream: jest.fn(async (_req, key) => {
        const content = key.includes('second') ? 'second-image' : 'first-image';
        return Readable.from([Buffer.from(content)]);
      }),
    });
    mockFindFileById.mockImplementation(async (fileId) => ({
      file_id: fileId,
      user: 'user-1',
      tenantId: 'tenant-1',
      source: 's3',
      filepath: `https://cdn.example.test/${fileId}.png`,
      storageKey: fileId.includes('2') ? 'second-key' : 'first-key',
      filename: `${fileId}.png`,
      type: 'image/png',
      bytes: 11,
      width: 1024,
      height: 1024,
    }));
    mockGetAppConfig.mockResolvedValue(createStorageReq().config);
  });

  test.each([
    ['PNG', 'image/png', Buffer.from('valid-png')],
    ['JPEG', 'image/jpeg', Buffer.from('valid-jpeg')],
    ['WebP', 'image/webp', Buffer.from('valid-webp')],
  ])('stages a valid %s data URL without changing its bytes', async (_label, mimeType, image) => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');

    const refs = await stageAPIMartImg2ImageInputs({
      req: createStorageReq(),
      requestId: `request-${mimeType}`,
      taskType: 'single-reference',
      imageInputs: [toDataUrl(image, mimeType)],
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual(expect.objectContaining({ mimeType, bytes: image.length }));
    expect(mockUploadImageBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          buffer: image,
          bytes: image.length,
          type: mimeType,
        }),
      }),
    );
  });

  test('accepts reasonable whitespace inside a valid base64 payload', async () => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');
    const image = Buffer.from('base64 whitespace remains supported');
    const base64 = image.toString('base64');
    const dataUrl = `data:image/png;base64,${base64.slice(0, 8)} \n\t${base64.slice(8)}`;

    await stageAPIMartImg2ImageInputs({
      req: createStorageReq(),
      requestId: 'request-base64-whitespace',
      taskType: 'single-reference',
      imageInputs: [dataUrl],
    });

    expect(mockUploadImageBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ buffer: image, bytes: image.length }),
      }),
    );
  });

  test('rejects pathological whitespace amplification before decoding', async () => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');

    await expect(
      stageAPIMartImg2ImageInputs({
        req: createStorageReq(),
        requestId: 'request-whitespace-amplification',
        taskType: 'single-reference',
        imageInputs: [`data:image/png;base64,A${' '.repeat(4_000_000)}AAA`],
      }),
    ).rejects.toMatchObject({
      code: 'APIMART_IMG2_INPUT_TOO_LARGE',
      statusCode: 413,
    });
    expect(mockUploadImageBuffer).not.toHaveBeenCalled();
  });

  test.each([
    ['uppercase MIME', 'IMAGE/PNG'],
    ['custom subtype MIME', 'image/vnd.example+preview'],
  ])('preserves the existing %s grammar', async (_label, mimeType) => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');

    const refs = await stageAPIMartImg2ImageInputs({
      req: createStorageReq(),
      requestId: `request-${mimeType}`,
      taskType: 'single-reference',
      imageInputs: [toDataUrl(Buffer.from('mime-contract'), mimeType)],
    });

    expect(refs[0]).toEqual(expect.objectContaining({ mimeType: mimeType.toLowerCase() }));
  });

  test('rejects a pathological oversized header as invalid before upload', async () => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');
    const oversizedHeader = `data:image/${'x'.repeat(10_000)};base64`;

    await expect(
      stageAPIMartImg2ImageInputs({
        req: createStorageReq(),
        requestId: 'request-oversized-header',
        taskType: 'single-reference',
        imageInputs: [`${oversizedHeader},AAAA`],
      }),
    ).rejects.toMatchObject({
      code: 'APIMART_IMG2_INPUT_INVALID',
      statusCode: 400,
    });
    expect(mockUploadImageBuffer).not.toHaveBeenCalled();
  });

  test.each([
    'not-a-data-url',
    'data:text/plain;base64,AAAA',
    'data:image/png;utf8,AAAA',
    'data:image/png;base64,',
    'data:image/png;base64,A',
    'data:image/png;base64,AA*A',
    'data:image/png;base64,AAAA=AAAA',
  ])('rejects malformed image data URL structure as invalid: %s', async (imageInput) => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');

    await expect(
      stageAPIMartImg2ImageInputs({
        req: createStorageReq(),
        requestId: 'request-invalid-data-url',
        taskType: 'single-reference',
        imageInputs: [imageInput],
      }),
    ).rejects.toMatchObject({
      code: 'APIMART_IMG2_INPUT_INVALID',
      statusCode: 400,
    });
    expect(mockUploadImageBuffer).not.toHaveBeenCalled();
  });

  test('rejects a whitespace-only base64 payload as empty', async () => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');

    await expect(
      stageAPIMartImg2ImageInputs({
        req: createStorageReq(),
        requestId: 'request-empty-data-url',
        taskType: 'single-reference',
        imageInputs: ['data:image/png;base64, \n\t'],
      }),
    ).rejects.toMatchObject({
      code: 'APIMART_IMG2_INPUT_EMPTY',
      statusCode: 400,
    });
    expect(mockUploadImageBuffer).not.toHaveBeenCalled();
  });

  test('rejects a data URL over the 25 MiB decoded staging limit before upload', async () => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');
    const encodedTwentyFiveMiBPlusOne = `${'A'.repeat(34_952_535)}=`;

    await expect(
      stageAPIMartImg2ImageInputs({
        req: createStorageReq(),
        requestId: 'request-oversized-data-url',
        taskType: 'single-reference',
        imageInputs: [`data:image/png;base64,${encodedTwentyFiveMiBPlusOne}`],
      }),
    ).rejects.toMatchObject({
      code: 'APIMART_IMG2_INPUT_TOO_LARGE',
      statusCode: 413,
    });
    expect(mockUploadImageBuffer).not.toHaveBeenCalled();
  });

  test('accepts a data URL exactly at the 25 MiB decoded staging limit', async () => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');
    const encodedTwentyFiveMiB = `${'A'.repeat(34_952_534)}==`;

    const refs = await stageAPIMartImg2ImageInputs({
      req: createStorageReq(),
      requestId: 'request-max-sized-data-url',
      taskType: 'single-reference',
      imageInputs: [`data:image/png;base64,${encodedTwentyFiveMiB}`],
    });

    expect(refs[0]).toEqual(expect.objectContaining({ bytes: 25 * 1024 * 1024 }));
    expect(mockUploadImageBuffer).toHaveBeenCalledTimes(1);
  });

  test('accepts a 25 MiB data URL with standard 76-column CRLF folding', async () => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');
    const encodedTwentyFiveMiB = `${'A'.repeat(34_952_534)}==`;
    const foldedTwentyFiveMiB = encodedTwentyFiveMiB.replace(/.{76}/g, '$&\r\n');

    const refs = await stageAPIMartImg2ImageInputs({
      req: createStorageReq(),
      requestId: 'request-max-sized-folded-data-url',
      taskType: 'single-reference',
      imageInputs: [`data:image/png;base64,${foldedTwentyFiveMiB}`],
    });

    expect(refs[0]).toEqual(expect.objectContaining({ bytes: 25 * 1024 * 1024 }));
    expect(mockUploadImageBuffer).toHaveBeenCalledTimes(1);
  });

  test('rejects a large malformed base64 payload without staging it', async () => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');
    const malformedPayload = `${'A'.repeat(4_000_000)}*`;

    await expect(
      stageAPIMartImg2ImageInputs({
        req: createStorageReq(),
        requestId: 'request-pathological-data-url',
        taskType: 'single-reference',
        imageInputs: [`data:image/png;base64,${malformedPayload}`],
      }),
    ).rejects.toMatchObject({
      code: 'APIMART_IMG2_INPUT_INVALID',
      statusCode: 400,
    });
    expect(mockUploadImageBuffer).not.toHaveBeenCalled();
  });

  test('stages oversized multi-reference images as lightweight job references', async () => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');
    const largeImage = Buffer.alloc(4_700_000, 0xab);
    const imageInputs = [toDataUrl(largeImage), toDataUrl(largeImage), toDataUrl(largeImage)];
    const legacyInlinePayload = { payload: { imageInputs } };

    const refs = await stageAPIMartImg2ImageInputs({
      req: createStorageReq(),
      requestId: 'request-large-inputs',
      taskType: 'multi-reference',
      imageInputs,
      metadata: imageInputs.map((_image, index) => ({
        index,
        width: 1024,
        height: 1024,
      })),
    });

    expect(BSON.calculateObjectSize(legacyInlinePayload)).toBeGreaterThan(17 * 1024 * 1024);
    expect(refs).toHaveLength(3);
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'file', index: 0, fileId: expect.any(String) }),
        expect.objectContaining({ kind: 'file', index: 1, fileId: expect.any(String) }),
        expect.objectContaining({ kind: 'file', index: 2, fileId: expect.any(String) }),
      ]),
    );
    const stagedPayload = { payload: { imageInputRefs: refs } };
    expect(() => BSON.serialize(stagedPayload)).not.toThrow();
    expect(BSON.calculateObjectSize(stagedPayload)).toBeLessThan(1024 * 1024);
    expect(JSON.stringify(stagedPayload)).not.toContain('data:image');
    expect(mockUploadImageBuffer).toHaveBeenCalledTimes(3);
    expect(mockUploadImageBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ expiredAt: expect.any(Date) }),
      }),
    );
    expect(mockUpdateFile).not.toHaveBeenCalled();
  });

  test('resolves staged image references back to ordered provider imageInputs', async () => {
    const logs = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { resolveAPIMartImg2JobPayload } = require('./apimartImg2InputStorage');

    const payload = await resolveAPIMartImg2JobPayload({
      timing: createAPIMartImageTiming({
        taskId: 'private-task',
        log: (message) => logger.info(message),
      }),
      userId: 'user-1',
      tenantId: 'tenant-1',
      payload: {
        prompt: 'use both images',
        imageInputRefs: [
          { kind: 'file', index: 1, fileId: 'input-file-2', mimeType: 'image/png' },
          { kind: 'file', index: 0, fileId: 'input-file-1', mimeType: 'image/png' },
        ],
      },
    });

    expect(payload).toEqual(
      expect.objectContaining({
        prompt: 'use both images',
        imageInputs: [
          toDataUrl(Buffer.from('first-image')),
          toDataUrl(Buffer.from('second-image')),
        ],
      }),
    );
    expect(payload.imageInputRefs).toBeUndefined();
    expect(mockFindFileById).toHaveBeenCalledTimes(2);
    const timings = logs.mock.calls
      .map(([message]) => message)
      .filter((message) => message.includes(' timing '))
      .map((message) => JSON.parse(message.split(' timing ')[1]));
    expect(timings).toEqual([
      expect.objectContaining({
        stage: 'reference_read',
        outcome: 'success',
        imageIndex: 0,
        imageCount: 2,
        bytes: 11,
      }),
      expect.objectContaining({
        stage: 'reference_read',
        outcome: 'success',
        imageIndex: 1,
        imageCount: 2,
        bytes: 12,
      }),
    ]);
    expect(JSON.stringify(timings)).not.toMatch(
      /user-1|tenant-1|input-file|use both|base64|https:/,
    );
    logs.mockRestore();
  });

  test('shared egress input resolution does not emit APIMart GPT timing events', async () => {
    const { resolveImageEgressInputRefs } = require('./imageEgressInputStorage');
    const logs = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const payload = await resolveImageEgressInputRefs({
        userId: 'user-1',
        payload: { prompt: 'edit' },
        refs: [{ fileId: 'input-file-1', index: 0 }],
      });
      expect(payload.imageInputs).toEqual([toDataUrl(Buffer.from('first-image'))]);
      expect(
        logs.mock.calls.filter(([message]) => message.includes('APIMart timing ')),
      ).toHaveLength(0);
    } finally {
      logs.mockRestore();
    }
  });

  test('read timing preserves a storage failure even when the log sink fails', async () => {
    const { resolveAPIMartImg2JobPayload } = require('./apimartImg2InputStorage');
    const failure = new Error('private storage location and credential');
    mockFindFileById.mockRejectedValueOnce(failure);
    const logs = jest.spyOn(logger, 'info').mockImplementation(() => {
      throw new Error('log sink failed');
    });
    try {
      await expect(
        resolveAPIMartImg2JobPayload({
          timing: createAPIMartImageTiming({
            taskId: 'private-task',
            log: (message) => logger.info(message),
          }),
          userId: 'private-user',
          payload: {
            imageInputRefs: [{ kind: 'file', index: 0, fileId: 'private-file' }],
          },
        }),
      ).rejects.toBe(failure);
      const message = logs.mock.calls.find(([entry]) => entry.includes(' timing '))[0];
      expect(JSON.parse(message.split(' timing ')[1])).toMatchObject({
        stage: 'reference_read',
        outcome: 'failure',
        imageIndex: 0,
      });
      expect(message).not.toMatch(/private|credential/);
    } finally {
      logs.mockRestore();
    }
  });

  test('cleans already staged files if later staging fails before job creation', async () => {
    const { stageAPIMartImg2ImageInputs } = require('./apimartImg2InputStorage');
    const deleteFile = jest.fn(async () => undefined);
    mockGetStrategyFunctions.mockReturnValue({ deleteFile });
    mockUploadImageBuffer
      .mockResolvedValueOnce({
        file_id: 'input-file-1',
        source: 's3',
        filepath: 'https://cdn.example.test/input-file-1.png',
        storageKey: 'first-key',
        filename: 'input-file-1.png',
        type: 'image/png',
        bytes: 4,
      })
      .mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(
      stageAPIMartImg2ImageInputs({
        req: createStorageReq(),
        requestId: 'request-storage-failure',
        taskType: 'multi-reference',
        imageInputs: [toDataUrl(Buffer.from('one')), toDataUrl(Buffer.from('two'))],
      }),
    ).rejects.toMatchObject({
      code: 'APIMART_IMG2_INPUT_STORAGE_FAILED',
      statusCode: 502,
    });

    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith('input-file-1');
  });
});
