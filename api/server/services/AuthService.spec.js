jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
  getTenantId: jest.fn(() => undefined),
  DEFAULT_SESSION_EXPIRY: 900000,
  DEFAULT_REFRESH_TOKEN_EXPIRY: 604800000,
}));
jest.mock('librechat-data-provider', () => ({
  ErrorTypes: {},
  SystemRoles: { USER: 'USER', ADMIN: 'ADMIN' },
  errorsToString: jest.fn(),
}));
jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn((val) => val === 'true' || val === true),
  checkEmailConfig: jest.fn(),
  isEmailDomainAllowed: jest.fn(),
  math: jest.fn((val, fallback) => (val ? Number(val) : fallback)),
  shouldUseSecureCookie: jest.fn(() => false),
  resolveAppConfigForUser: jest.fn(async (_getAppConfig, _user) => ({})),
  setCloudFrontCookies: jest.fn(() => true),
  getCloudFrontConfig: jest.fn(() => ({
    domain: 'https://cdn.example.com',
    imageSigning: 'cookies',
    cookieDomain: '.example.com',
    privateKey: 'test-private-key',
    keyPairId: 'K123ABC',
  })),
  parseCloudFrontCookieScope: jest.fn(() => null),
  CLOUDFRONT_SCOPE_COOKIE: 'LibreChat-CloudFront-Scope',
}));
jest.mock('~/models', () => ({
  acquireAdminMutationLock: jest.fn(async () => true),
  releaseAdminMutationLock: jest.fn(async () => true),
  findUser: jest.fn(),
  findToken: jest.fn(),
  consumeToken: jest.fn(),
  resetUserPassword: jest.fn(),
  deleteAllUserSessions: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  countUsers: jest.fn(),
  getUserById: jest.fn(),
  findSession: jest.fn(),
  createToken: jest.fn(),
  deleteTokens: jest.fn(),
  deleteSession: jest.fn(),
  createSession: jest.fn(),
  generateToken: jest.fn(),
  deleteUserById: jest.fn(),
  generateRefreshToken: jest.fn(),
  isEmailBlocked: jest.fn(),
}));
jest.mock('~/strategies/validators', () => ({
  registerSchema: {
    safeParse: jest.fn((user) => ({
      success: true,
      data: {
        name: user.name,
        username: user.username,
        email: user.email,
        password: user.password,
        confirm_password: user.confirm_password,
        inviteCode: user.inviteCode,
      },
    })),
  },
}));
jest.mock('~/server/services/InviteCodeService', () => ({
  APPROVAL_STATUSES: {
    ACTIVE: 'active',
    PENDING: 'pending',
  },
  consumeInviteCode: jest.fn(async () => ({ ok: true })),
  setUserApprovalStatus: jest.fn(async () => ({ _id: 'new-user-id' })),
  validateInviteCode: jest.fn(async () => ({ ok: true })),
}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/utils', () => ({ sendEmail: jest.fn() }));
jest.mock('~/server/services/InviteCodeService', () => ({
  APPROVAL_STATUSES: { ACTIVE: 'active', PENDING: 'pending' },
  consumeInviteCode: jest.fn(async () => ({ ok: true })),
  setUserApprovalStatus: jest.fn(async () => ({})),
  validateInviteCode: jest.fn(async () => ({ ok: true })),
}));

const {
  checkEmailConfig,
  shouldUseSecureCookie,
  isEmailDomainAllowed,
  setCloudFrontCookies,
  getCloudFrontConfig,
  parseCloudFrontCookieScope,
} = require('@librechat/api');
const jwt = require('jsonwebtoken');
const { logger, getTenantId } = require('@librechat/data-schemas');
const {
  findUser,
  createUser,
  updateUser,
  countUsers,
  getUserById,
  isEmailBlocked,
  generateToken,
  generateRefreshToken,
  createSession,
} = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const {
  consumeInviteCode,
  setUserApprovalStatus,
  validateInviteCode,
} = require('~/server/services/InviteCodeService');
const {
  setOpenIDAuthTokens,
  requestPasswordReset,
  registerUser,
  setAuthTokens,
  setCloudFrontAuthCookies,
} = require('./AuthService');

/** Helper to build a mock Express response */
function mockResponse() {
  const cookies = {};
  const res = {
    cookie: jest.fn((name, value, options) => {
      cookies[name] = { value, options };
    }),
    _cookies: cookies,
  };
  return res;
}

/** Helper to build a mock Express request with session */
function mockRequest(sessionData = {}, cookies = {}) {
  return {
    session: { openidTokens: null, ...sessionData },
    cookies,
  };
}

describe('setOpenIDAuthTokens', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...env,
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      OPENID_REUSE_TOKENS: 'true',
    };
  });

  afterAll(() => {
    process.env = env;
  });

  describe('token selection (id_token vs access_token)', () => {
    it('should return id_token when both id_token and access_token are present', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBe('the-id-token');
    });

    it('should return access_token when id_token is not available', () => {
      const tokenset = {
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBe('the-access-token');
    });

    it('should return access_token when id_token is undefined', () => {
      const tokenset = {
        id_token: undefined,
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBe('the-access-token');
    });

    it('should return access_token when id_token is null', () => {
      const tokenset = {
        id_token: null,
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBe('the-access-token');
    });

    it('should return id_token even when id_token and access_token differ', () => {
      const tokenset = {
        id_token: 'id-token-jwt-signed-by-idp',
        access_token: 'opaque-graph-api-token',
        refresh_token: 'refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBe('id-token-jwt-signed-by-idp');
      expect(result).not.toBe('opaque-graph-api-token');
    });
  });

  describe('session token storage', () => {
    it('should store the original access_token in session (not id_token)', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(req.session.openidTokens.accessToken).toBe('the-access-token');
      expect(req.session.openidTokens.idToken).toBe('the-id-token');
      expect(req.session.openidTokens.refreshToken).toBe('the-refresh-token');
      expect(req.session.openidTokens.lastRefreshedAt).toEqual(expect.any(Number));
    });

    it('should return the existing unexpired session id_token when refresh omits one', () => {
      const existingIdToken = jwt.sign(
        { sub: 'user-123', exp: Math.floor(Date.now() / 1000) + 3600 },
        'idp-signing-secret',
      );
      const tokenset = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      };
      const req = mockRequest({
        openidTokens: {
          accessToken: 'old-access-token',
          idToken: existingIdToken,
          refreshToken: 'old-refresh-token',
        },
      });
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(result).toBe(existingIdToken);
      expect(req.session.openidTokens.accessToken).toBe('new-access-token');
      expect(req.session.openidTokens.idToken).toBe(existingIdToken);
      expect(req.session.openidTokens.refreshToken).toBe('new-refresh-token');
      expect(req.session.openidTokens.lastRefreshedAt).toEqual(expect.any(Number));
    });

    it('should fall back to access_token when the existing session id_token is expired', () => {
      const expiredIdToken = jwt.sign(
        { sub: 'user-123', exp: Math.floor(Date.now() / 1000) - 60 },
        'idp-signing-secret',
      );
      const tokenset = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      };
      const req = mockRequest({
        openidTokens: {
          accessToken: 'old-access-token',
          idToken: expiredIdToken,
          refreshToken: 'old-refresh-token',
        },
      });
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(result).toBe('new-access-token');
      expect(req.session.openidTokens.idToken).toBe(expiredIdToken);
      expect(req.session.openidTokens.accessToken).toBe('new-access-token');
    });

    it('should fall back to access_token when the existing session id_token is near expiry', () => {
      const nearExpiryIdToken = jwt.sign(
        { sub: 'user-123', exp: Math.floor(Date.now() / 1000) + 10 },
        'idp-signing-secret',
      );
      const tokenset = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      };
      const req = mockRequest({
        openidTokens: {
          accessToken: 'old-access-token',
          idToken: nearExpiryIdToken,
          refreshToken: 'old-refresh-token',
        },
      });
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(result).toBe('new-access-token');
      expect(req.session.openidTokens.idToken).toBe(nearExpiryIdToken);
      expect(req.session.openidTokens.accessToken).toBe('new-access-token');
    });
  });

  describe('cookie secure flag', () => {
    it('should call shouldUseSecureCookie for every cookie set', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      // token_provider + openid_user_id (session path, so no refreshToken/openid_access_token cookies)
      const secureCalls = shouldUseSecureCookie.mock.calls.length;
      expect(secureCalls).toBeGreaterThanOrEqual(2);

      // Verify all cookies use the result of shouldUseSecureCookie
      for (const [, cookie] of Object.entries(res._cookies)) {
        expect(cookie.options.secure).toBe(false);
      }
    });

    it('should set secure: true when shouldUseSecureCookie returns true', () => {
      shouldUseSecureCookie.mockReturnValue(true);

      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      for (const [, cookie] of Object.entries(res._cookies)) {
        expect(cookie.options.secure).toBe(true);
      }
    });

    it('should use shouldUseSecureCookie for cookie fallback path (no session)', () => {
      shouldUseSecureCookie.mockReturnValue(false);

      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = { session: null };
      const res = mockResponse();

      setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      // In the cookie fallback path, we get: refreshToken, openid_access_token, token_provider, openid_user_id
      expect(res.cookie).toHaveBeenCalledWith(
        'refreshToken',
        expect.any(String),
        expect.objectContaining({ secure: false }),
      );
      expect(res.cookie).toHaveBeenCalledWith(
        'openid_access_token',
        expect.any(String),
        expect.objectContaining({ secure: false }),
      );
      expect(res.cookie).toHaveBeenCalledWith(
        'token_provider',
        'openid',
        expect.objectContaining({ secure: false }),
      );
    });
  });

  describe('edge cases', () => {
    it('should return undefined when tokenset is null', () => {
      const req = mockRequest();
      const res = mockResponse();
      const result = setOpenIDAuthTokens(null, req, res, 'user-123');
      expect(result).toBeUndefined();
    });

    it('should return undefined when access_token is missing', () => {
      const tokenset = { refresh_token: 'refresh' };
      const req = mockRequest();
      const res = mockResponse();
      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBeUndefined();
    });

    it('should return undefined when no refresh token is available', () => {
      const tokenset = { access_token: 'access', id_token: 'id' };
      const req = mockRequest();
      const res = mockResponse();
      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBeUndefined();
    });

    it('should use existingRefreshToken when tokenset has no refresh_token', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123', 'existing-refresh');
      expect(result).toBe('the-id-token');
      expect(req.session.openidTokens.refreshToken).toBe('existing-refresh');
    });
  });
});

