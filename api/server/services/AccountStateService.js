const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { SystemRoles } = require('librechat-data-provider');
const { comparePassword } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');
const { deleteAllUserSessions, updateUser } = db;

const ACCOUNT_STATUSES = {
  PENDING: 'pending',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  REJECTED: 'rejected',
  DELETING: 'deleting',
};

const LEGACY_STATUS_MAP = {
  disabled: ACCOUNT_STATUSES.SUSPENDED,
};

const LOGIN_BLOCKED_STATUSES = new Set([
  ACCOUNT_STATUSES.PENDING,
  ACCOUNT_STATUSES.SUSPENDED,
  ACCOUNT_STATUSES.REJECTED,
  ACCOUNT_STATUSES.DELETING,
]);

const BUSINESS_BLOCKED_STATUSES = new Set([
  ACCOUNT_STATUSES.PENDING,
  ACCOUNT_STATUSES.SUSPENDED,
  ACCOUNT_STATUSES.REJECTED,
  ACCOUNT_STATUSES.DELETING,
]);

const accountStatusBypassRules = [
  { method: 'POST', path: '/api/auth/logout' },
  { method: 'GET', path: '/api/user' },
  { method: 'GET', path: '/api/user/terms' },
];
const SUPER_ADMIN_LOCK_LEASE_MS = 10_000;
const SUPER_ADMIN_LOCK_WAIT_MS = 5_000;
const SUPER_ADMIN_LOCK_POLL_MS = 25;

function getUserId(user) {
  return user?._id?.toString?.() ?? user?.id?.toString?.() ?? '';
}

function normalizeAccountStatus(status) {
  return LEGACY_STATUS_MAP[status] || status || ACCOUNT_STATUSES.ACTIVE;
}

function getAccountStatusMessage(status) {
  const normalized = normalizeAccountStatus(status);
  if (normalized === ACCOUNT_STATUSES.PENDING) {
    return '账号已提交审核，请等待管理员开通';
  }
  if (normalized === ACCOUNT_STATUSES.SUSPENDED) {
    return '账号已停用，请联系管理员';
  }
  if (normalized === ACCOUNT_STATUSES.REJECTED) {
    return '账号审核未通过，请联系管理员';
  }
  if (normalized === ACCOUNT_STATUSES.DELETING) {
    return '账号正在彻底删除中，请联系管理员';
  }
  return '';
}

