let capturedVerifyCallback;

jest.mock('passport-jwt', () => ({
  Strategy: jest.fn((_opts, verifyCallback) => {
    capturedVerifyCallback = verifyCallback;
    return { name: 'jwt' };
  }),
  ExtractJwt: {
    fromAuthHeaderAsBearerToken: jest.fn(() => 'mock-extractor'),
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

jest.mock('~/models', () => ({
  getUserById: jest.fn(),
  updateUser: jest.fn(),
  findToken: jest.fn(),
  findSession: jest.fn(),
}));

const jwtLogin = require('./jwtStrategy');
const { getUserById, updateUser } = require('~/models');

async function verify(payload) {
  return new Promise((resolve, reject) => {
    capturedVerifyCallback(payload, (err, user, info) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ user, info });
    });
  });
}

describe('jwtStrategy session version checks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jwtLogin();
  });

  it('accepts legacy tokens while the user session version is still zero', async () => {
    const user = { _id: 'user-1', role: 'USER', sessionVersion: 0 };
    getUserById.mockResolvedValue(user);

    const result = await verify({ id: 'user-1' });

    expect(result.user).toMatchObject({ id: 'user-1' });
    expect(result.info).toBeUndefined();
  });

  it('rejects tokens minted before the user session version was incremented', async () => {
    getUserById.mockResolvedValue({ _id: 'user-1', role: 'USER', sessionVersion: 2 });

    const result = await verify({ id: 'user-1', sessionVersion: 1 });

    expect(result.user).toBe(false);
    expect(result.info).toEqual({ message: 'Session invalidated' });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('accepts tokens whose session version matches the user', async () => {
    const user = { _id: 'user-1', role: 'USER', sessionVersion: 2 };
    getUserById.mockResolvedValue(user);

    const result = await verify({ id: 'user-1', sessionVersion: 2 });

    expect(result.user).toMatchObject({ id: 'user-1' });
  });

  it('passes database prompt-template permissions to the authenticated user', async () => {
    getUserById.mockResolvedValue({
      _id: 'operator-1',
      role: 'USER',
      sessionVersion: 0,
      permissions: { imagePromptTemplates: { manage: true } },
    });

    const result = await verify({ id: 'operator-1' });

    expect(result.user).toMatchObject({
      id: 'operator-1',
      permissions: { imagePromptTemplates: { manage: true } },
    });
  });
});

describe('logged-out JWTs', () => {
  const { findToken, findSession } = require('~/models');
  beforeEach(() => {
    jest.clearAllMocks();
    jwtLogin();
    getUserById.mockResolvedValue({ _id: 'user-1', role: 'USER' });
  });
  it('rejects a JWT after its server session was deleted', async () => {
    findSession.mockResolvedValue(null);
    expect((await verify({ id: 'user-1', sessionId: 'session-1' })).user).toBe(false);
  });
  it('accepts an existing server session', async () => {
    findSession.mockResolvedValue({ _id: 'session-1' });
    expect((await verify({ id: 'user-1', sessionId: 'session-1' })).user).toBeTruthy();
  });
  it('rejects an explicitly revoked legacy JWT', async () => {
    findToken.mockResolvedValue({ expiresAt: new Date(Date.now() + 60000) });
    expect((await verify({ id: 'user-1' })).user).toBe(false);
  });
});
