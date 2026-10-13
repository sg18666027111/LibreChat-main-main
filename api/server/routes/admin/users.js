const express = require('express');
const { createAdminUsersHandlers } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');
const { createAdminPasswordReset } = require('~/server/services/AdminPasswordResetService');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);
const requireManageUsers = requireCapability(SystemCapabilities.MANAGE_USERS);
const {
  listAccountUsers,
  requireSuperAdmin,
  setAccountRole,
  setAccountStatus,
  syncSuperAdminFlagsFromEnv,
} = require('~/server/services/AccountStateService');
const {
  listUserDeletionJobs,
  requestUserPermanentDeletion,
  retryUserDeletionJob,
} = require('~/server/services/UserDeletionService');

const handlers = createAdminUsersHandlers({
  findUsers: db.findUsers,
  countUsers: db.countUsers,
  updateUser: db.updateUser,
  grantImagePromptTemplatePermissionLog: db.grantImagePromptTemplatePermissionLog,
  revokeImagePromptTemplatePermissionLog: db.revokeImagePromptTemplatePermissionLog,
  listImagePromptTemplatePermissionLogs: db.listImagePromptTemplatePermissionLogs,
  softDeleteRevokedImagePromptTemplatePermissionLog:
    db.softDeleteRevokedImagePromptTemplatePermissionLog,
  deleteUserById: db.deleteUserById,
  deleteConfig: db.deleteConfig,
  deleteAclEntries: db.deleteAclEntries,
});

router.use(requireJwtAuth, requireAdminAccess);

function handleAdminError(res, error) {
  const status = error?.status || 500;
  if (status >= 500) {
    return res.status(status).json({ message: '账号管理操作失败' });
  }
  return res.status(status).json({ message: error.message || '账号管理操作失败' });
}

router.get('/', requireReadUsers, async (req, res) => {
  try {
    const response = await listAccountUsers(req.query);
    res.json(response);
  } catch (error) {
    handleAdminError(res, error);
  }
});
router.get('/search', requireReadUsers, handlers.searchUsers);
router.get(
  '/prompt-template-permissions',
  requireReadUsers,
  handlers.listPromptTemplatePermissionLogs,
);
router.post('/sync-super-admins', requireManageUsers, async (req, res) => {
  try {
    requireSuperAdmin(req.user);
    const result = await syncSuperAdminFlagsFromEnv();
    res.json(result);
  } catch (error) {
    handleAdminError(res, error);
  }
});
router.get('/deletion-jobs', requireManageUsers, async (req, res) => {
  try {
    requireSuperAdmin(req.user);
    res.json({ jobs: await listUserDeletionJobs(req.query) });
  } catch (error) {
    handleAdminError(res, error);
  }
});
router.post('/deletion-jobs/:jobId/retry', requireManageUsers, async (req, res) => {
  try {
    requireSuperAdmin(req.user);
    const job = await retryUserDeletionJob({ actor: req.user, jobId: req.params.jobId });
    res.json({ job });
  } catch (error) {
    handleAdminError(res, error);
  }
});
router.get('/email-blocklist', requireManageUsers, async (req, res) => {
  try {
    requireSuperAdmin(req.user);
    res.json({ blocks: await db.listEmailBlocks(req.query) });
  } catch (error) {
    handleAdminError(res, error);
  }
});
router.post('/email-blocklist/unblock', requireManageUsers, async (req, res) => {
  try {
    requireSuperAdmin(req.user);
    const block = await db.unblockEmail(req.body?.email, req.user?._id || req.user?.id);
    if (!block) {
      return res.status(404).json({ message: '邮箱封禁记录不存在' });
    }
    res.json({ block });
  } catch (error) {
    handleAdminError(res, error);
  }
});
router.delete(
  '/prompt-template-permissions/:recordId',
  requireManageUsers,
  handlers.deletePromptTemplatePermissionLog,
);
router.patch('/:id/approval', requireManageUsers, async (req, res) => {
  try {
    const { approvalStatus, reason } = req.body ?? {};
    if (!['active', 'rejected', 'pending'].includes(approvalStatus)) {
      return res.status(400).json({ message: '账号审核状态不正确' });
    }
    const user = await setAccountStatus({
      actor: req.user,
      targetUserId: req.params.id,
      status: approvalStatus,
      reason,
    });
    res.json({ user });
  } catch (error) {
    handleAdminError(res, error);
  }
});
router.patch('/:id/status', requireManageUsers, async (req, res) => {
  try {
    const { status, reason } = req.body ?? {};
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ message: '账号状态不正确' });
    }
    const user = await setAccountStatus({
      actor: req.user,
      targetUserId: req.params.id,
      status,
      reason,
    });
    res.json({ user });
  } catch (error) {
    handleAdminError(res, error);
  }
});
router.patch('/:id/role', requireManageUsers, async (req, res) => {
  try {
    const { adminRole, reason } = req.body ?? {};
    const user = await setAccountRole({
      actor: req.user,
      targetUserId: req.params.id,
      adminRole,
      reason,
    });
    res.json({ user });
  } catch (error) {
    handleAdminError(res, error);
  }
});
router.post(
  '/:id/prompt-template-permission',
  requireManageUsers,
  handlers.grantPromptTemplatePermission,
);
router.delete(
  '/:id/prompt-template-permission',
  requireManageUsers,
  handlers.revokePromptTemplatePermission,
);
router.patch('/:id/permissions', requireManageUsers, handlers.updatePermissions);
router.post('/:id/password-reset-link', requireManageUsers, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await createAdminPasswordReset({
      actor: req.user,
      targetUserId: req.params.id,
    });
    res.json(result);
  } catch (error) {
    handleAdminError(res, error);
  }
});
router.post('/:id/permanent-delete', requireManageUsers, async (req, res) => {
  try {
    const job = await requestUserPermanentDeletion({
      actor: req.user,
      targetUserId: req.params.id,
      emailConfirmation: req.body?.emailConfirmation,
      currentPassword: req.body?.currentPassword,
    });
    res.status(job?.status === 'failed' ? 202 : 200).json({ job });
  } catch (error) {
    handleAdminError(res, error);
  }
});
// router.delete('/:id', requireManageUsers, handlers.deleteUser);

module.exports = router;
