const mockStageInputs = jest.fn();
const mockResolvePayload = jest.fn();
const mockCleanupRefs = jest.fn();
const mockGetJob = jest.fn();
const mockUpdateFile = jest.fn();
const mockFindFileById = jest.fn();

jest.mock('./apimartImg2InputStorage', () => ({
  stageAPIMartImg2ImageInputs: mockStageInputs,
  resolveAPIMartImg2JobPayload: mockResolvePayload,
  cleanupAPIMartImg2InputRefs: mockCleanupRefs,
}));

jest.mock('~/models', () => ({
  findFileById: mockFindFileById,
  getImageGenerationJob: mockGetJob,
  updateFile: mockUpdateFile,
}));

const {
  cleanupImageEgressInputRefs,
  promoteImageEgressInputRefsToJobOwnership,
  resolveImageEgressInputRefs,
  stageImageEgressInputs,
} = require('./imageEgressInputStorage');

describe('image egress input storage lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindFileById.mockResolvedValue(null);
  });

  it('returns only provisional durable references after staging', async () => {
    mockStageInputs.mockResolvedValue([
      {
        kind: 'file',
        index: 0,
        fileId: 'file-1',
        mimeType: 'image/png',
        bytes: 128,
      },
    ]);

    const staged = await stageImageEgressInputs({
      req: { user: { id: 'user-1' } },
      requestId: 'request-1',
      taskType: 'single-image-edit',
      imageInputs: ['data:image/png;base64,c2VjcmV0'],
      metadata: [{ width: 1, height: 1 }],
    });

    expect(staged).toEqual({
      refs: [
        {
          kind: 'file',
          index: 0,
          fileId: 'file-1',
          mimeType: 'image/png',
          bytes: 128,
        },
      ],
      stagingBatchId: expect.any(String),
    });
    expect(JSON.stringify(staged)).not.toMatch(/base64|c2VjcmV0/);
  });

  it('promotes every referenced input to job-owned retention after durable job creation', async () => {
    const refs = [{ fileId: 'file-1' }, { fileId: 'file-2' }];
    mockGetJob.mockResolvedValue({
      internalTaskId: 'task-1',
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
      workerEligible: false,
      status: 'waiting',
      payload: { imageInputRefs: refs },
    });
    mockUpdateFile.mockResolvedValue({ file_id: 'updated' });

    await expect(
      promoteImageEgressInputRefsToJobOwnership({ internalTaskId: 'task-1', refs }),
    ).resolves.toEqual({ promotedFileIds: ['file-1', 'file-2'] });

    expect(mockUpdateFile.mock.calls.map(([input]) => input)).toEqual([
      { file_id: 'file-1', expiredAt: null },
      { file_id: 'file-2', expiredAt: null },
    ]);
  });

  it('refuses promotion when the durable job does not own the exact refs', async () => {
    mockGetJob.mockResolvedValue({
      internalTaskId: 'task-1',
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
      workerEligible: false,
      status: 'waiting',
      payload: { imageInputRefs: [{ fileId: 'another-file' }] },
    });

    await expect(
      promoteImageEgressInputRefsToJobOwnership({
        internalTaskId: 'task-1',
        refs: [{ fileId: 'file-1' }],
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_EGRESS_INPUT_OWNERSHIP_FAILED' });
    expect(mockUpdateFile).not.toHaveBeenCalled();
  });

  it('restores provisional TTL when promotion only clears part of a staged set', async () => {
    const refs = [{ fileId: 'file-1' }, { fileId: 'file-2' }];
    mockGetJob.mockResolvedValue({
      internalTaskId: 'task-1',
      asyncVersion: 3,
      workerFamily: 'image-egress-v1',
      workerEligible: false,
      status: 'waiting',
      payload: { imageInputRefs: refs },
    });
    mockUpdateFile
      .mockResolvedValueOnce({ file_id: 'file-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ file_id: 'file-1' });

    await expect(
      promoteImageEgressInputRefsToJobOwnership({ internalTaskId: 'task-1', refs }),
    ).rejects.toMatchObject({ code: 'IMAGE_EGRESS_INPUT_OWNERSHIP_FAILED' });

    expect(mockUpdateFile).toHaveBeenLastCalledWith({
      file_id: 'file-1',
      expiredAt: expect.any(Date),
    });
  });

  it('makes terminal inputs sweepable before best-effort deletion', async () => {
    const now = new Date('2026-08-08T10:00:00.000Z');
    mockUpdateFile.mockResolvedValue({ file_id: 'file-1' });
    mockCleanupRefs.mockResolvedValue(undefined);

    await cleanupImageEgressInputRefs({
      req: { user: { id: 'user-1' } },
      refs: [{ fileId: 'file-1' }],
      now,
    });

    expect(mockUpdateFile).toHaveBeenCalledWith({ file_id: 'file-1', expiredAt: now });
    expect(mockCleanupRefs).toHaveBeenCalledWith(
      expect.objectContaining({ refs: [{ fileId: 'file-1' }] }),
    );
  });

  it('rejects terminal cleanup until every promoted input has a confirmed expiry', async () => {
    const now = new Date('2026-08-08T10:00:00.000Z');
    mockUpdateFile.mockResolvedValue(null);
    mockFindFileById.mockResolvedValue({ file_id: 'file-1', expiredAt: null });

    await expect(
      cleanupImageEgressInputRefs({
        req: { user: { id: 'user-1' } },
        refs: [{ fileId: 'file-1' }],
        now,
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_EGRESS_INPUT_CLEANUP_NOT_DURABLE' });
    expect(mockCleanupRefs).not.toHaveBeenCalled();
  });

  it('treats an already-deleted terminal input as idempotently cleaned', async () => {
    const now = new Date('2026-08-08T10:00:00.000Z');
    mockUpdateFile.mockResolvedValue(null);
    mockFindFileById.mockResolvedValue(null);

    await expect(
      cleanupImageEgressInputRefs({
        userId: 'user-1',
        tenantId: 'tenant-1',
        refs: [{ fileId: 'file-1' }],
        now,
      }),
    ).resolves.toBeUndefined();
    expect(mockCleanupRefs).toHaveBeenCalled();
  });

  it('resolves job-owned refs only for the submit turn', async () => {
    mockResolvePayload.mockResolvedValue({
      prompt: 'edit',
      imageInputs: ['data:image/png;base64,aW1hZ2U='],
    });

    await expect(
      resolveImageEgressInputRefs({
        userId: 'user-1',
        tenantId: 'tenant-1',
        refs: [{ fileId: 'file-1', index: 0 }],
        payload: { prompt: 'edit' },
        storageConfig: { fileStrategy: 'local' },
      }),
    ).resolves.toEqual({ prompt: 'edit', imageInputs: ['data:image/png;base64,aW1hZ2U='] });
  });
});
