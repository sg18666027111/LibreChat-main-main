jest.mock('@librechat/api', () => ({ deleteRagFile: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

const mockTmpBase = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'crud-traversal-'),
);

jest.mock('~/config/paths', () => {
  const path = require('path');
  return {
    publicPath: path.join(mockTmpBase, 'public'),
    uploads: path.join(mockTmpBase, 'uploads'),
  };
});

const fs = require('fs');
const path = require('path');
const { deleteLocalFile, saveLocalBuffer } = require('../crud');

describe('saveLocalBuffer path containment', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(mockTmpBase, 'public', 'images'), { recursive: true });
    fs.mkdirSync(path.join(mockTmpBase, 'uploads'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(mockTmpBase, { recursive: true, force: true });
  });

  test('rejects filenames with path traversal sequences', async () => {
    await expect(
      saveLocalBuffer({
        userId: 'user1',
        buffer: Buffer.from('malicious'),
        fileName: '../../../etc/passwd',
        basePath: 'uploads',
      }),
    ).rejects.toThrow('Path traversal detected in filename');
  });

  test('rejects prefix-collision traversal (startsWith bypass)', async () => {
    fs.mkdirSync(path.join(mockTmpBase, 'uploads', 'user10'), { recursive: true });
    await expect(
      saveLocalBuffer({
        userId: 'user1',
        buffer: Buffer.from('malicious'),
        fileName: '../user10/evil',
        basePath: 'uploads',
      }),
    ).rejects.toThrow('Path traversal detected in filename');
  });

  test('allows normal filenames', async () => {
    const result = await saveLocalBuffer({
      userId: 'user1',
      buffer: Buffer.from('safe content'),
      fileName: 'file-id__output.csv',
      basePath: 'uploads',
    });

    expect(result).toBe('/uploads/user1/file-id__output.csv');

    const filePath = path.join(mockTmpBase, 'uploads', 'user1', 'file-id__output.csv');
    expect(fs.existsSync(filePath)).toBe(true);
    fs.unlinkSync(filePath);
  });
});

describe('deleteLocalFile durability', () => {
  const req = {
    user: { id: 'user1' },
    config: {
      paths: {
        publicPath: path.join(mockTmpBase, 'public'),
        uploads: path.join(mockTmpBase, 'uploads'),
      },
    },
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('treats a missing file as already deleted', async () => {
    jest
      .spyOn(fs.promises, 'unlink')
      .mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    await expect(
      deleteLocalFile(req, { file_id: 'file-1', filepath: '/images/user1/missing.png' }),
    ).resolves.toBeUndefined();
  });

  test('propagates filesystem failures so metadata remains retryable', async () => {
    const unlink = jest
      .spyOn(fs.promises, 'unlink')
      .mockRejectedValueOnce(Object.assign(new Error('I/O failure'), { code: 'EIO' }))
      .mockResolvedValueOnce();

    await expect(
      deleteLocalFile(req, { file_id: 'file-1', filepath: '/images/user1/output.png' }),
    ).rejects.toMatchObject({ code: 'EIO' });
    await expect(
      deleteLocalFile(req, { file_id: 'file-1', filepath: '/images/user1/output.png' }),
    ).resolves.toBeUndefined();
    expect(unlink).toHaveBeenCalledTimes(2);
  });
});
