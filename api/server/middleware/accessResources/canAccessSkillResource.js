const { ResourceType, PermissionBits } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');
const { canAccessResource } = require('./canAccessResource');
const { getSkillById } = require('~/models');

/**
 * Skill-specific middleware factory that checks skill access permissions.
 * Wraps the generic `canAccessResource` with the SKILL resource type and
 * `getSkillById` as the ID resolver.
 *
 * @param {Object} options
 * @param {number} options.requiredPermission - Permission bit required (1=view, 2=edit, 4=delete, 8=share)
 * @param {string} [options.resourceIdParam='id'] - Route parameter name holding the skill id
 * @returns {Function} Express middleware
 */
const canAccessSkillResource = (options) => {
  const { requiredPermission, resourceIdParam = 'id' } = options || {};

  if (!requiredPermission || typeof requiredPermission !== 'number') {
    throw new Error('canAccessSkillResource: requiredPermission is required and must be a number');
  }

  const fallback = canAccessResource({
    resourceType: ResourceType.SKILL,
    requiredPermission,
    resourceIdParam,
    idResolver: getSkillById,
  });

  return async (req, res, next) => {
    try {
      const rawResourceId = req.params[resourceIdParam];
      if (
        requiredPermission === PermissionBits.VIEW &&
        rawResourceId &&
        req.user?.id
      ) {
        const skill = await getSkillById(rawResourceId);
        if (skill?.visibility === 'global') {
          req.resourceAccess = {
            resourceType: ResourceType.SKILL,
            resourceId: skill._id,
            customResourceId: rawResourceId,
            permission: requiredPermission,
            userId: req.user.id,
            resourceInfo: skill,
          };
          return next();
        }
      }
    } catch (error) {
      logger.warn(`[canAccessSkillResource] Global skill access precheck failed: ${error.message}`);
    }

    return fallback(req, res, next);
  };
};

module.exports = {
  canAccessSkillResource,
};
