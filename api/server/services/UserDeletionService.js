const mongoose = require('mongoose');
const fs = require('fs/promises');
const path = require('path');
const { PrincipalType } = require('librechat-data-provider');
const db = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const { processDeleteRequest } = require('~/server/services/Files/process');
const {
  ACCOUNT_STATUSES,
  assertCanManageAccount,
  assertNotLastSuperAdmin,
  getUserId,
  isSuperAdminUser,
  requireSuperAdmin,
  revokeUserSessions,
  verifyCurrentPassword,
  withSuperAdminMutationLock,
} = require('~/server/services/AccountStateService');

const USER_DELETION_STEPS = [
  'mark_deleting',
  'revoke_auth',
  'anonymize_usage',
  'anonymize_reports',
  'delete_files',
  'delete_image_batches',
  'delete_chat',
  'delete_user_settings',
  'delete_user_record',
  'block_email',
];

const LEGACY_CANVAS_STEPS = ['delete_canvas_assets', 'delete_canvas_records'];

function toObjectId(id) {
  return new mongoose.Types.ObjectId(String(id));
}

function getDeleteCount(result) {
  return result?.deletedCount ?? result?.n ?? 0;
}

function getSucceededSteps(job) {
  return new Set(
    (job?.stepResults || [])
      .filter((step) => step.status === 'succeeded' || step.status === 'skipped')
      .map((step) => step.step),
  );
}