describe('registerUser', () => {
  const registrationPayload = {
    name: 'Test User',
    username: 'testuser',
    email: 'test@example.com',
    password: 'Password123!',
    confirm_password: 'Password123!',
    inviteCode: 'JJC-TEST-0001',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOW_UNVERIFIED_EMAIL_LOGIN = 'false';
    checkEmailConfig.mockReturnValue(false);
    isEmailDomainAllowed.mockReturnValue(true);
    getAppConfig.mockResolvedValue({
      balance: { enabled: false },
      registration: { allowedDomains: [] },
    });
    findUser.mockResolvedValue(null);
    isEmailBlocked.mockResolvedValue(false);
    countUsers.mockResolvedValue(1);
    createUser.mockResolvedValue({ _id: 'new-user-id' });
    updateUser.mockResolvedValue({ _id: 'new-user-id' });
  });

  it('requires and consumes an invite code and keeps the account pending', async () => {
    const result = await registerUser(registrationPayload);

    expect(result.status).toBe(200);
    expect(validateInviteCode).toHaveBeenCalledWith(registrationPayload.inviteCode);
    expect(consumeInviteCode).toHaveBeenCalledWith(registrationPayload.inviteCode);
    expect(createUser.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        email: registrationPayload.email,
        role: 'USER',
      }),
    );
    expect(setUserApprovalStatus).toHaveBeenCalledWith('new-user-id', 'pending');
  });

  it('does not grant admin privileges to the first public registration by default', async () => {
    delete process.env.INITIAL_ADMIN_EMAIL;
    countUsers.mockResolvedValue(0);

    const result = await registerUser(registrationPayload);

    expect(result.status).toBe(200);
    expect(createUser.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        role: 'USER',
      }),
    );
    expect(setUserApprovalStatus).toHaveBeenCalledWith('new-user-id', 'pending');
  });

  it('checks the email blocklist before creating a user', async () => {
    isEmailBlocked.mockResolvedValue(true);

    const result = await registerUser(registrationPayload);

    expect(result.status).toBe(403);
    expect(result.message).toMatch(/邮箱已被禁止注册/);
    expect(findUser).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it('ignores provider values from the public registration payload', async () => {
    countUsers.mockResolvedValue(0);

    const result = await registerUser({ ...registrationPayload, provider: 'google' });

    expect(result.status).toBe(200);
    expect(createUser.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        email: registrationPayload.email,
        provider: 'local',
      }),
    );
  });

  it('allows trusted callers to set provider through additional data', async () => {
    countUsers.mockResolvedValue(0);

    const result = await registerUser(registrationPayload, {
      emailVerified: true,
      provider: 'google',
    });

    expect(result.status).toBe(200);
    expect(createUser.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        email: registrationPayload.email,
        emailVerified: true,
        provider: 'google',
      }),
    );
  });

  it('does not allow registration additional data to grant account privileges', async () => {
    const result = await registerUser(registrationPayload, {
      role: 'ADMIN',
      isSuperAdmin: true,
      approvalStatus: 'active',
      sessionVersion: 99,
      reportingSubjectId: 'usr_attacker_controlled',
    });

    expect(result.status).toBe(200);
    expect(createUser.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        role: 'USER',
      }),
    );
    expect(createUser.mock.calls[0][0]).toEqual(
      expect.not.objectContaining({
        isSuperAdmin: true,
        approvalStatus: 'active',
        sessionVersion: 99,
        reportingSubjectId: 'usr_attacker_controlled',
      }),
    );
  });
});