function parseSuperAdminEmails() {
  return String(process.env.SUPER_ADMIN_EMAILS || process.env.SUPER_ADMIN_EMAIL || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function isSuperAdminUser(user) {
  if (!user) {
    return false;
  }
  if (user.isSuperAdmin === true) {
    return true;
  }
  const envSuperAdmins = parseSuperAdminEmails();
  return (
    user.role === SystemRoles.ADMIN &&
    typeof user.email === 'string' &&
    envSuperAdmins.includes(user.email.toLowerCase())
  );
}

function isAdminUser(user) {
  return user?.role === SystemRoles.ADMIN || isSuperAdminUser(user);
}

function canBypassAccountStatus(req) {
  const requestPath = String(req.originalUrl || req.url || '').split('?')[0];
  const requestMethod = String(req.method || 'GET').toUpperCase();
  return accountStatusBypassRules.some(
    (rule) => rule.method === requestMethod && rule.path === requestPath,
  );
}

function getSuperAdminLockKey(target) {
  return `super-admin:${target?.tenantId ? `tenant:${target.tenantId}` : 'default'}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withSuperAdminMutationLock(target, operation) {
  return withAdminMutationLock(getSuperAdminLockKey(target), operation);
}

async function withAdminMutationLock(key, operation) {
  const ownerId = crypto.randomUUID();
  const deadline = Date.now() + SUPER_ADMIN_LOCK_WAIT_MS;
  let acquired = false;

  if (
    typeof db.acquireAdminMutationLock !== 'function' ||
    typeof db.releaseAdminMutationLock !== 'function'
  ) {
    const error = new Error('数据库级超级管理员操作锁不可用');
    error.status = 503;
    throw error;
  }

  while (Date.now() <= deadline) {
    acquired = await db.acquireAdminMutationLock({
      key,
      ownerId,
      leaseMs: SUPER_ADMIN_LOCK_LEASE_MS,
    });
    if (acquired) {
      break;
    }
    await sleep(SUPER_ADMIN_LOCK_POLL_MS);
  }

  if (!acquired) {
    const error = new Error('超级管理员操作正在进行中，请稍后重试');
    error.status = 409;
    throw error;
  }

  try {
    return await operation();
  } finally {
    try {
      await db.releaseAdminMutationLock(key, ownerId);
    } catch (error) {
      logger.warn('[AccountState] Failed to release super-admin mutation lock', {
        lockKey: key,
        error: error?.message,
      });
    }
  }
}

function getLoginBlock(user) {
  const approvalStatus = normalizeAccountStatus(user?.approvalStatus);
  if (!LOGIN_BLOCKED_STATUSES.has(approvalStatus)) {
    return null;
  }
  return {
    approvalStatus,
    message: getAccountStatusMessage(approvalStatus),
  };
}

function getBusinessBlock(req) {
  if (canBypassAccountStatus(req)) {
    return null;
  }

  const approvalStatus = normalizeAccountStatus(req.user?.approvalStatus);
  if (!BUSINESS_BLOCKED_STATUSES.has(approvalStatus)) {
    return null;
  }

  return {
    approvalStatus,
    message: getAccountStatusMessage(approvalStatus),
  };
}

async function enforceAccountStatus(req, res, next) {
  const block = getBusinessBlock(req);
  if (!block) {
    return next();
  }

  return res.status(403).json(block);
}

function requireSuperAdmin(actor) {
  if (!isSuperAdminUser(actor)) {
    const error = new Error('需要超级管理员权限');
    error.status = 403;
    throw error;
  }
}

function assertCanManageAccount(actor, target, { requireSuper = false, allowSelf = false } = {}) {
  if (!isAdminUser(actor)) {
    const error = new Error('需要管理员权限');
    error.status = 403;
    throw error;
  }

  const actorId = getUserId(actor);
  const targetId = getUserId(target);
  if (!allowSelf && actorId && targetId && actorId === targetId) {
    const error = new Error('不能对当前登录账号执行此操作');
    error.status = 400;
    throw error;
  }

  if (requireSuper) {
    requireSuperAdmin(actor);
  }

  const targetIsPrivileged = target?.role === SystemRoles.ADMIN || target?.isSuperAdmin === true;
  if (targetIsPrivileged && !isSuperAdminUser(actor) && actorId !== targetId) {
    const error = new Error('只有超级管理员可以管理管理员账号');
    error.status = 403;
    throw error;
  }
}

async function assertNotLastSuperAdmin(target) {
  if (!isSuperAdminUser(target)) {
    return;
  }

  const activeStatuses = [ACCOUNT_STATUSES.ACTIVE];
  const superAdminFilters = [{ role: SystemRoles.ADMIN, isSuperAdmin: true }];
  const envSuperAdmins = parseSuperAdminEmails();
  if (envSuperAdmins.length) {
    superAdminFilters.push({ role: SystemRoles.ADMIN, email: { $in: envSuperAdmins } });
  }

  const filter = {
    approvalStatus: { $in: activeStatuses },
    $or: superAdminFilters,
  };
  if (target?.tenantId) {
    filter.tenantId = target.tenantId;
  }

  const activeSuperAdminCount = await mongoose.models.User.countDocuments(filter);
  if (activeSuperAdminCount <= 1) {
    const error = new Error('不能操作最后一个超级管理员');
    error.status = 400;
    throw error;
  }
}

function toObjectId(id) {
  return new mongoose.Types.ObjectId(String(id));
}

async function getTargetUserOrThrow(userId, projection = '-password') {
  if (!mongoose.Types.ObjectId.isValid(String(userId))) {
    const error = new Error('用户 ID 格式不正确');
    error.status = 400;
    throw error;
  }
  const user = await mongoose.models.User.findById(toObjectId(userId)).select(projection);
  if (!user) {
    const error = new Error('用户不存在');
    error.status = 404;
    throw error;
  }
  return user;
}

async function recordAdminAuditLog({ actor, target, action, reason, metadata }) {
  try {
    const AdminAuditLog = mongoose.models.AdminAuditLog;
    await AdminAuditLog.create({
      tenantId: actor?.tenantId || target?.tenantId,
      actorId: getUserId(actor) ? toObjectId(getUserId(actor)) : undefined,
      actorEmail: actor?.email,
      targetUserId: getUserId(target) ? toObjectId(getUserId(target)) : undefined,
      targetEmail: target?.email,
      action,
      reason,
      metadata,
    });
  } catch (error) {
    logger.warn('[AccountState] Failed to write admin audit log', error);
  }
}

async function revokeUserSessions(userId) {
  await deleteAllUserSessions({ userId: String(userId) });
  await mongoose.models.User.updateOne(
    { _id: toObjectId(userId) },
    { $inc: { sessionVersion: 1 }, $set: { updatedAt: new Date() } },
  );
}

async function setAccountStatus({ actor, targetUserId, status, reason }) {
  const normalizedStatus = normalizeAccountStatus(status);
  if (!Object.values(ACCOUNT_STATUSES).includes(normalizedStatus)) {
    const error = new Error('账号状态不正确');
    error.status = 400;
    throw error;
  }

  const target = await getTargetUserOrThrow(targetUserId);
  assertCanManageAccount(actor, target, {
    requireSuper: target.role === SystemRoles.ADMIN || target.isSuperAdmin === true,
  });

  const applyStatusChange = async () => {
    if (normalizedStatus !== ACCOUNT_STATUSES.ACTIVE) {
      await assertNotLastSuperAdmin(target);
    }

    const update = {
      approvalStatus: normalizedStatus,
      approvalRejectedReason: normalizedStatus === ACCOUNT_STATUSES.REJECTED ? reason || '' : '',
      accountStatusUpdatedAt: new Date(),
    };
    if (getUserId(actor)) {
      update.accountStatusUpdatedBy = toObjectId(getUserId(actor));
    }
    const updated = await updateUser(getUserId(target), update);

    if (normalizedStatus !== ACCOUNT_STATUSES.ACTIVE) {
      await revokeUserSessions(getUserId(target));
    }

    await recordAdminAuditLog({
      actor,
      target,
      action: `account.${normalizedStatus}`,
      reason,
    });

    return updated;
  };

  if (isSuperAdminUser(target) && normalizedStatus !== ACCOUNT_STATUSES.ACTIVE) {
    return withSuperAdminMutationLock(target, applyStatusChange);
  }
  return applyStatusChange();
}

async function setAccountRole({ actor, targetUserId, adminRole, reason }) {
  const normalizedRole = String(adminRole || '').toLowerCase();
  if (!['user', 'admin', 'super_admin'].includes(normalizedRole)) {
    const error = new Error('账号角色不正确');
    error.status = 400;
    throw error;
  }

  const target = await getTargetUserOrThrow(targetUserId);
  assertCanManageAccount(actor, target, { requireSuper: true });

  const applyRoleChange = async () => {
    if (isSuperAdminUser(target) && normalizedRole !== 'super_admin') {
      await assertNotLastSuperAdmin(target);
    }

    const update = {
      role: normalizedRole === 'user' ? SystemRoles.USER : SystemRoles.ADMIN,
      isSuperAdmin: normalizedRole === 'super_admin',
      accountStatusUpdatedAt: new Date(),
    };
    if (getUserId(actor)) {
      update.accountStatusUpdatedBy = toObjectId(getUserId(actor));
    }

    const updated = await updateUser(getUserId(target), update);
    await revokeUserSessions(getUserId(target));
    await recordAdminAuditLog({
      actor,
      target,
      action: `account.role.${normalizedRole}`,
      reason,
    });
    return updated;
  };

  if (isSuperAdminUser(target) && normalizedRole !== 'super_admin') {
    return withSuperAdminMutationLock(target, applyRoleChange);
  }
  return applyRoleChange();
}

async function verifyCurrentPassword(actor, password) {
  if (!password) {
    return false;
  }
  const actorId = getUserId(actor);
  if (!actorId) {
    return false;
  }
  const fullActor = await mongoose.models.User.findById(toObjectId(actorId)).select('+password');
  if (!fullActor?.password) {
    return false;
  }
  return comparePassword(fullActor, password, { compare: bcrypt.compare });
}

function getAdminRole(user) {
  if (isSuperAdminUser(user)) {
    return 'super_admin';
  }
  if (user?.role === SystemRoles.ADMIN) {
    return 'admin';
  }
  return 'user';
}

function mapAccountUser(user, usageSummary) {
  const plain = typeof user?.toObject === 'function' ? user.toObject() : user;
  return {
    id: plain._id?.toString?.() ?? plain.id ?? '',
    name: plain.name ?? '',
    username: plain.username ?? '',
    email: plain.email ?? '',
    avatar: plain.avatar ?? '',
    role: plain.role ?? SystemRoles.USER,
    adminRole: getAdminRole(plain),
    isSuperAdmin: isSuperAdminUser(plain),
    provider: plain.provider ?? 'local',
    approvalStatus: normalizeAccountStatus(plain.approvalStatus),
    approvalRejectedReason: plain.approvalRejectedReason ?? '',
    accountStatusUpdatedAt:
      plain.accountStatusUpdatedAt?.toISOString?.() ?? plain.accountStatusUpdatedAt,
    canManageImagePromptTemplates:
      plain.permissions?.imagePromptTemplates?.manage === true || plain.role === SystemRoles.ADMIN,
    lastLoginAt: plain.lastLoginAt?.toISOString?.() ?? plain.lastLoginAt,
    createdAt: plain.createdAt?.toISOString?.() ?? plain.createdAt,
    updatedAt: plain.updatedAt?.toISOString?.() ?? plain.updatedAt,
    usage24h: usageSummary ?? {
      eventCount: 0,
      costCny: 0,
      inputTokens: 0,
      outputTokens: 0,
      imageCount: 0,
    },
  };
}

function buildAccountListFilter(query = {}) {
  const filters = [];
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 200) : '';
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    filters.push({ $or: [{ name: regex }, { email: regex }, { username: regex }] });
  }

  const status = normalizeAccountStatus(query.status);
  if (Object.values(ACCOUNT_STATUSES).includes(status) && query.status) {
    filters.push({
      approvalStatus: query.status === 'disabled' ? ACCOUNT_STATUSES.SUSPENDED : status,
    });
  }

  const role = String(query.role || '').toLowerCase();
  if (role === 'user') {
    filters.push({ role: { $ne: SystemRoles.ADMIN } });
  } else if (role === 'admin') {
    filters.push({ role: SystemRoles.ADMIN, isSuperAdmin: { $ne: true } });
  } else if (role === 'super_admin') {
    filters.push({ role: SystemRoles.ADMIN, isSuperAdmin: true });
  }

  if (filters.length === 0) {
    return {};
  }
  return filters.length === 1 ? filters[0] : { $and: filters };
}

async function getUsageSummaryByUser(userIds) {
  if (!userIds.length || !mongoose.models.AIUsageEvent) {
    return new Map();
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await mongoose.models.AIUsageEvent.aggregate([
    { $match: { userId: { $in: userIds.map(toObjectId) }, occurredAt: { $gte: since } } },
    {
      $group: {
        _id: '$userId',
        eventCount: { $sum: 1 },
        costCny: { $sum: '$costCny' },
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
        imageCount: { $sum: '$imageCount' },
      },
    },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), { ...row, _id: undefined }]));
}

async function listAccountUsers(query = {}) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 25, 1), 200);
  const offset = (page - 1) * pageSize;
  const filter = buildAccountListFilter(query);
  const [users, total] = await Promise.all([
    mongoose.models.User.find(filter)
      .select(
        '_id name username email avatar role provider permissions approvalStatus approvalRejectedReason accountStatusUpdatedAt isSuperAdmin lastLoginAt createdAt updatedAt',
      )
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(pageSize)
      .lean(),
    mongoose.models.User.countDocuments(filter),
  ]);
  const summaries = await getUsageSummaryByUser(users.map((user) => user._id.toString()));
  return {
    users: users.map((user) => mapAccountUser(user, summaries.get(user._id.toString()))),
    total,
    page,
    pageSize,
    limit: pageSize,
    offset,
  };
}

async function syncSuperAdminFlagsFromEnv() {
  const emails = parseSuperAdminEmails();
  if (!emails.length) {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  const result = await mongoose.models.User.updateMany(
    { email: { $in: emails } },
    { $set: { role: SystemRoles.ADMIN, isSuperAdmin: true } },
  );
  return {
    matchedCount: result.matchedCount ?? result.n ?? 0,
    modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
  };
}

module.exports = {
  ACCOUNT_STATUSES,
  assertNotLastSuperAdmin,
  BUSINESS_BLOCKED_STATUSES,
  LOGIN_BLOCKED_STATUSES,
  assertCanManageAccount,
  canBypassAccountStatus,
  enforceAccountStatus,
  getAccountStatusMessage,
  getBusinessBlock,
  getLoginBlock,
  getUserId,
  isAdminUser,
  isSuperAdminUser,
  listAccountUsers,
  mapAccountUser,
  normalizeAccountStatus,
  recordAdminAuditLog,
  requireSuperAdmin,
  revokeUserSessions,
  setAccountRole,
  setAccountStatus,
  syncSuperAdminFlagsFromEnv,
  verifyCurrentPassword,
  withSuperAdminMutationLock,
  withAdminMutationLock,
};
