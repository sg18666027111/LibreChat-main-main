const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { MODEL_REGISTRY } = require('~/server/services/ImageGeneration/models');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const ARK_MODEL_KEY = 'ark_seedream_5_0_t2i';

router.use(requireJwtAuth, requireAdminAccess);

router.get('/ark-health', (_req, res) => {
  const config = MODEL_REGISTRY[ARK_MODEL_KEY] || null;

  return res.json({
    hasARK_API_KEY: Boolean(process.env.ARK_API_KEY),
    hasARK_IMAGE_TIMEOUT_MS: Boolean(process.env.ARK_IMAGE_TIMEOUT_MS),
    modelRegistered: Boolean(config),
    provider: config?.provider || 'ark',
    model: config?.model || 'doubao-seedream-5-0-pro-260628',
    modelKey: ARK_MODEL_KEY,
    capabilities: config?.capabilities || [],
    nodeEnv: process.env.NODE_ENV || null,
  });
});

module.exports = router;