describe('requestPasswordReset', () => {
  const { sendEmail } = require('~/server/utils');
  const { createToken } = require('~/models');
  it.each(['known@example.com', 'unknown@example.com', '', undefined])(
    'only returns administrator guidance for %s, even when mail is configured',
    async (email) => {
      jest.clearAllMocks();
      checkEmailConfig.mockReturnValue(true);
      const result = await requestPasswordReset({ body: { email } });
      expect(result).toEqual({
        message: 'Please contact your administrator to reset your password.',
      });
      expect(findUser).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
      expect(createToken).not.toHaveBeenCalled();
    },
  );
});

describe('CloudFront cookie integration', () => {
  const cloudFrontCookieConfig = {
    domain: 'https://cdn.example.com',
    imageSigning: 'cookies',
    cookieDomain: '.example.com',
    privateKey: 'test-private-key',
    keyPairId: 'K123ABC',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getCloudFrontConfig.mockReturnValue(cloudFrontCookieConfig);
    setCloudFrontCookies.mockReturnValue(true);
    parseCloudFrontCookieScope.mockReturnValue(null);
  });

  describe('setCloudFrontAuthCookies', () => {
    it('passes user id and tenant scope from the user', () => {
      const req = mockRequest();
      const res = mockResponse();
      const user = {
        _id: { toString: () => 'user-123' },
        tenantId: { toString: () => 'tenantA' },
      };

      const result = setCloudFrontAuthCookies(req, res, user);

      expect(result).toBe(true);
      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'tenantA',
        },
        null,
      );
      expect(logger.debug).toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies refreshed',
        expect.objectContaining({
          attempted: true,
          set: true,
          has_user_id: true,
          has_tenant_scope: true,
        }),
      );
    });

    it('lets explicit scope options override user and request scope', () => {
      const req = mockRequest();
      req.user = { _id: 'request-user', tenantId: 'request-tenant' };
      const res = mockResponse();
      const user = { _id: 'user-123', tenantId: 'tenantA' };

      setCloudFrontAuthCookies(req, res, user, {
        userId: 'option-user',
        tenantId: 'option-tenant',
        storageRegion: 'us-east-2',
      });

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'option-user',
          tenantId: 'option-tenant',
          storageRegion: 'us-east-2',
        },
        null,
      );
    });

    it('falls back to request tenant scope when the user has none', () => {
      const req = mockRequest();
      req.user = { tenantId: 'request-tenant' };
      const res = mockResponse();

      setCloudFrontAuthCookies(req, res, { _id: 'user-123' });

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'request-tenant',
        },
        null,
      );
    });

    it('uses org scope as tenant scope when tenantId is unavailable', () => {
      const req = mockRequest();
      const res = mockResponse();

      setCloudFrontAuthCookies(req, res, { _id: 'user-123', orgId: 'orgA' });

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'orgA',
        },
        null,
      );
    });

    it('uses previous CloudFront scope for stale cookie cleanup', () => {
      parseCloudFrontCookieScope.mockReturnValue({ userId: 'old-user', tenantId: 'old-tenant' });
      const req = mockRequest({}, { 'LibreChat-CloudFront-Scope': 'encoded-scope' });
      const res = mockResponse();

      setCloudFrontAuthCookies(req, res, { _id: 'user-123', tenantId: 'tenantA' });

      expect(parseCloudFrontCookieScope).toHaveBeenCalledWith('encoded-scope');
      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'tenantA',
        },
        { userId: 'old-user', tenantId: 'old-tenant' },
      );
    });

    it('no-ops when CloudFront cookie signing is disabled', () => {
      getCloudFrontConfig.mockReturnValue({ ...cloudFrontCookieConfig, imageSigning: 'none' });
      const req = mockRequest();
      const res = mockResponse();

      const result = setCloudFrontAuthCookies(req, res, { _id: 'user-123' });

      expect(result).toBe(false);
      expect(setCloudFrontCookies).not.toHaveBeenCalled();
      expect(logger.debug).not.toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies skipped',
        expect.any(Object),
      );
    });

    it('fails closed when user id is missing', () => {
      const req = mockRequest();
      const res = mockResponse();

      const result = setCloudFrontAuthCookies(req, res, { tenantId: 'tenantA' });

      expect(result).toBe(false);
      expect(setCloudFrontCookies).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies skipped',
        expect.objectContaining({
          attempted: false,
          set: false,
          reason: 'missing_user_id',
        }),
      );
    });

    it('skips when CloudFront cookie domain is missing', () => {
      getCloudFrontConfig.mockReturnValue({ ...cloudFrontCookieConfig, cookieDomain: null });
      const req = mockRequest();
      const res = mockResponse();

      const result = setCloudFrontAuthCookies(req, res, { _id: 'user-123' });

      expect(result).toBe(false);
      expect(setCloudFrontCookies).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies skipped',
        expect.objectContaining({
          attempted: false,
          set: false,
          reason: 'missing_cookie_domain',
        }),
      );
    });

    it('does not log cookie secrets or signed-cookie values', () => {
      const req = mockRequest();
      const res = mockResponse();

      setCloudFrontAuthCookies(req, res, { _id: 'user-123' });

      const debugOutput = JSON.stringify(logger.debug.mock.calls);
      expect(debugOutput).not.toContain('test-private-key');
      expect(debugOutput).not.toContain('K123ABC');
      expect(debugOutput).not.toContain('CloudFront-Policy');
      expect(debugOutput).not.toContain('CloudFront-Signature');
      expect(debugOutput).not.toContain('CloudFront-Key-Pair-Id');
    });
  });

  describe('setOpenIDAuthTokens', () => {
    const validTokenset = {
      id_token: 'the-id-token',
      access_token: 'the-access-token',
      refresh_token: 'the-refresh-token',
    };

    it('calls setCloudFrontCookies with response object and user scope from options', () => {
      const req = mockRequest();
      const res = mockResponse();

      setOpenIDAuthTokens(validTokenset, req, res, {
        userId: 'user-123',
        tenantId: 'tenantA',
      });

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'tenantA',
        },
        null,
      );
    });

    it('keeps backward compatibility with positional user and tenant params', () => {
      const req = mockRequest();
      const res = mockResponse();

      setOpenIDAuthTokens(validTokenset, req, res, 'user-123', undefined, 'tenantA');

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'tenantA',
        },
        null,
      );
    });

    it('treats a null options argument as an empty legacy user id', () => {
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(validTokenset, req, res, null);

      expect(result).toBe('the-id-token');
      expect(setCloudFrontCookies).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies skipped',
        expect.objectContaining({
          attempted: false,
          set: false,
          reason: 'missing_user_id',
        }),
      );
    });

    it('treats omitted options as an empty legacy user id', () => {
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(validTokenset, req, res);

      expect(result).toBe('the-id-token');
      expect(setCloudFrontCookies).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies skipped',
        expect.objectContaining({
          attempted: false,
          set: false,
          reason: 'missing_user_id',
        }),
      );
    });

    it('treats an object without token option keys as empty options', () => {
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(validTokenset, req, res, {});

      expect(result).toBe('the-id-token');
      expect(setCloudFrontCookies).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies skipped',
        expect.objectContaining({
          attempted: false,
          set: false,
          reason: 'missing_user_id',
        }),
      );
    });

    it('succeeds even when setCloudFrontCookies returns false', () => {
      setCloudFrontCookies.mockReturnValue(false);

      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(validTokenset, req, res, 'user-123');

      expect(result).toBe('the-id-token');
    });
  });

  describe('setAuthTokens', () => {
    beforeEach(() => {
      getUserById.mockResolvedValue({ _id: 'user-123', tenantId: 'tenantA' });
      generateToken.mockResolvedValue('mock-access-token');
      generateRefreshToken.mockReturnValue('mock-refresh-token');
      createSession.mockResolvedValue({
        session: { expiration: new Date(Date.now() + 604800000) },
        refreshToken: 'mock-refresh-token',
      });
    });

    it('calls setCloudFrontCookies with response object and user scope', async () => {
      const res = mockResponse();

      await setAuthTokens('user-123', res);

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'tenantA',
        },
        null,
      );
    });

    it('uses the fetched user id as the canonical CloudFront user scope', async () => {
      getUserById.mockResolvedValueOnce({
        _id: { toString: () => 'canonical-user' },
        tenantId: 'tenantA',
      });
      const res = mockResponse();

      await setAuthTokens('input-user-id', res);

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'canonical-user',
          tenantId: 'tenantA',
        },
        null,
      );
    });

    it('passes the previous CloudFront cookie scope when present', async () => {
      parseCloudFrontCookieScope.mockReturnValue({ userId: 'old-user', tenantId: 'old-tenant' });
      const res = mockResponse();
      const req = mockRequest({}, { 'LibreChat-CloudFront-Scope': 'encoded-scope' });

      await setAuthTokens('user-123', res, null, req);

      expect(parseCloudFrontCookieScope).toHaveBeenCalledWith('encoded-scope');
      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'tenantA',
        },
        { userId: 'old-user', tenantId: 'old-tenant' },
      );
    });

    it('succeeds even when setCloudFrontCookies returns false', async () => {
      setCloudFrontCookies.mockReturnValue(false);

      const res = mockResponse();

      const result = await setAuthTokens('user-123', res);

      expect(result).toBe('mock-access-token');
    });
  });
});

