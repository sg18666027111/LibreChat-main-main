import type { Model, Types } from 'mongoose';
import { domainToASCII } from 'url';
import { SystemRoles } from 'librechat-data-provider';
import { createIndexesWithRetry } from '~/utils/retry';
import { createReportingSubjectId } from '~/schema/user';
import type {
  CreateUserDeletionJobInput,
  AcquireAdminMutationLockInput,
  IAdminMutationLock,
  IEmailBlocklist,
  IUser,
  IUserDeletionJob,
  SetUserDeletionStepInput,
  UpsertEmailBlockInput,
} from '~/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY_MS;
const UNSUPPORTED_EMAIL_CODE_POINTS = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

function hasUnsupportedEmailCharacter(value: string) {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      UNSUPPORTED_EMAIL_CODE_POINTS.has(codePoint)
    ) {
      return true;
    }
  }
  return false;
}

export function normalizeEmailForBlocklist(email: string) {
  const normalized = String(email || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return '';
  }
  if (hasUnsupportedEmailCharacter(normalized)) {
    throw new Error('Email contains unsupported characters');
  }
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === normalized.length - 1) {
    throw new Error('Email is invalid');
  }
  const localPart = normalized.slice(0, atIndex);
  const domainPart = normalized.slice(atIndex + 1);
  const asciiDomain = domainToASCII(domainPart);
  if (!asciiDomain) {
    throw new Error('Email domain is invalid');
  }
  return `${localPart}@${asciiDomain}`;
}

function asObjectId(mongoose: typeof import('mongoose'), value?: Types.ObjectId | string | null) {
  if (!value) {
    return null;
  }
  if (value instanceof mongoose.Types.ObjectId) {
    return value;
  }
  return new mongoose.Types.ObjectId(String(value));
}

function summarizeUpdate(result: { matchedCount?: number; modifiedCount?: number; n?: number }) {
  return {
    matchedCount: result.matchedCount ?? result.n ?? 0,
    modifiedCount: result.modifiedCount ?? 0,
  };
}

