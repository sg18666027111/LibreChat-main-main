const express = require('express');
const { createAdminUsersHandlers } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);

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

router.get('/', requireReadUsers, handlers.listPromptTemplatePermissionLogs);
router.delete('/:recordId', handlers.deletePromptTemplatePermissionLog);

module.exports = router;
