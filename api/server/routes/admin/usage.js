const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireSuperAdmin } = require('~/server/services/AccountStateService');
const {
  generateDailyUsageReport,
  getReportSettings,
  getUsageDashboard,
  getUsageReport,
  getUsageReportDetails,
  listModelPrices,
  listUsageReports,
  resendUsageReportEmail,
  retryUsageReportEmail,
  updateReportSettings,
  upsertModelPrice,
} = require('~/server/services/UsageReportService');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsage = requireCapability(SystemCapabilities.READ_USAGE);

function requireSuperAdminRoute(req, res, next) {
  try {
    requireSuperAdmin(req.user);
    return next();
  } catch (error) {
    return handleError(res, error);
  }
}

function handleError(res, error) {
  res.status(error?.status || 500).json({ message: error?.message || '用量数据读取失败' });
}

router.use(requireJwtAuth, requireAdminAccess);

router.get('/dashboard', requireReadUsage, async (req, res) => {
  try {
    res.json(await getUsageDashboard(req.query));
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/reports', requireReadUsage, async (req, res) => {
  try {
    res.json({ reports: await listUsageReports(req.query) });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/reports/generate', requireReadUsage, requireSuperAdminRoute, async (req, res) => {
  try {
    const report = await generateDailyUsageReport({
      now: req.body?.now ? new Date(req.body.now) : new Date(),
      email: Boolean(req.body?.email),
      forceEmail: Boolean(req.body?.forceEmail),
    });
    res.json({ report });
  } catch (error) {
    handleError(res, error);
  }
});

router.post(
  '/reports/:periodKey/email/retry-failed',
  requireReadUsage,
  requireSuperAdminRoute,
  async (req, res) => {
    try {
      res.json(await retryUsageReportEmail(req.params.periodKey));
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  '/reports/:periodKey/email/resend',
  requireReadUsage,
  requireSuperAdminRoute,
  async (req, res) => {
    try {
      res.json(await resendUsageReportEmail(req.params.periodKey, req.user));
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.get('/reports/:periodKey/details', requireReadUsage, async (req, res) => {
  try {
    const details = await getUsageReportDetails(req.params.periodKey);
    if (!details) {
      return res.status(404).json({ message: '报表不存在' });
    }
    res.json(details);
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/reports/:periodKey', requireReadUsage, async (req, res) => {
  try {
    const report = await getUsageReport(req.params.periodKey);
    if (!report) {
      return res.status(404).json({ message: '报表不存在' });
    }
    res.json({ report });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/prices', requireReadUsage, async (_req, res) => {
  try {
    res.json({ prices: await listModelPrices() });
  } catch (error) {
    handleError(res, error);
  }
});

router.put('/prices', requireSuperAdminRoute, async (req, res) => {
  try {
    const price = await upsertModelPrice(req.body, req.user);
    res.json({ price });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/settings', requireReadUsage, async (_req, res) => {
  try {
    res.json({ settings: await getReportSettings() });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/settings', requireSuperAdminRoute, async (req, res) => {
  try {
    res.json({ settings: await updateReportSettings(req.body ?? {}, req.user) });
  } catch (error) {
    handleError(res, error);
  }
});

module.exports = router;
