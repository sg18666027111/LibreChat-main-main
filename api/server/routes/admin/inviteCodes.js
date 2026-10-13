const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const {
  APPROVAL_STATUSES,
  createInviteCodes,
  deleteInviteCode,
  disableInviteCode,
  listInviteCodes,
  listUsersByApprovalStatus,
  setUserApprovalStatus,
} = require('~/server/services/InviteCodeService');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', async (_req, res) => {
  const inviteCodes = await listInviteCodes();
  res.json({ inviteCodes });
});

router.post('/', async (req, res) => {
  const { count = 1, maxUses = 1, expiresAt = null, note = '' } = req.body ?? {};
  const inviteCodes = await createInviteCodes({
    count,
    maxUses,
    expiresAt,
    note,
    createdBy: req.user?._id || req.user?.id || null,
  });
  res.status(201).json({ inviteCodes });
});

router.patch('/:id/disable', async (req, res) => {
  const inviteCode = await disableInviteCode(req.params.id);
  if (!inviteCode) {
    return res.status(404).json({ message: '邀请码不存在。' });
  }
  res.json({ inviteCode });
});

router.delete('/:id', async (req, res) => {
  const result = await deleteInviteCode(req.params.id);
  if (!result.deletedCount) {
    return res.status(404).json({ message: '邀请码不存在。' });
  }
  res.json({ ok: true });
});

router.get('/users/pending', async (_req, res) => {
  const users = await listUsersByApprovalStatus(APPROVAL_STATUSES.PENDING);
  res.json({ users });
});

router.patch('/users/:id/approval', async (req, res) => {
  const { approvalStatus } = req.body ?? {};
  if (!Object.values(APPROVAL_STATUSES).includes(approvalStatus)) {
    return res.status(400).json({ message: '账号审核状态不正确。' });
  }

  const user = await setUserApprovalStatus(req.params.id, approvalStatus);
  if (!user) {
    return res.status(404).json({ message: '用户不存在。' });
  }

  res.json({
    user: {
      _id: user._id?.toString?.() ?? user._id,
      email: user.email,
      name: user.name,
      username: user.username,
      role: user.role,
      approvalStatus: user.approvalStatus,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  });
});

module.exports = router;