export function createAdminAccountMethods(mongoose: typeof import('mongoose')) {
  const User = mongoose.models.User as Model<IUser>;
  const UserDeletionJob = mongoose.models.UserDeletionJob as Model<IUserDeletionJob>;
  const EmailBlocklist = mongoose.models.EmailBlocklist as Model<IEmailBlocklist>;
  const AdminMutationLock = mongoose.models.AdminMutationLock as Model<IAdminMutationLock>;

  async function ensureAdminAccountStorage() {
    for (const model of [
      User,
      mongoose.models.AIUsageEvent,
      mongoose.models.UsageReport,
      mongoose.models.AdminAuditLog,
      UserDeletionJob,
      EmailBlocklist,
      AdminMutationLock,
    ].filter(Boolean)) {
      try {
        await model.createCollection();
      } catch (error) {
        const mongoError = error as { code?: number; codeName?: string };
        if (mongoError.code !== 48 && mongoError.codeName !== 'NamespaceExists') {
          throw error;
        }
      }
      await createIndexesWithRetry(model);
    }
  }

  async function runAdminAccountBackfill({
    now = new Date(),
    createReportingId = createReportingSubjectId,
  }: {
    now?: Date;
    createReportingId?: () => string;
  } = {}) {
    await ensureAdminAccountStorage();
    const summary = {
      activeStatus: { matchedCount: 0, modifiedCount: 0 },
      legacyDisabledStatus: { matchedCount: 0, modifiedCount: 0 },
      role: { matchedCount: 0, modifiedCount: 0 },
      isSuperAdmin: { matchedCount: 0, modifiedCount: 0 },
      sessionVersion: { matchedCount: 0, modifiedCount: 0 },
      reportingSubjectId: { matchedCount: 0, modifiedCount: 0 },
      indexesEnsured: true,
      completedAt: now,
    };

    summary.activeStatus = summarizeUpdate(
      await User.updateMany(
        { $or: [{ approvalStatus: null }, { approvalStatus: { $exists: false } }] },
        { $set: { approvalStatus: 'active', accountStatusUpdatedAt: now } },
      ),
    );
    summary.legacyDisabledStatus = summarizeUpdate(
      await User.updateMany(
        { approvalStatus: 'disabled' },
        { $set: { approvalStatus: 'suspended', accountStatusUpdatedAt: now } },
      ),
    );
    summary.role = summarizeUpdate(
      await User.updateMany(
        { $or: [{ role: null }, { role: { $exists: false } }] },
        { $set: { role: SystemRoles.USER } },
      ),
    );
    summary.isSuperAdmin = summarizeUpdate(
      await User.updateMany(
        { $or: [{ isSuperAdmin: null }, { isSuperAdmin: { $exists: false } }] },
        { $set: { isSuperAdmin: false } },
      ),
    );
    summary.sessionVersion = summarizeUpdate(
      await User.updateMany(
        { $or: [{ sessionVersion: null }, { sessionVersion: { $exists: false } }] },
        { $set: { sessionVersion: 0 } },
      ),
    );

    const missingReportingUsers = await User.find({
      $or: [{ reportingSubjectId: null }, { reportingSubjectId: { $exists: false } }],
    })
      .select('_id reportingSubjectId')
      .lean<IUser[]>();

    summary.reportingSubjectId.matchedCount = missingReportingUsers.length;
    for (const user of missingReportingUsers) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const result = await User.updateOne(
            {
              _id: user._id,
              $or: [{ reportingSubjectId: null }, { reportingSubjectId: { $exists: false } }],
            },
            { $set: { reportingSubjectId: createReportingId(), updatedAt: now } },
            { overwriteImmutable: true },
          );
          summary.reportingSubjectId.modifiedCount += result.modifiedCount ?? 0;
          break;
        } catch (error) {
          if ((error as { code?: number }).code !== 11000 || attempt === 4) {
            throw error;
          }
        }
      }
    }

    return summary;
  }

  async function acquireAdminMutationLock({
    key,
    ownerId,
    leaseMs = 10_000,
    now = new Date(),
  }: AcquireAdminMutationLockInput) {
    const lockKey = String(key || '').trim();
    const lockOwnerId = String(ownerId || '').trim();
    if (!lockKey || !lockOwnerId) {
      throw new Error('Lock key and ownerId are required');
    }

    const expiresAt = new Date(now.getTime() + Math.max(Number(leaseMs) || 0, 1000));
    const update = {
      $set: {
        ownerId: lockOwnerId,
        expiresAt,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    };

    const renewed = await AdminMutationLock.findOneAndUpdate(
      {
        _id: lockKey,
        $or: [{ ownerId: lockOwnerId }, { expiresAt: { $lte: now } }],
      },
      update,
      { new: true },
    ).lean<IAdminMutationLock>();
    if (renewed?.ownerId === lockOwnerId) {
      return true;
    }

    try {
      await AdminMutationLock.create({
        _id: lockKey,
        ownerId: lockOwnerId,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        return false;
      }
      throw error;
    }
  }

  async function releaseAdminMutationLock(key: string, ownerId: string) {
    const result = await AdminMutationLock.deleteOne({
      _id: String(key || '').trim(),
      ownerId: String(ownerId || '').trim(),
    });
    return (result.deletedCount ?? 0) > 0;
  }

  async function createUserDeletionJob(input: CreateUserDeletionJobInput) {
    return UserDeletionJob.findOneAndUpdate(
      {
        targetReportingSubjectId: input.targetReportingSubjectId,
        status: { $in: ['queued', 'running', 'failed'] },
      },
      {
        $setOnInsert: {
          targetReportingSubjectId: input.targetReportingSubjectId,
          targetUserId: asObjectId(mongoose, input.targetUserId),
          targetEmailNormalized: input.targetEmailNormalized,
          createdBy: asObjectId(mongoose, input.createdBy),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean<IUserDeletionJob>();
  }

  async function getUserDeletionJob(jobId: Types.ObjectId | string) {
    return UserDeletionJob.findById(asObjectId(mongoose, jobId)).lean<IUserDeletionJob>();
  }

  async function listUserDeletionJobs({ limit = 50 } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 50, 1), 100);
    return UserDeletionJob.find({})
      .sort({ updatedAt: -1 })
      .limit(safeLimit)
      .lean<IUserDeletionJob[]>();
  }

  async function setUserDeletionJobRunning(jobId: Types.ObjectId | string) {
    return UserDeletionJob.findByIdAndUpdate(
      asObjectId(mongoose, jobId),
      {
        $set: { status: 'running' },
        $unset: { lastError: '', expiresAt: '' },
        $inc: { attemptCount: 1 },
      },
      { new: true },
    ).lean<IUserDeletionJob>();
  }

  async function setUserDeletionJobStep(input: SetUserDeletionStepInput) {
    const now = new Date();
    const jobId = asObjectId(mongoose, input.jobId);
    const existing = await UserDeletionJob.findOne({
      _id: jobId,
      'stepResults.step': input.step,
    }).lean<IUserDeletionJob>();
    const stepResult = {
      step: input.step,
      status: input.status,
      count: input.count,
      message: input.message,
      updatedAt: now,
    };
    if (existing) {
      return UserDeletionJob.findOneAndUpdate(
        { _id: jobId, 'stepResults.step': input.step },
        {
          $set: {
            currentStep: input.step,
            'stepResults.$': stepResult,
          },
        },
        { new: true },
      ).lean<IUserDeletionJob>();
    }
    return UserDeletionJob.findByIdAndUpdate(
      jobId,
      {
        $set: { currentStep: input.step },
        $push: { stepResults: stepResult },
      },
      { new: true },
    ).lean<IUserDeletionJob>();
  }

  async function failUserDeletionJob(
    jobId: Types.ObjectId | string,
    error: unknown,
    step?: string,
  ) {
    const message = error instanceof Error ? error.message : String(error || '删除任务失败');
    return UserDeletionJob.findByIdAndUpdate(
      asObjectId(mongoose, jobId),
      {
        $set: {
          status: 'failed',
          currentStep: step,
          lastError: message,
          updatedAt: new Date(),
        },
        $unset: { expiresAt: '' },
      },
      { new: true },
    ).lean<IUserDeletionJob>();
  }

  async function completeUserDeletionJob(jobId: Types.ObjectId | string) {
    return UserDeletionJob.findByIdAndUpdate(
      asObjectId(mongoose, jobId),
      {
        $set: {
          status: 'completed',
          targetUserId: null,
          currentStep: 'completed',
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + RETENTION_MS),
        },
        $unset: { lastError: '' },
      },
      { new: true },
    ).lean<IUserDeletionJob>();
  }

  async function upsertEmailBlock(input: UpsertEmailBlockInput) {
    const emailNormalized = normalizeEmailForBlocklist(input.email);
    if (!emailNormalized) {
      throw new Error('Email is required');
    }
    return EmailBlocklist.findOneAndUpdate(
      { emailNormalized },
      {
        $set: {
          emailNormalized,
          emailOriginal: input.email,
          reportingSubjectId: input.reportingSubjectId,
          reason: input.reason,
          active: true,
          createdBy: asObjectId(mongoose, input.createdBy),
        },
        $unset: { unblockedAt: '', unblockedBy: '' },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean<IEmailBlocklist>();
  }

  async function isEmailBlocked(email: string) {
    let emailNormalized = '';
    try {
      emailNormalized = normalizeEmailForBlocklist(email);
    } catch {
      return true;
    }
    if (!emailNormalized) {
      return false;
    }
    return Boolean(await EmailBlocklist.exists({ emailNormalized, active: true }));
  }

  async function unblockEmail(email: string, actorId?: Types.ObjectId | string) {
    const emailNormalized = normalizeEmailForBlocklist(email);
    return EmailBlocklist.findOneAndUpdate(
      { emailNormalized, active: true },
      {
        $set: {
          active: false,
          unblockedAt: new Date(),
          unblockedBy: asObjectId(mongoose, actorId),
        },
      },
      { new: true },
    ).lean<IEmailBlocklist>();
  }

  async function listEmailBlocks({ includeInactive = false, limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 100, 1), 500);
    return EmailBlocklist.find(includeInactive ? {} : { active: true })
      .sort({ updatedAt: -1 })
      .limit(safeLimit)
      .lean<IEmailBlocklist[]>();
  }

  return {
    acquireAdminMutationLock,
    completeUserDeletionJob,
    createUserDeletionJob,
    ensureAdminAccountStorage,
    failUserDeletionJob,
    getUserDeletionJob,
    isEmailBlocked,
    listEmailBlocks,
    listUserDeletionJobs,
    normalizeEmailForBlocklist,
    releaseAdminMutationLock,
    runAdminAccountBackfill,
    setUserDeletionJobRunning,
    setUserDeletionJobStep,
    unblockEmail,
    upsertEmailBlock,
  };
}

export type AdminAccountMethods = ReturnType<typeof createAdminAccountMethods>;