describe('registerUser - allowedDomains admin-panel override', () => {
  const validUser = {
    email: 'new-user@example.com',
    inviteCode: 'JJC-TEST-CODE',
    password: 'a-secure-password',
    name: 'New User',
    username: 'new-user',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getTenantId.mockReturnValue(undefined);
    isEmailDomainAllowed.mockReturnValue(true);
    getAppConfig.mockResolvedValue({
      registration: { allowedDomains: ['example.com'] },
      balance: undefined,
    });
    findUser.mockResolvedValue(null);
    isEmailBlocked.mockResolvedValue(false);
    countUsers.mockResolvedValue(0);
  });

  it('should resolve the full app config so admin-panel overrides on the __base__ principal apply', async () => {
    // Regression guard for getAppConfig({ baseOnly: true }): that option short-circuits
    // before the DB override merge, which silently ignores any admin-panel edits to
    // registration.allowedDomains (the admin panel writes overrides to the __base__
    // principal in the configs collection). registerUser must request the merged config
    // so the global __base__ override is honored, same as it is for SSO callbacks via
    // checkDomainAllowed.
    await registerUser(validUser);

    expect(getAppConfig).toHaveBeenCalledTimes(1);
    expect(getAppConfig).toHaveBeenCalledWith({});
    expect(getAppConfig).not.toHaveBeenCalledWith(expect.objectContaining({ baseOnly: true }));
  });

  it('should pass tenantId from ALS so the merged-config cache key matches tenant-scoped DB queries', async () => {
    // /api/auth runs through preAuthTenantMiddleware, which puts a tenantId into
    // AsyncLocalStorage. Mongoose queries inside getApplicableConfigs are scoped by ALS,
    // but the per-principal merged-config cache key uses the explicit tenantId param.
    // If we don't forward the ALS tenantId, tenant A's request caches at `__default__`
    // and a later tenant B request can hit that entry — leaking config across tenants.
    getTenantId.mockReturnValue('tenant-x');

    await registerUser(validUser);

    expect(getAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-x' });
  });

  it('should block registration when the resolved allowedDomains rejects the email', async () => {
    isEmailDomainAllowed.mockReturnValue(false);

    const result = await registerUser({ ...validUser, email: 'blocked@evil.com' });

    expect(result.status).toBe(403);
    expect(result.message).toMatch(/cannot be used/i);
    // Domain check must happen before any DB user lookup.
    expect(findUser).not.toHaveBeenCalled();
  });
});