function createError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeEmail(email) {
  if (typeof db.normalizeEmailForBlocklist === 'function') {
    return db.normalizeEmailForBlocklist(email);
  }
  return String(email || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
}

async function deleteMany(modelName, filter) {
  const model = mongoose.models[modelName];
  if (!model) {
    return 0;
  }
  return getDeleteCount(await model.deleteMany(filter));
}

async function removeUserOwnedDirectory(rootPath, userId) {
  if (!rootPath || !userId) {
    return 0;
  }
  const root = path.resolve(rootPath);
  const target = path.resolve(root, String(userId));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw createError('目标目录路径无效', 500);
  }
  let existed = false;
  try {
    const stat = await fs.stat(target);
    existed = stat.isDirectory();
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  await fs.rm(target, { recursive: true, force: true, maxRetries: 2 });
  return existed ? 1 : 0;
}

async function deleteUserLocalFileDirectories({ targetUserId, paths: appPaths = {} }) {
  const imagesRoot =
    appPaths.imageOutput || (appPaths.publicPath ? path.join(appPaths.publicPath, 'images') : null);
  const roots = [appPaths.uploads, imagesRoot].filter(Boolean);
  const results = await Promise.all(
    roots.map((rootPath) => removeUserOwnedDirectory(rootPath, targetUserId)),
  );
  return results.reduce((sum, count) => sum + count, 0);
}

async function getTargetUser(targetUserId) {
  if (!mongoose.Types.ObjectId.isValid(String(targetUserId))) {
    throw createError('用户 ID 格式不正确', 400);
  }
  const target = await mongoose.models.User.findById(toObjectId(targetUserId)).select(
    '_id name email role isSuperAdmin approvalStatus reportingSubjectId tenantId sessionVersion',
  );
  if (!target) {
    throw createError('用户不存在', 404);
  }
  return target;
}

async function markAccountDeleting(targetUserId) {
  const result = await mongoose.models.User.updateOne(
    { _id: toObjectId(targetUserId) },
    {
      $set: {
        approvalStatus: ACCOUNT_STATUSES.DELETING,
        accountStatusUpdatedAt: new Date(),
      },
    },
  );
  return result.modifiedCount ?? result.nModified ?? 0;
}

async function revokeAuthForUser(targetUserId) {
  await revokeUserSessions(targetUserId);
  const objectId = toObjectId(targetUserId);
  const [tokenDeleted, sessionDeleted] = await Promise.all([
    deleteMany('Token', { userId: objectId }),
    deleteMany('Session', { $or: [{ user: objectId }, { userId: objectId }] }),
  ]);
  return tokenDeleted + sessionDeleted;
}

async function deleteStoredFilesForUser({ targetUserId, target }) {
  const File = mongoose.models.File;
  if (!File) {
    return 0;
  }
  const config = await getAppConfig({
    userId: String(targetUserId),
    tenantId: target?.tenantId,
  });
  const files = await File.find({ user: toObjectId(targetUserId) }).lean();
  if (!files.length) {
    await deleteUserLocalFileDirectories({ targetUserId, paths: config.paths });
    return 0;
  }
  const request = {
    body: {},
    config,
    user: {
      id: String(targetUserId),
      tenantId: target?.tenantId,
    },
  };
  const result = await processDeleteRequest({ req: request, files });
  if (result.failedFileIds?.length) {
    throw createError(`部分文件删除失败: ${result.failedFileIds.join(', ')}`, 500);
  }
  await deleteUserLocalFileDirectories({ targetUserId, paths: config.paths });
  return result.deletedFileIds?.length || 0;
}

async function deleteChatForUser(targetUserId) {
  const user = String(targetUserId);
  const results = await Promise.all([
    deleteMany('SharedLink', { user }),
    deleteMany('Message', { user }),
    deleteMany('Conversation', { user }),
    deleteMany('ConversationTag', { user }),
  ]);
  return results.reduce((sum, count) => sum + count, 0);
}

async function deleteUserSettingsForUser(targetUserId) {
  const objectId = toObjectId(targetUserId);
  const user = String(targetUserId);
  const results = await Promise.all([
    deleteMany('Preset', { user }),
    deleteMany('Key', { userId: objectId }),
    deleteMany('PluginAuth', { userId: user }),
    deleteMany('MemoryEntry', { userId: objectId }),
    deleteMany('Config', { principalType: PrincipalType.USER, principalId: user }),
    deleteMany('AclEntry', { principalType: PrincipalType.USER, principalId: user }),
    deleteMany('Balance', { user: objectId }),
    deleteMany('Transaction', { user: objectId }),
    deleteMany('Action', { user: objectId }),
    deleteMany('Assistant', { user: objectId }),
    deleteMany('Agent', { author: objectId }),
  ]);
  return results.reduce((sum, count) => sum + count, 0);
}

async function deleteUserRecord(targetUserId) {
  return getDeleteCount(await mongoose.models.User.deleteOne({ _id: toObjectId(targetUserId) }));
}

function createUserDeletionContext(job, target) {
  const targetUserId = job.targetUserId?.toString?.() ?? String(job.targetUserId || '');
  return {
    jobId: job._id,
    target,
    targetUserId,
    targetEmailNormalized: job.targetEmailNormalized,
    targetReportingSubjectId: job.targetReportingSubjectId,
  };
}

async function runStep(job, step, context) {
  await db.setUserDeletionJobStep({ jobId: job._id, step, status: 'pending' });
  let count = 0;
  if (step === 'mark_deleting') {
    count = await markAccountDeleting(context.targetUserId);
  } else if (step === 'revoke_auth') {
    count = await revokeAuthForUser(context.targetUserId);
  } else if (step === 'anonymize_usage') {
    const result = await db.anonymizeUsageForDeletedUser({
      userId: context.targetUserId,
      reportingSubjectId: context.targetReportingSubjectId,
    });
    count = result.modifiedCount ?? 0;
  } else if (step === 'anonymize_reports') {
    const result = await db.anonymizeUsageReportsForDeletedUser({
      userId: context.targetUserId,
      reportingSubjectId: context.targetReportingSubjectId,
    });
    count = result.modifiedCount ?? 0;
  } else if (step === 'delete_files') {
    count = await deleteStoredFilesForUser(context);
  } else if (step === 'delete_image_batches') {
    count = await deleteMany('ImageBatchTask', { userId: context.targetUserId });
  } else if (step === 'delete_chat') {
    count = await deleteChatForUser(context.targetUserId);
  } else if (step === 'delete_user_settings') {
    count = await deleteUserSettingsForUser(context.targetUserId);
  } else if (step === 'delete_user_record') {
    count = await deleteUserRecord(context.targetUserId);
  } else if (step === 'block_email') {
    if (context.targetEmailNormalized) {
      await db.upsertEmailBlock({
        email: context.targetEmailNormalized,
        reportingSubjectId: context.targetReportingSubjectId,
        reason: 'permanent_user_deletion',
      });
      count = 1;
    }
  }
  await db.setUserDeletionJobStep({ jobId: job._id, step, status: 'succeeded', count });
}

async function runUserDeletionJob(jobId) {
  let job = await db.getUserDeletionJob(jobId);
  if (!job) {
    throw createError('删除任务不存在', 404);
  }
  if (job.status === 'completed') {
    return job;
  }
  if (!job.targetUserId) {
    throw createError('删除任务缺少目标用户', 400);
  }

  job = await db.setUserDeletionJobRunning(job._id);
  for (const step of LEGACY_CANVAS_STEPS) {
    const result = job.stepResults?.find((item) => item.step === step);
    if (result?.status === 'succeeded' || result?.status === 'skipped') {
      continue;
    }
    if (result || job.currentStep === step) {
      await db.setUserDeletionJobStep({
        jobId: job._id,
        step,
        status: 'skipped',
        message: 'Canvas persistence retired after historical data cleanup',
      });
    }
  }
  const target = await mongoose.models.User.findById(toObjectId(job.targetUserId)).select(
    '_id email tenantId reportingSubjectId',
  );
  const context = createUserDeletionContext(job, target);
  const succeededSteps = getSucceededSteps(job);

  for (const step of USER_DELETION_STEPS) {
    if (succeededSteps.has(step)) {
      continue;
    }
    try {
      await runStep(job, step, context);
    } catch (error) {
      await db.setUserDeletionJobStep({
        jobId: job._id,
        step,
        status: 'failed',
        message: error?.message,
      });
      await db.failUserDeletionJob(job._id, error, step);
      throw error;
    }
  }

  return db.completeUserDeletionJob(job._id);
}

async function requestUserPermanentDeletion({
  actor,
  targetUserId,
  emailConfirmation,
  currentPassword,
}) {
  requireSuperAdmin(actor);
  if (!(await verifyCurrentPassword(actor, currentPassword))) {
    throw createError('当前超级管理员密码验证失败', 403);
  }

  const job = await withSuperAdminMutationLock({ tenantId: actor?.tenantId }, async () => {
    const target = await getTargetUser(targetUserId);
    assertCanManageAccount(actor, target, { requireSuper: isSuperAdminUser(target) });
    await assertNotLastSuperAdmin(target);

    if (emailConfirmation !== target.email) {
      throw createError('请输入目标账号完整邮箱以确认删除', 400);
    }

    const reportingSubjectId = target.reportingSubjectId;
    if (!reportingSubjectId) {
      throw createError('目标账号缺少 reportingSubjectId，请先执行账号迁移', 409);
    }

    await markAccountDeleting(target._id);
    await revokeAuthForUser(target._id);
    return db.createUserDeletionJob({
      targetReportingSubjectId: reportingSubjectId,
      targetUserId: target._id,
      targetEmailNormalized: normalizeEmail(target.email),
      createdBy: getUserId(actor),
    });
  });

  try {
    return await runUserDeletionJob(job._id);
  } catch (_error) {
    const failedJob = await db.getUserDeletionJob(job._id);
    return failedJob;
  }
}

async function retryUserDeletionJob({ actor, jobId }) {
  requireSuperAdmin(actor);
  return runUserDeletionJob(jobId);
}

async function listUserDeletionJobs(query) {
  return db.listUserDeletionJobs(query);
}

module.exports = {
  USER_DELETION_STEPS,
  deleteChatForUser,
  deleteStoredFilesForUser,
  deleteUserSettingsForUser,
  deleteUserLocalFileDirectories,
  listUserDeletionJobs,
  removeUserOwnedDirectory,
  requestUserPermanentDeletion,
  retryUserDeletionJob,
  runUserDeletionJob,
};
