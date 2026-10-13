const mongoose = require('mongoose');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockProcessDeleteRequest = jest.fn(async ({ files }) => ({
  deletedFileIds: files.map((file) => file.file_id),
  failedFileIds: [],
}));
const mockComparePassword = jest.fn(() => true);

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  comparePassword: (...args) => mockComparePassword(...args),
}));
jest.mock('librechat-data-provider', () => ({
  FileSources: { local: 'local' },
  PrincipalType: { USER: 'user' },
  SystemRoles: { USER: 'USER', ADMIN: 'ADMIN' },
}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(async () => ({
    paths: { uploads: '/tmp/uploads', publicPath: '/tmp/public' },
  })),
}));
jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: (...args) => mockProcessDeleteRequest(...args),
}));
jest.mock('~/models', () => {
  const mongoose = require('mongoose');
  const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));
  const getCount = (result) => result?.deletedCount ?? result?.modifiedCount ?? 0;
  const setStep = async ({ jobId, step, status, count, message }) => {
    const Job = mongoose.models.UserDeletionJob;
    const job = await Job.findById(jobId);
    const existing = job.stepResults.find((item) => item.step === step);
    if (existing) {
      existing.status = status;
      existing.count = count;
      existing.message = message;
      existing.updatedAt = new Date();
    } else {
      job.stepResults.push({ step, status, count, message, updatedAt: new Date() });
    }
    job.currentStep = step;
    job.markModified('stepResults');
    await job.save();
    return job.toObject();
  };
  return {
    acquireAdminMutationLock: jest.fn(async () => true),
    deleteAllUserSessions: jest.fn(async ({ userId }) =>
      mongoose.models.Session.deleteMany({ user: toObjectId(userId) }),
    ),
    releaseAdminMutationLock: jest.fn(async () => true),
    updateUser: jest.fn(async (userId, update) =>
      mongoose.models.User.findByIdAndUpdate(userId, update, { new: true }).lean(),
    ),
    anonymizeUsageForDeletedUser: jest.fn(async ({ userId, reportingSubjectId }) =>
      mongoose.models.AIUsageEvent.updateMany(
        { $or: [{ userId: toObjectId(userId) }, { reportingSubjectId }] },
        {
          $set: { userId: null, anonymizedAt: new Date() },
          $unset: { 'metadata.userEmail': '', 'metadata.userName': '', 'metadata.email': '' },
        },
      ),
    ),
    anonymizeUsageReportsForDeletedUser: jest.fn(async ({ userId, reportingSubjectId }) => {
      const reports = await mongoose.models.UsageReport.find({
        byUser: {
          $elemMatch: {
            $or: [{ reportingSubjectId }, { userId: String(userId) }],
          },
        },
      });
      for (const report of reports) {
        for (const row of report.byUser) {
          if (row.reportingSubjectId === reportingSubjectId || row.userId === String(userId)) {
            row.userId = undefined;
            row.email = undefined;
            row.name = '已删除用户 #DELETE';
          }
        }
        report.markModified('byUser');
        await report.save();
      }
      return { modifiedCount: reports.length };
    }),
    completeUserDeletionJob: jest.fn(async (jobId) =>
      mongoose.models.UserDeletionJob.findByIdAndUpdate(
        jobId,
        {
          $set: {
            status: 'completed',
            targetUserId: null,
            currentStep: 'completed',
            completedAt: new Date(),
          },
          $unset: { lastError: '' },
        },
        { new: true },
      ).lean(),
    ),
    createUserDeletionJob: jest.fn(async (input) =>
      mongoose.models.UserDeletionJob.findOneAndUpdate(
        {
          targetReportingSubjectId: input.targetReportingSubjectId,
          status: { $in: ['queued', 'running', 'failed'] },
        },
        {
          $setOnInsert: {
            targetReportingSubjectId: input.targetReportingSubjectId,
            targetUserId: toObjectId(input.targetUserId),
            targetEmailNormalized: input.targetEmailNormalized,
            createdBy: input.createdBy ? toObjectId(input.createdBy) : undefined,
            status: 'queued',
            stepResults: [],
            attemptCount: 0,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean(),
    ),
    failUserDeletionJob: jest.fn(async (jobId, error, step) =>
      mongoose.models.UserDeletionJob.findByIdAndUpdate(
        jobId,
        { $set: { status: 'failed', currentStep: step, lastError: error.message } },
        { new: true },
      ).lean(),
    ),
    getUserDeletionJob: jest.fn(async (jobId) =>
      mongoose.models.UserDeletionJob.findById(jobId).lean(),
    ),
    isEmailBlocked: jest.fn(async (email) =>
      Boolean(
        await mongoose.models.EmailBlocklist.exists({
          emailNormalized: email.toLowerCase(),
          active: true,
        }),
      ),
    ),
    listUserDeletionJobs: jest.fn(async () => mongoose.models.UserDeletionJob.find({}).lean()),
    setUserDeletionJobRunning: jest.fn(async (jobId) =>
      mongoose.models.UserDeletionJob.findByIdAndUpdate(
        jobId,
        { $set: { status: 'running' }, $unset: { lastError: '' }, $inc: { attemptCount: 1 } },
        { new: true },
      ).lean(),
    ),
    setUserDeletionJobStep: jest.fn(setStep),
    upsertEmailBlock: jest.fn(async ({ email, reportingSubjectId }) =>
      mongoose.models.EmailBlocklist.findOneAndUpdate(
        { emailNormalized: email.toLowerCase() },
        { $set: { emailNormalized: email.toLowerCase(), reportingSubjectId, active: true } },
        { upsert: true, new: true },
      ).lean(),
    ),
    _getCount: getCount,
  };
});

let mongoServer;
let service;
let db;
let User;

const modelNames = [
  'User',
  'Token',
  'Session',
  'Conversation',
  'Message',
  'File',
  'Preset',
  'PluginAuth',
  'Key',
  'MemoryEntry',
  'Config',
  'ImageBatchTask',
  'SharedLink',
  'ConversationTag',
  'Balance',
  'Transaction',
  'Action',
  'Assistant',
  'Agent',
  'AIUsageEvent',
  'UsageReport',
  'UserDeletionJob',
  'EmailBlocklist',
];

function createLooseModel(name) {
  if (mongoose.models[name]) {
    return mongoose.models[name];
  }
  return mongoose.model(
    name,
    new mongoose.Schema({}, { strict: false, timestamps: true, minimize: false }),
  );
}

function objectId(hex) {
  return new mongoose.Types.ObjectId(hex);
}

async function seedUsers({ targetIsSuperAdmin = false } = {}) {
  const actor = await User.create({
    _id: objectId('64f100000000000000000001'),
    name: 'Root',
    email: 'root@example.com',
    provider: 'local',
    role: 'ADMIN',
    isSuperAdmin: true,
    approvalStatus: 'active',
    reportingSubjectId: 'usr_root',
    password: 'hashed-root-password',
    sessionVersion: 0,
  });
  const target = await User.create({
    _id: objectId('64f100000000000000000002'),
    name: 'Delete Me',
    email: 'delete@example.com',
    avatar: '/images/avatar.png',
    provider: 'local',
    role: targetIsSuperAdmin ? 'ADMIN' : 'USER',
    isSuperAdmin: targetIsSuperAdmin,
    approvalStatus: 'active',
    reportingSubjectId: 'usr_delete_random',
    password: 'hashed-target-password',
    sessionVersion: 0,
  });
  return { actor, target };
}

async function seedTargetData(target) {
  const targetId = target._id;
  const targetIdString = targetId.toString();
  await Promise.all([
    mongoose.models.Token.create({ userId: targetId, token: 'token' }),
    mongoose.models.Session.create({ user: targetId, refreshTokenHash: 'refresh' }),
    mongoose.models.Conversation.create({ conversationId: 'conv-delete', user: targetIdString }),
    mongoose.models.Message.create({
      messageId: 'msg-delete',
      conversationId: 'conv-delete',
      user: targetIdString,
    }),
    mongoose.models.File.create({
      user: targetId,
      file_id: 'file-delete',
      filepath: `/images/${targetIdString}/delete.png`,
      source: 'local',
    }),
    mongoose.models.Preset.create({ presetId: 'preset-delete', user: targetIdString }),
    mongoose.models.PluginAuth.create({ userId: targetIdString }),
    mongoose.models.Key.create({ userId: targetId }),
    mongoose.models.MemoryEntry.create({ userId: targetId }),
    mongoose.models.Config.create({ principalType: 'user', principalId: targetIdString }),
    mongoose.models.ImageBatchTask.create({ userId: targetIdString }),
  ]);

  await mongoose.models.AIUsageEvent.create({
    usageEventId: 'usage-delete',
    userId: targetId,
    reportingSubjectId: 'usr_delete_random',
    businessType: 'chat',
    provider: 'openai',
    model: 'gpt-5-mini',
    status: 'succeeded',
    costCny: 3,
    metadata: { userEmail: 'delete@example.com', safeBillingRef: 'safe' },
  });
  await mongoose.models.UsageReport.create({
    periodKey: '2026-07-31@Asia/Shanghai',
    byUser: [
      {
        userId: targetIdString,
        reportingSubjectId: 'usr_delete_random',
        name: 'Delete Me',
        email: 'delete@example.com',
        costCny: 3,
      },
    ],
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  for (const name of modelNames) {
    createLooseModel(name);
  }
  db = require('~/models');
  service = require('./UserDeletionService');
  User = mongoose.models.User;
});

afterEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})),
  );
  mockProcessDeleteRequest.mockReset();
  mockProcessDeleteRequest.mockResolvedValue({
    deletedFileIds: ['file-delete'],
    failedFileIds: [],
  });
  mockComparePassword.mockReset();
  mockComparePassword.mockReturnValue(true);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('UserDeletionService permanent deletion orchestration', () => {
  it('requires the current super administrator password before mutating the target account', async () => {
    const { actor, target } = await seedUsers();
    mockComparePassword.mockReturnValue(false);

    await expect(
      service.requestUserPermanentDeletion({
        actor,
        targetUserId: target._id,
        emailConfirmation: target.email,
        currentPassword: 'wrong-password',
      }),
    ).rejects.toMatchObject({ status: 403 });

    const after = await User.findById(target._id).lean();
    expect(after).toEqual(expect.objectContaining({ approvalStatus: 'active' }));
  });

  it('blocks deletion of the last active super administrator', async () => {
    const { actor, target } = await seedUsers({ targetIsSuperAdmin: true });
    await User.updateOne({ _id: actor._id }, { $set: { approvalStatus: 'suspended' } });
    actor.approvalStatus = 'suspended';

    await expect(
      service.requestUserPermanentDeletion({
        actor,
        targetUserId: target._id,
        emailConfirmation: target.email,
        currentPassword: 'root-password',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects non-super administrators and self deletion before mutating the target', async () => {
    const { actor, target } = await seedUsers();
    actor.isSuperAdmin = false;

    await expect(
      service.requestUserPermanentDeletion({
        actor,
        targetUserId: target._id,
        emailConfirmation: target.email,
        currentPassword: 'root-password',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await User.findById(target._id).lean()).approvalStatus).toBe('active');

    const freshActor = await User.findById('64f100000000000000000001').lean();
    await expect(
      service.requestUserPermanentDeletion({
        actor: freshActor,
        targetUserId: freshActor._id,
        emailConfirmation: freshActor.email,
        currentPassword: 'root-password',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await User.findById(freshActor._id).lean()).approvalStatus).toBe('active');
  });

  it('requires an exact email confirmation before locking the target', async () => {
    const { actor, target } = await seedUsers();

    await expect(
      service.requestUserPermanentDeletion({
        actor,
        targetUserId: target._id,
        emailConfirmation: 'someone-else@example.com',
        currentPassword: 'root-password',
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect((await User.findById(target._id).lean()).approvalStatus).toBe('active');
  });

  it('rejects case or whitespace changes in the email confirmation before locking the target', async () => {
    const { actor, target } = await seedUsers();

    await expect(
      service.requestUserPermanentDeletion({
        actor,
        targetUserId: target._id,
        emailConfirmation: ` ${target.email.toUpperCase()} `,
        currentPassword: 'root-password',
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect((await User.findById(target._id).lean()).approvalStatus).toBe('active');
  });

  it('deletes user-owned records without Canvas models or Storage and anonymizes history', async () => {
    const { actor, target } = await seedUsers();
    await seedTargetData(target);

    const job = await service.requestUserPermanentDeletion({
      actor,
      targetUserId: target._id,
      emailConfirmation: target.email,
      currentPassword: 'root-password',
    });

    expect(job.status).toBe('completed');
    expect(job.targetUserId).toBeNull();
    expect(await User.exists({ _id: target._id })).toBeNull();
    expect(await mongoose.models.Session.countDocuments({ user: target._id })).toBe(0);
    expect(await mongoose.models.Token.countDocuments({ userId: target._id })).toBe(0);
    expect(await mongoose.models.Conversation.countDocuments({ user: target._id.toString() })).toBe(
      0,
    );
    expect(await mongoose.models.Message.countDocuments({ user: target._id.toString() })).toBe(0);
    expect(
      await mongoose.models.ImageBatchTask.countDocuments({ userId: target._id.toString() }),
    ).toBe(0);
    expect(await mongoose.models.Preset.countDocuments({ user: target._id.toString() })).toBe(0);
    expect(await db.isEmailBlocked('delete@example.com')).toBe(true);
    expect(mockProcessDeleteRequest).toHaveBeenCalledWith(
      expect.objectContaining({ files: [expect.objectContaining({ file_id: 'file-delete' })] }),
    );
    expect(job.stepResults.map(({ step }) => step)).not.toContain('delete_canvas_assets');
    expect(job.stepResults.map(({ step }) => step)).not.toContain('delete_canvas_records');

    const event = await mongoose.models.AIUsageEvent.findOne({
      usageEventId: 'usage-delete',
    }).lean();
    expect(event.userId).toBeNull();
    expect(event.costCny).toBe(3);
    expect(event.metadata).toEqual({ safeBillingRef: 'safe' });
    const report = await mongoose.models.UsageReport.findOne({
      periodKey: '2026-07-31@Asia/Shanghai',
    }).lean();
    expect(report.byUser[0].name).toMatch(/^已删除用户 #/);
    expect(report.byUser[0].email).toBeUndefined();
  });

  it('removes only the target user-owned local directory', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'user-deletion-dirs-'));
    const targetDir = path.join(root, 'user-a');
    const otherDir = path.join(root, 'user-b');
    const otherFile = path.join(otherDir, 'keep.txt');
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.mkdir(otherDir, { recursive: true });
    await fsp.writeFile(path.join(targetDir, 'delete.txt'), 'delete');
    await fsp.writeFile(otherFile, 'keep');

    await expect(service.removeUserOwnedDirectory(root, 'user-a')).resolves.toBe(1);

    expect(fs.existsSync(targetDir)).toBe(false);
    expect(fs.existsSync(otherFile)).toBe(true);
    await expect(service.removeUserOwnedDirectory(root, '../user-b')).rejects.toMatchObject({
      status: 500,
    });
    expect(fs.existsSync(otherFile)).toBe(true);

    await fsp.rm(root, { recursive: true, force: true });
  });

  it('keeps the account locked when a deletion step fails and resumes on retry', async () => {
    const { actor, target } = await seedUsers();
    await seedTargetData(target);
    mockProcessDeleteRequest.mockRejectedValueOnce(new Error('storage offline'));

    const failedJob = await service.requestUserPermanentDeletion({
      actor,
      targetUserId: target._id,
      emailConfirmation: target.email,
      currentPassword: 'root-password',
    });

    expect(failedJob.status).toBe('failed');
    expect(failedJob.currentStep).toBe('delete_files');
    expect(failedJob.lastError).toBe('storage offline');
    const locked = await User.findById(target._id).lean();
    expect(locked.approvalStatus).toBe('deleting');
    expect(await mongoose.models.Session.countDocuments({ user: target._id })).toBe(0);

    mockProcessDeleteRequest.mockResolvedValue({
      deletedFileIds: ['file-delete'],
      failedFileIds: [],
    });
    const completed = await service.retryUserDeletionJob({ actor, jobId: failedJob._id });

    expect(completed.status).toBe('completed');
    expect(completed.lastError).toBeUndefined();
    await expect(service.runUserDeletionJob(completed._id)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it.each([
    ['delete_canvas_assets', 'failed'],
    ['delete_canvas_records', 'pending'],
  ])('skips retired %s %s result and completes the saved job', async (legacyStep, status) => {
    const { actor, target } = await seedUsers();
    await seedTargetData(target);
    const job = await db.createUserDeletionJob({
      targetReportingSubjectId: target.reportingSubjectId,
      targetUserId: target._id,
      targetEmailNormalized: target.email,
      createdBy: actor._id,
    });
    await mongoose.models.UserDeletionJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: status === 'failed' ? 'failed' : 'running',
          currentStep: legacyStep,
          lastError: status === 'failed' ? 'old canvas deletion failed' : undefined,
          stepResults: [
            { step: 'mark_deleting', status: 'succeeded', count: 7 },
            { step: legacyStep, status, message: 'old canvas deletion failed' },
          ],
        },
      },
    );

    const completed = await service.retryUserDeletionJob({ actor, jobId: job._id });

    expect(completed.status).toBe('completed');
    expect(completed.lastError).toBeUndefined();
    expect(completed.stepResults.find(({ step }) => step === legacyStep)).toEqual(
      expect.objectContaining({ status: 'skipped' }),
    );
    expect(completed.stepResults.find(({ step }) => step === 'mark_deleting')).toEqual(
      expect.objectContaining({ status: 'succeeded', count: 7 }),
    );
    expect(await User.exists({ _id: target._id })).toBeNull();
    expect(await db.isEmailBlocked(target.email)).toBe(true);
  });

  it('records a skipped result when only the retired current step was saved', async () => {
    const { actor, target } = await seedUsers();
    const job = await db.createUserDeletionJob({
      targetReportingSubjectId: target.reportingSubjectId,
      targetUserId: target._id,
      targetEmailNormalized: target.email,
      createdBy: actor._id,
    });
    await mongoose.models.UserDeletionJob.updateOne(
      { _id: job._id },
      { $set: { status: 'running', currentStep: 'delete_canvas_records' } },
    );

    const completed = await service.retryUserDeletionJob({ actor, jobId: job._id });

    expect(completed.status).toBe('completed');
    expect(completed.stepResults.find(({ step }) => step === 'delete_canvas_records')).toEqual(
      expect.objectContaining({ status: 'skipped' }),
    );
  });

  it('preserves a succeeded historical canvas step when resuming another failed step', async () => {
    const { actor, target } = await seedUsers();
    await seedTargetData(target);
    const job = await db.createUserDeletionJob({
      targetReportingSubjectId: target.reportingSubjectId,
      targetUserId: target._id,
      targetEmailNormalized: target.email,
      createdBy: actor._id,
    });
    await mongoose.models.UserDeletionJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'failed',
          currentStep: 'delete_files',
          stepResults: [
            { step: 'delete_canvas_assets', status: 'succeeded', count: 2 },
            { step: 'delete_files', status: 'failed', message: 'storage offline' },
          ],
        },
      },
    );

    const completed = await service.retryUserDeletionJob({ actor, jobId: job._id });

    expect(completed.status).toBe('completed');
    expect(completed.stepResults.find(({ step }) => step === 'delete_canvas_assets')).toEqual(
      expect.objectContaining({ status: 'succeeded', count: 2 }),
    );
    expect(completed.stepResults.find(({ step }) => step === 'delete_files')).toEqual(
      expect.objectContaining({ status: 'succeeded' }),
    );
  });
});
