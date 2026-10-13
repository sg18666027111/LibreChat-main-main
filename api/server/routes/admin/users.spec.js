const express = require('express');
const request = require('supertest');

jest.mock('@librechat/data-schemas', () => ({
  SystemCapabilities: {
    ACCESS_ADMIN: 'ACCESS_ADMIN',
    READ_USERS: 'READ_USERS',
    MANAGE_USERS: 'MANAGE_USERS',
  },
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    if (!req.get('authorization')) return res.sendStatus(401);
    req.user = {
      _id: 'actor-user',
      id: 'actor-user',
      capabilities: String(req.get('x-capabilities') || '')
        .split(',')
        .filter(Boolean),
    };
    next();
  },
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: (capability) => (req, res, next) => {
    if (!req.user?.capabilities?.includes(capability)) {
      return res.status(403).json({ message: 'forbidden' });
    }
    return next();
  },
}));

const okHandler = (_req, res) => res.json({ ok: true });

jest.mock('@librechat/api', () => ({
  createAdminUsersHandlers: () => ({
    searchUsers: okHandler,
    listPromptTemplatePermissionLogs: okHandler,
    deletePromptTemplatePermissionLog: okHandler,
    grantPromptTemplatePermission: okHandler,
    revokePromptTemplatePermission: okHandler,
    updatePermissions: okHandler,
  }),
}));

jest.mock('~/models', () => ({
  findUsers: jest.fn(),
  countUsers: jest.fn(),
  updateUser: jest.fn(),
  grantImagePromptTemplatePermissionLog: jest.fn(),
  revokeImagePromptTemplatePermissionLog: jest.fn(),
  listImagePromptTemplatePermissionLogs: jest.fn(),
  softDeleteRevokedImagePromptTemplatePermissionLog: jest.fn(),
  deleteUserById: jest.fn(),
  deleteConfig: jest.fn(),
  deleteAclEntries: jest.fn(),
}));

jest.mock('~/server/services/AccountStateService', () => ({
  listAccountUsers: jest.fn(async () => ({ users: [], total: 0 })),
  requireSuperAdmin: jest.fn(),
  setAccountRole: jest.fn(),
  setAccountStatus: jest.fn(),
  syncSuperAdminFlagsFromEnv: jest.fn(),
}));

jest.mock('~/server/services/UserDeletionService', () => ({
  listUserDeletionJobs: jest.fn(),
  requestUserPermanentDeletion: jest.fn(),
  retryUserDeletionJob: jest.fn(),
}));

jest.mock('~/server/services/AdminPasswordResetService', () => ({
  createAdminPasswordReset: jest.fn(async () => ({
    link: 'https://example.com/reset-password?token=secret',
    expiresAt: '2026-09-19T12:15:00.000Z',
  })),
}));
const adminUsersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/users', adminUsersRouter);
  return app;
}

describe('admin user mutation route permissions', () => {
  const readOnlyAdminCapabilities = 'ACCESS_ADMIN,READ_USERS';
  const manageAdminCapabilities = 'ACCESS_ADMIN,READ_USERS,MANAGE_USERS';

  it.each([
    [
      'delete prompt-template permission log',
      'delete',
      '/api/admin/users/prompt-template-permissions/log-1',
    ],
    [
      'grant prompt-template permission',
      'post',
      '/api/admin/users/user-1/prompt-template-permission',
    ],
    [
      'revoke prompt-template permission',
      'delete',
      '/api/admin/users/user-1/prompt-template-permission',
    ],
    ['update prompt-template permissions', 'patch', '/api/admin/users/user-1/permissions'],
  ])('requires manage-users capability to %s', async (_label, method, path) => {
    const response = await request(buildApp())
      [method](path)
      .set('authorization', 'Bearer test')
      .set('x-capabilities', readOnlyAdminCapabilities)
      .send({});

    expect(response.status).toBe(403);
  });

  it.each([
    ['delete', '/api/admin/users/prompt-template-permissions/log-1'],
    ['post', '/api/admin/users/user-1/prompt-template-permission'],
    ['delete', '/api/admin/users/user-1/prompt-template-permission'],
    ['patch', '/api/admin/users/user-1/permissions'],
  ])('allows manage-users capability for %s %s', async (method, path) => {
    const response = await request(buildApp())
      [method](path)
      .set('authorization', 'Bearer test')
      .set('x-capabilities', manageAdminCapabilities)
      .send({});

    expect(response.status).toBe(200);
  });
});

describe('administrator reset link boundary', () => {
  const path = '/api/admin/users/user-1/password-reset-link';
  it('rejects unauthenticated callers', async () => {
    const response = await request(buildApp()).post(path).send({});
    expect(response.status).toBe(401);
    expect(response.text).not.toContain('token=');
  });
  it.each(['', 'READ_USERS', 'ACCESS_ADMIN,READ_USERS', 'MANAGE_USERS'])(
    'rejects insufficient capabilities %s',
    async (capabilities) => {
      const response = await request(buildApp())
        .post(path)
        .set('authorization', 'Bearer test')
        .set('x-capabilities', capabilities)
        .send({});
      expect(response.status).toBe(403);
      expect(response.text).not.toContain('token=');
    },
  );
  it('returns an uncacheable link only to an authorized manager', async () => {
    const response = await request(buildApp())
      .post(path)
      .set('authorization', 'Bearer test')
      .set('x-capabilities', 'ACCESS_ADMIN,MANAGE_USERS')
      .send({});
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.link).toContain('/reset-password?token=');
  });
});