describe('account lifecycle security', () => {
  const db = require('~/models');
  const bcrypt = require('bcryptjs');
  const { sendEmail } = require('~/server/utils');
  const { resetPassword, logoutUser } = require('./AuthService');
  const userId = '64f000000000000000000001';
  const rawToken = 'a'.repeat(64);
  const user = { _id: userId, email: 'user@example.com', provider: 'local' };
  const payload = {
    name: 'Test User',
    email: user.email,
    password: 'Password123!',
    confirm_password: 'Password123!',
  };
  beforeEach(() => {
    jest.clearAllMocks();
    checkEmailConfig.mockReturnValue(true);
    isEmailDomainAllowed.mockReturnValue(true);
    getAppConfig.mockResolvedValue({ balance: {}, registration: {} });
    db.countUsers.mockResolvedValue(1);
    db.findUser.mockResolvedValue(user);
    db.createUser.mockResolvedValue(user);
    db.updateUser.mockResolvedValue(user);
    db.resetUserPassword.mockResolvedValue(user);
    db.isEmailBlocked.mockResolvedValue(false);
    db.consumeToken.mockResolvedValue({ userId });
    db.findToken.mockResolvedValue({
      userId,
      type: 'password_reset',
      identifier: JSON.stringify({
        sessionVersion: 0,
        role: 'USER',
        isSuperAdmin: false,
        tenantId: '',
      }),
      token: bcrypt.hashSync(rawToken, 4),
      expiresAt: new Date(Date.now() + 60000),
    });
    sendEmail.mockResolvedValue({});
    validateInviteCode.mockResolvedValue({ ok: true });
    consumeInviteCode.mockResolvedValue({ ok: true });
  });
  it.each([undefined, '', '   '])(
    'rejects registration missing a code (%p), even for the first user',
    async (inviteCode) => {
      db.countUsers.mockResolvedValue(0);
      db.findUser.mockResolvedValue(null);
      expect((await registerUser({ ...payload, inviteCode })).status).toBe(400);
      expect(db.createUser).not.toHaveBeenCalled();
    },
  );
  it('does not accept a provisioning bypass from HTTP registration fields', async () => {
    db.findUser.mockResolvedValue(null);
    expect((await registerUser({ ...payload, trustedProvisioning: true })).status).toBe(400);
    expect(db.createUser).not.toHaveBeenCalled();
  });
  it('preserves the explicitly trusted create-user CLI without weakening public registration', async () => {
    db.findUser.mockResolvedValue(null);
    getAppConfig.mockResolvedValue({ balance: {}, turnstileConfig: { siteKey: 'configured-key' } });
    const result = await registerUser(
      payload,
      { emailVerified: true },
      { trustedProvisioning: true },
    );
    expect(result.status).toBe(200);
    expect(db.createUser.mock.calls[0][0].approvalStatus).toBe('pending');
    expect(validateInviteCode).not.toHaveBeenCalled();
    expect(consumeInviteCode).not.toHaveBeenCalled();
  });
  it.each(['wrong', 'expired'])(
    'rejects %s registration codes before creating a user',
    async (inviteCode) => {
      validateInviteCode.mockResolvedValue({ ok: false, message: 'Invalid code' });
      db.findUser.mockResolvedValue(null);
      expect((await registerUser({ ...payload, inviteCode })).status).toBe(400);
      expect(db.createUser).not.toHaveBeenCalled();
    },
  );
  it('enforces configured Turnstile on direct registration API payloads', async () => {
    getAppConfig.mockResolvedValue({ balance: {}, turnstileConfig: { siteKey: 'configured-key' } });
    db.findUser.mockResolvedValue(null);
    const result = await registerUser({ ...payload, inviteCode: 'JJC-TEST-CODE' });
    expect(result.status).toBe(400);
    expect(db.createUser).not.toHaveBeenCalled();
  });
  it('does not create a user if the final atomic code claim loses a race', async () => {
    db.findUser.mockResolvedValue(null);
    consumeInviteCode.mockResolvedValue({ ok: false, message: 'Used code' });
    expect((await registerUser({ ...payload, inviteCode: 'JJC-TEST-CODE' })).status).toBe(400);
    expect(db.createUser).not.toHaveBeenCalled();
  });
  it('creates the account with pending status in the initial insert', async () => {
    db.findUser.mockResolvedValue(null);
    await registerUser({ ...payload, inviteCode: 'JJC-TEST-CODE' });
    expect(db.createUser.mock.calls[0][0].approvalStatus).toBe('pending');
  });
  it('never returns a reset link when mail is unavailable', async () => {
    checkEmailConfig.mockReturnValue(false);
    const existing = await requestPasswordReset({ body: { email: user.email } });
    db.findUser.mockResolvedValue(null);
    const missing = await requestPasswordReset({ body: { email: 'missing@example.com' } });
    expect(existing).toEqual(missing);
    expect(existing.link).toBeUndefined();
    expect(db.createToken).not.toHaveBeenCalled();
  });
  it('rejects expired tokens even before Mongo TTL cleanup', async () => {
    db.findToken.mockResolvedValue({
      token: bcrypt.hashSync(rawToken, 4),
      expiresAt: new Date(Date.now() - 1),
    });
    expect(await resetPassword(userId, rawToken, 'NewPassword123!')).toBeInstanceOf(Error);
    expect(db.updateUser).not.toHaveBeenCalled();
    expect(db.resetUserPassword).not.toHaveBeenCalled();
  });
  it('only lets one concurrent request consume a reset token', async () => {
    db.consumeToken.mockResolvedValueOnce({ userId }).mockResolvedValueOnce(null);
    const results = await Promise.all([
      resetPassword(userId, rawToken, 'NewPassword123!'),
      resetPassword(userId, rawToken, 'OtherPassword123!'),
    ]);
    expect(results.filter((r) => r instanceof Error)).toHaveLength(1);
    expect(db.resetUserPassword).toHaveBeenCalledTimes(1);
  });
  it('invalidates the token and sessions without sending confirmation email', async () => {
    sendEmail.mockRejectedValue(new Error('mail failed'));
    await expect(resetPassword(userId, rawToken, 'NewPassword123!')).resolves.toEqual({
      message: 'Password reset was successful',
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.consumeToken).toHaveBeenCalled();
    expect(db.deleteAllUserSessions).toHaveBeenCalledWith({ userId });
    expect(bcrypt.compareSync('NewPassword123!', db.resetUserPassword.mock.calls[0][1])).toBe(true);
  });
  it.each(['short', ' '.repeat(10)])('rejects unsafe new passwords', async (password) => {
    expect(await resetPassword(userId, rawToken, password)).toBeInstanceOf(Error);
    expect(db.consumeToken).not.toHaveBeenCalled();
  });
  it('waits for server session destruction and reports failure', async () => {
    db.findSession.mockResolvedValue(null);
    const req = { user, session: { destroy: (cb) => cb(new Error('store failed')) } };
    expect((await logoutUser(req, 'refresh')).status).toBe(500);
  });
});
