const express = require('express');
const request = require('supertest');

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user =
      req.headers['x-test-super-admin'] === 'true'
        ? { id: 'root', role: 'ADMIN', isSuperAdmin: true, email: 'root@example.com' }
        : { id: 'admin', role: 'ADMIN', isSuperAdmin: false, email: 'admin@example.com' };
    next();
  },
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: jest.fn(() => (_req, _res, next) => next()),
}));

jest.mock('~/server/services/AccountStateService', () => ({
  requireSuperAdmin: jest.fn((user) => {
    if (!user?.isSuperAdmin) {
      const error = new Error('需要超级管理员权限');
      error.status = 403;
      throw error;
    }
  }),
}));

jest.mock('~/server/services/UsageReportService', () => ({
  generateDailyUsageReport: jest.fn(async () => ({ periodKey: '2026-07-31@Asia/Shanghai' })),
  getReportSettings: jest.fn(async () => ({ key: 'daily_usage_report' })),
  getUsageDashboard: jest.fn(async () => ({ totals: {} })),
  getUsageReport: jest.fn(async () => ({ periodKey: '2026-07-31@Asia/Shanghai' })),
  getUsageReportDetails: jest.fn(async () => ({
    report: { periodKey: '2026-07-31@Asia/Shanghai' },
    deliveries: [],
    events: [],
  })),
  listModelPrices: jest.fn(async () => []),
  listUsageReports: jest.fn(async () => []),
  resendUsageReportEmail: jest.fn(async () => ({
    report: { periodKey: '2026-07-31@Asia/Shanghai' },
    delivery: { sent: true },
  })),
  retryUsageReportEmail: jest.fn(async () => ({
    report: { periodKey: '2026-07-31@Asia/Shanghai' },
    delivery: { sent: false, reason: 'not_configured' },
  })),
  updateReportSettings: jest.fn(async () => ({ key: 'daily_usage_report' })),
  upsertModelPrice: jest.fn(async () => ({ provider: 'openai', model: 'gpt-4o' })),
}));

const usageRoutes = require('./usage');
const {
  generateDailyUsageReport,
  resendUsageReportEmail,
  retryUsageReportEmail,
  updateReportSettings,
  upsertModelPrice,
} = require('~/server/services/UsageReportService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/usage', usageRoutes);
  return app;
}

describe('admin usage routes super-admin enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['put', '/api/admin/usage/prices'],
    ['patch', '/api/admin/usage/settings'],
    ['post', '/api/admin/usage/reports/generate'],
    ['post', '/api/admin/usage/reports/2026-07-31@Asia%2FShanghai/email/retry-failed'],
    ['post', '/api/admin/usage/reports/2026-07-31@Asia%2FShanghai/email/resend'],
  ])('blocks ordinary administrators from %s %s', async (method, path) => {
    const response = await request(createApp())[method](path).send({});

    expect(response.status).toBe(403);
    expect(upsertModelPrice).not.toHaveBeenCalled();
    expect(updateReportSettings).not.toHaveBeenCalled();
    expect(generateDailyUsageReport).not.toHaveBeenCalled();
    expect(retryUsageReportEmail).not.toHaveBeenCalled();
    expect(resendUsageReportEmail).not.toHaveBeenCalled();
  });

  it('allows super administrators to update pricing', async () => {
    const response = await request(createApp())
      .put('/api/admin/usage/prices')
      .set('x-test-super-admin', 'true')
      .send({ provider: 'openai', model: 'gpt-4o' });

    expect(response.status).toBe(200);
    expect(upsertModelPrice).toHaveBeenCalled();
  });

  it('allows super administrators to manually resend a usage report email', async () => {
    const response = await request(createApp())
      .post('/api/admin/usage/reports/2026-07-31@Asia%2FShanghai/email/resend')
      .set('x-test-super-admin', 'true')
      .send({});

    expect(response.status).toBe(200);
    expect(resendUsageReportEmail).toHaveBeenCalledWith('2026-07-31@Asia/Shanghai', {
      id: 'root',
      role: 'ADMIN',
      isSuperAdmin: true,
      email: 'root@example.com',
    });
  });

  it('allows super administrators to retry failed usage report recipients', async () => {
    const response = await request(createApp())
      .post('/api/admin/usage/reports/2026-07-31@Asia%2FShanghai/email/retry-failed')
      .set('x-test-super-admin', 'true')
      .send({});

    expect(response.status).toBe(200);
    expect(retryUsageReportEmail).toHaveBeenCalledWith('2026-07-31@Asia/Shanghai');
  });
});
