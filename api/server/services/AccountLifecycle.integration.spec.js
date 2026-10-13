const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('~/models', () => {
  const mongoose = require('mongoose');
  const { createMethods, createModels } = require('@librechat/data-schemas');
  createModels(mongoose);
  return createMethods(mongoose);
});
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(async () => ({ balance: { enabled: false }, registration: {} })),
}));
jest.mock('~/server/utils', () => ({ sendEmail: jest.fn(async () => ({})) }));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  checkEmailConfig: jest.fn(() => false),
  getCloudFrontConfig: jest.fn(() => null),
}));

const { createModels } = require('@librechat/data-schemas');
const { checkEmailConfig } = require('@librechat/api');
const db = require('~/models');
const { sendEmail } = require('~/server/utils');
const {
  registerUser,
  requestPasswordReset,
  resetPassword,
  setAuthTokens,
  logoutUser,
} = require('./AuthService');
const { createInviteCodes, setUserApprovalStatus } = require('./InviteCodeService');
const localStrategy = require('~/strategies/localStrategy');
const jwtStrategy = require('~/strategies/jwtStrategy');
const payload = {
  name: 'Lifecycle User',
  email: 'lifecycle@example.com',
  password: 'OriginalPassword123!',
  confirm_password: 'OriginalPassword123!',
};
let mongo;
async function adminReset(targetUserId, actor) {
  const { createAdminPasswordReset } = require('./AdminPasswordResetService');
  actor ||= await mongoose.models.User.create({
    email: 'admin@example.com',
    name: 'Admin',
    role: 'ADMIN',
    provider: 'local',
    approvalStatus: 'active',
    emailVerified: true,
  });
  return createAdminPasswordReset({ actor, targetUserId: String(targetUserId) });
}

async function login(password = payload.password) {
  return new Promise((resolve, reject) =>
    localStrategy()._verify(
      { body: { email: payload.email, password }, ip: '127.0.0.1' },
      payload.email,
      password,
      (error, user, info) => (error ? reject(error) : resolve({ user, info })),
    ),
  );
}
async function authenticate(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  return new Promise((resolve, reject) =>
    jwtStrategy()._verify(decoded, (error, user) => (error ? reject(error) : resolve(user))),
  );
}
async function seedAccount() {
  const [code] = await createInviteCodes({ count: 1 });
  const registered = await registerUser({ ...payload, inviteCode: code.code });
  expect(registered.status).toBe(200);
  return db.findUser({ email: payload.email });
}
async function issueSession(user) {
  const cookies = {};
  const token = await setAuthTokens(String(user._id), {
    cookie: (name, value) => {
      cookies[name] = value;
    },
  });
  return { token, refreshToken: cookies.refreshToken };
}
beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: '8.2.1' } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  checkEmailConfig.mockReturnValue(false);
  sendEmail.mockClear();
  process.env.ALLOW_UNVERIFIED_EMAIL_LOGIN = 'false';
  process.env.DOMAIN_CLIENT = 'https://jingjicang.it.com';
  delete process.env.ALLOW_PASSWORD_RESET;
});

test('registration rejects missing, invalid and expired codes; approval gates real password login', async () => {
  for (const inviteCode of [undefined, '', 'JJC-WRONG-CODE']) {
    expect((await registerUser({ ...payload, inviteCode })).status).toBe(400);
  }
  const [expired] = await createInviteCodes({ expiresAt: new Date(Date.now() - 1000) });
  expect((await registerUser({ ...payload, inviteCode: expired.code })).status).toBe(400);
  expect(await mongoose.models.User.countDocuments()).toBe(0);
  const user = await seedAccount();
  expect(user.approvalStatus).toBe('pending');
  expect((await login()).user).toBe(false);
  await setUserApprovalStatus(user._id, 'rejected');
  expect((await login()).user).toBe(false);
  await setUserApprovalStatus(user._id, 'active');
  expect((await login()).user.email).toBe(payload.email);
});

test('one-use registration code cannot create two concurrent accounts', async () => {
  const [code] = await createInviteCodes({ maxUses: 1 });
  const results = await Promise.all(
    ['one@example.com', 'two@example.com'].map((email) =>
      registerUser({ ...payload, email, inviteCode: code.code }),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  expect(await mongoose.models.User.countDocuments()).toBe(1);
});

test('logout revokes the current access and refresh session without changing the user or another session', async () => {
  const user = await seedAccount();
  await setUserApprovalStatus(user._id, 'active');
  const first = await issueSession(user);
  const second = await issueSession(user);
  const before = await db.getUserById(user._id);
  expect(await authenticate(first.token)).toBeTruthy();
  const result = await logoutUser(
    {
      user,
      headers: { authorization: `Bearer ${first.token}` },
      session: { destroy: (cb) => cb() },
    },
    first.refreshToken,
  );
  expect(result.status).toBe(200);
  expect(await authenticate(first.token)).toBe(false);
  expect(await db.findSession({ userId: user._id, refreshToken: first.refreshToken })).toBeNull();
  expect(await authenticate(second.token)).toBeTruthy();
  expect(await db.getUserById(user._id)).toEqual(before);
});

test('legacy JWT logout stores only a fingerprint and rejects replay', async () => {
  const user = await seedAccount();
  await setUserApprovalStatus(user._id, 'active');
  const token = await db.generateToken(await db.getUserById(user._id));
  expect(await authenticate(token)).toBeTruthy();
  expect((await logoutUser({ user, headers: { authorization: `Bearer ${token}` } })).status).toBe(
    200,
  );
  expect(await authenticate(token)).toBe(false);
  const revoked = await mongoose.models.Token.findOne({ type: 'access_token_revocation' }).lean();
  expect(revoked.token).not.toBe(token);
});

test('administrator-issued link changes password exactly once, rejects the old password and revokes existing sessions', async () => {
  const user = await seedAccount();
  await setUserApprovalStatus(user._id, 'active');
  const session = await issueSession(user);
  checkEmailConfig.mockReturnValue(true);
  const result = await requestPasswordReset({ body: { email: payload.email } });
  const absent = await requestPasswordReset({ body: { email: 'absent@example.com' } });
  expect(result).toEqual(absent);
  expect(result.link).toBeUndefined();
  const issued = await adminReset(user._id);
  const link = new URL(issued.link);
  const token = link.searchParams.get('token');
  const stored = await mongoose.models.Token.findOne({ type: 'password_reset' }).lean();
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(sendEmail).not.toHaveBeenCalled();
  expect(stored.token).not.toBe(token);
  expect(bcrypt.compareSync(token, stored.token)).toBe(true);
  expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(900000);
  const resets = await Promise.all([
    resetPassword(String(user._id), token, 'NewPassword123!'),
    resetPassword(String(user._id), token, 'NewPassword123!'),
  ]);
  expect(resets.filter((r) => r instanceof Error)).toHaveLength(1);
  expect(await resetPassword(String(user._id), token, 'AnotherPassword123!')).toBeInstanceOf(Error);
  expect((await login()).user).toBe(false);
  expect((await login('NewPassword123!')).user.email).toBe(payload.email);
  expect(sendEmail).not.toHaveBeenCalled();
  expect(await authenticate(session.token)).toBe(false);
  expect(await db.findSession({ userId: user._id, refreshToken: session.refreshToken })).toBeNull();
});

test('expired stored reset tokens and email verification tokens cannot reset passwords', async () => {
  const user = await seedAccount();
  checkEmailConfig.mockReturnValue(true);
  await requestPasswordReset({ body: { email: payload.email } });
  const issued = await adminReset(user._id);
  const link = new URL(issued.link);
  const token = link.searchParams.get('token');
  await mongoose.models.Token.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
  expect(await resetPassword(String(user._id), token, 'NewPassword123!')).toBeInstanceOf(Error);
  await mongoose.models.Token.updateMany(
    {},
    { type: 'email_verification', expiresAt: new Date(Date.now() + 60000) },
  );
  expect(await resetPassword(String(user._id), token, 'NewPassword123!')).toBeInstanceOf(Error);
});

test('logout accepts a valid refresh session when the access token has expired', async () => {
  const requireLogoutAuth = require('~/server/middleware/requireLogoutAuth');
  const user = await seedAccount();
  await setUserApprovalStatus(user._id, 'active');
  const session = await issueSession(user);
  const current = jwt.verify(session.token, process.env.JWT_SECRET);
  const expired = jwt.sign(
    { ...current, exp: Math.floor(Date.now() / 1000) - 10 },
    process.env.JWT_SECRET,
  );
  const req = {
    headers: {
      authorization: `Bearer ${expired}`,
      cookie: `refreshToken=${session.refreshToken}; token_provider=librechat`,
    },
  };
  const result = await new Promise((resolve, reject) =>
    requireLogoutAuth(req, {}, (error) => {
      if (error) {
        reject(error);
        return;
      }
      logoutUser(req, session.refreshToken).then(resolve, reject);
    }),
  );
  expect(result.status).toBe(200);
  expect(await db.findSession({ userId: user._id, refreshToken: session.refreshToken })).toBeNull();
  expect(await authenticate(session.token)).toBe(false);
});

test('failed verification mail rolls back the account and restores the one-use registration code', async () => {
  const [code] = await createInviteCodes({ maxUses: 1 });
  checkEmailConfig.mockReturnValue(true);
  sendEmail.mockRejectedValueOnce(new Error('temporary SMTP failure'));
  expect((await registerUser({ ...payload, inviteCode: code.code })).status).toBe(500);
  expect(await db.findUser({ email: payload.email })).toBeNull();
  checkEmailConfig.mockReturnValue(false);
  expect((await registerUser({ ...payload, inviteCode: code.code })).status).toBe(200);
});

test('a failed user insert refunds its code and permits a subsequent registration', async () => {
  const [code] = await createInviteCodes({ maxUses: 1 });
  const create = jest
    .spyOn(mongoose.models.User, 'create')
    .mockRejectedValueOnce(new Error('temporary insert failure'));
  expect((await registerUser({ ...payload, inviteCode: code.code })).status).toBe(500);
  create.mockRestore();
  expect((await registerUser({ ...payload, inviteCode: code.code })).status).toBe(200);
});

test('registration rollback does not re-enable an invitation disabled by the administrator', async () => {
  const { disableInviteCode, validateInviteCode } = require('./InviteCodeService');
  const [code] = await createInviteCodes({ maxUses: 1 });
  checkEmailConfig.mockReturnValue(true);
  sendEmail.mockImplementationOnce(async () => {
    await disableInviteCode(code._id);
    throw new Error('temporary SMTP failure');
  });
  expect((await registerUser({ ...payload, inviteCode: code.code })).status).toBe(500);
  expect((await validateInviteCode(code.code)).ok).toBe(false);
});

test('a refund interleaved with the final code claim keeps remaining capacity usable', async () => {
  const {
    consumeInviteCode,
    releaseInviteCodeUse,
    validateInviteCode,
  } = require('./InviteCodeService');
  const [code] = await createInviteCodes({ maxUses: 2 });
  expect((await consumeInviteCode(code.code)).ok).toBe(true);
  const originalClaim = mongoose.models.InviteCode.findOneAndUpdate.bind(
    mongoose.models.InviteCode,
  );
  const claim = jest
    .spyOn(mongoose.models.InviteCode, 'findOneAndUpdate')
    .mockImplementationOnce(async (...args) => {
      const result = await originalClaim(...args);
      await releaseInviteCodeUse(code._id);
      return result;
    });
  expect((await consumeInviteCode(code.code)).ok).toBe(true);
  claim.mockRestore();
  const available = await validateInviteCode(code.code);
  expect(available.ok).toBe(true);
  expect(available.inviteCode.usedCount).toBe(1);
});

test('public recovery never looks up or changes accounts, generates links, or sends mail', async () => {
  const user = await seedAccount();
  checkEmailConfig.mockReturnValue(true);
  const before = await db.getUserById(user._id);
  const results = await Promise.all(
    [payload.email, 'absent@example.com', 'invalid'].map((email) =>
      requestPasswordReset({ body: { email } }),
    ),
  );
  expect(results[0]).toEqual({
    message: 'Please contact your administrator to reset your password.',
  });
  expect(results[1]).toEqual(results[0]);
  expect(results[2]).toEqual(results[0]);
  expect(await mongoose.models.Token.countDocuments({ type: 'password_reset' })).toBe(0);
  expect(await db.getUserById(user._id)).toEqual(before);
  expect(sendEmail).not.toHaveBeenCalled();
});

test('admin issuance records actor/target without raw token and replacing a link invalidates the old link', async () => {
  const user = await seedAccount();
  const issued = await adminReset(user._id);
  const actor = await db.findUser({ email: 'admin@example.com' });
  const next = await adminReset(user._id, actor);
  const oldToken = new URL(issued.link).searchParams.get('token');
  const newToken = new URL(next.link).searchParams.get('token');
  expect(oldToken).not.toBe(newToken);
  const logs = await mongoose.models.AdminAuditLog.find({
    action: 'password_reset_link_created',
  }).lean();
  expect(logs).toHaveLength(2);
  expect(String(logs[0].actorId)).toBe(String(actor._id));
  expect(String(logs[0].targetUserId)).toBe(String(user._id));
  expect(JSON.stringify(logs)).not.toContain(oldToken);
  expect(JSON.stringify(logs)).not.toContain(newToken);
  expect(await resetPassword(String(user._id), oldToken, 'NewPassword123!')).toBeInstanceOf(Error);
  expect(await resetPassword(String(user._id), newToken, 'NewPassword123!')).not.toBeInstanceOf(
    Error,
  );
  expect((await login('NewPassword123!')).user).toBe(false);
  expect((await db.getUserById(user._id)).approvalStatus).toBe('pending');
});

test.each(['pending', 'rejected', 'suspended'])(
  'reset preserves %s status and cannot enable login',
  async (status) => {
    const user = await seedAccount();
    await mongoose.models.User.updateOne({ _id: user._id }, { $set: { approvalStatus: status } });
    const issued = await adminReset(user._id);
    const token = new URL(issued.link).searchParams.get('token');
    expect(await resetPassword(String(user._id), token, 'NewPassword123!')).not.toBeInstanceOf(
      Error,
    );
    expect((await db.getUserById(user._id)).approvalStatus).toBe(status);
    expect((await login('NewPassword123!')).user).toBe(false);
  },
);

test.each([
  ['ordinary user', { role: 'USER' }, {}, 403],
  ['disabled administrator', { approvalStatus: 'suspended' }, {}, 403],
  ['privileged target', {}, { role: 'ADMIN' }, 403],
  ['super administrator target', {}, { role: 'ADMIN', isSuperAdmin: true }, 403],
  ['other tenant', { tenantId: 'tenant-a' }, { tenantId: 'tenant-b' }, 403],
  ['SSO target', {}, { provider: 'openid' }, 400],
  ['deleting target', {}, { approvalStatus: 'deleting' }, 400],
])('rejects %s before issuing a token', async (_label, actorChanges, targetChanges, status) => {
  const user = await seedAccount();
  await mongoose.models.User.updateOne({ _id: user._id }, { $set: targetChanges });
  const actor = await mongoose.models.User.create({
    email: 'actor@example.com',
    role: 'ADMIN',
    provider: 'local',
    approvalStatus: 'active',
    ...actorChanges,
  });
  await expect(adminReset(user._id, actor)).rejects.toMatchObject({ status });
  expect(await mongoose.models.Token.countDocuments({ type: 'password_reset' })).toBe(0);
});

test('rechecks current administrator role rather than trusting stale request identity', async () => {
  const user = await seedAccount();
  const actor = await mongoose.models.User.create({
    email: 'actor@example.com',
    role: 'ADMIN',
    approvalStatus: 'active',
  });
  await mongoose.models.User.updateOne({ _id: actor._id }, { $set: { role: 'USER' } });
  await expect(adminReset(user._id, actor)).rejects.toMatchObject({ status: 403 });
});

test('super administrator can issue a link for another administrator', async () => {
  const user = await seedAccount();
  await mongoose.models.User.updateOne({ _id: user._id }, { $set: { role: 'ADMIN' } });
  const actor = await mongoose.models.User.create({
    email: 'super@example.com',
    role: 'ADMIN',
    isSuperAdmin: true,
    approvalStatus: 'active',
  });
  expect((await adminReset(user._id, actor)).link).toContain('/reset-password?');
});

test('failed audit persistence prevents returning a usable reset link', async () => {
  const user = await seedAccount();
  const audit = jest
    .spyOn(mongoose.models.AdminAuditLog, 'create')
    .mockRejectedValueOnce(new Error('database unavailable'));
  try {
    await expect(adminReset(user._id)).rejects.toThrow();
    expect(await mongoose.models.Token.countDocuments({ type: 'password_reset' })).toBe(0);
  } finally {
    audit.mockRestore();
  }
});

test('explicit reset disable prevents administrator issuance', async () => {
  const user = await seedAccount();
  process.env.ALLOW_PASSWORD_RESET = 'false';
  await expect(adminReset(user._id)).rejects.toMatchObject({ status: 403 });
});

test('concurrent administrators leave exactly one usable reset credential', async () => {
  const user = await seedAccount();
  const actor = await mongoose.models.User.create({
    email: 'actor@example.com',
    role: 'ADMIN',
    approvalStatus: 'active',
  });
  const links = await Promise.all([adminReset(user._id, actor), adminReset(user._id, actor)]);
  expect(
    await mongoose.models.Token.countDocuments({ userId: user._id, type: 'password_reset' }),
  ).toBe(1);
  const results = await Promise.all(
    links.map(({ link }) =>
      resetPassword(String(user._id), new URL(link).searchParams.get('token'), 'NewPassword123!'),
    ),
  );
  expect(results.filter((r) => !(r instanceof Error))).toHaveLength(1);
});

test.each([
  { role: 'ADMIN' },
  { role: 'ADMIN', isSuperAdmin: true },
  { sessionVersion: 1 },
  { tenantId: 'other-tenant' },
])(
  'an issued credential cannot change a subsequently changed security identity: %j',
  async (changes) => {
    const user = await seedAccount();
    const issued = await adminReset(user._id);
    await mongoose.models.User.collection.updateOne({ _id: user._id }, { $set: changes });
    const result = await resetPassword(
      String(user._id),
      new URL(issued.link).searchParams.get('token'),
      'NewPassword123!',
    );
    expect(result).toBeInstanceOf(Error);
    expect(
      bcrypt.compareSync(payload.password, (await db.getUserById(user._id, '+password')).password),
    ).toBe(true);
  },
);

test('generation racing an existing link consumption leaves a usable new link', async () => {
  const user = await seedAccount();
  const first = await adminReset(user._id);
  const actor = await db.findUser({ email: 'admin@example.com' });
  const token = new URL(first.link).searchParams.get('token');
  const [_, next] = await Promise.all([
    resetPassword(String(user._id).toUpperCase(), token, 'FirstPassword123!'),
    adminReset(user._id, actor),
  ]);
  expect(
    await resetPassword(
      String(user._id),
      new URL(next.link).searchParams.get('token'),
      'FinalPassword123!',
    ),
  ).not.toBeInstanceOf(Error);
  expect(
    await mongoose.models.Token.countDocuments({ userId: user._id, type: 'password_reset' }),
  ).toBe(0);
});

test('expired mutation lease cannot leave two reset credentials or make an older link usable', async () => {
  const user = await seedAccount();
  const actor = await mongoose.models.User.create({
    email: 'actor@example.com',
    role: 'ADMIN',
    approvalStatus: 'active',
  });
  let release;
  let entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const original = mongoose.models.Token.findOneAndUpdate.bind(mongoose.models.Token);
  const audit = jest
    .spyOn(mongoose.models.Token, 'findOneAndUpdate')
    .mockImplementationOnce(async (...args) => {
      entered();
      await waiting;
      return original(...args);
    });
  const firstPromise = adminReset(user._id, actor);
  try {
    await started;
    await mongoose.models.AdminMutationLock.updateOne(
      { _id: `password-reset:${user._id}` },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const second = await adminReset(user._id, actor);
    release();
    const first = await firstPromise;
    expect(
      await mongoose.models.Token.countDocuments({ userId: user._id, type: 'password_reset' }),
    ).toBe(1);
    const results = await Promise.all(
      [first, second].map(({ link }) =>
        resetPassword(String(user._id), new URL(link).searchParams.get('token'), 'NewPassword123!'),
      ),
    );
    expect(results.filter((r) => !(r instanceof Error))).toHaveLength(1);
  } finally {
    release();
    await firstPromise;
    audit.mockRestore();
  }
});

test('an expired reset lease cleanup preserves a new link for the new password version', async () => {
  const user = await seedAccount();
  const issued = await adminReset(user._id);
  const actor = await db.findUser({ email: 'admin@example.com' });
  let release;
  let entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const original = mongoose.models.Session.deleteMany.bind(mongoose.models.Session);
  const deletion = jest
    .spyOn(mongoose.models.Session, 'deleteMany')
    .mockImplementationOnce(async (...args) => {
      entered();
      await waiting;
      return original(...args);
    });
  const first = resetPassword(
    String(user._id),
    new URL(issued.link).searchParams.get('token'),
    'FirstPassword123!',
  );
  try {
    await started;
    await mongoose.models.AdminMutationLock.updateOne(
      { _id: `password-reset:${user._id}` },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const next = await adminReset(user._id, actor);
    release();
    expect(await first).not.toBeInstanceOf(Error);
    expect(
      await resetPassword(
        String(user._id),
        new URL(next.link).searchParams.get('token'),
        'FinalPassword123!',
      ),
    ).not.toBeInstanceOf(Error);
  } finally {
    release();
    await first;
    deletion.mockRestore();
  }
});

test('a stalled older issuance cannot replace a link for the new password version', async () => {
  const user = await seedAccount();
  const issued = await adminReset(user._id);
  const actor = await db.findUser({ email: 'admin@example.com' });
  let release;
  let entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const original = mongoose.models.Token.findOneAndUpdate.bind(mongoose.models.Token);
  const writing = jest
    .spyOn(mongoose.models.Token, 'findOneAndUpdate')
    .mockImplementationOnce(async (...args) => {
      entered();
      await waiting;
      return original(...args);
    });
  const stalled = adminReset(user._id, actor).then(
    (result) => result,
    (error) => error,
  );
  try {
    await started;
    await mongoose.models.AdminMutationLock.updateOne(
      { _id: `password-reset:${user._id}` },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(
      await resetPassword(
        String(user._id),
        new URL(issued.link).searchParams.get('token'),
        'FirstPassword123!',
      ),
    ).not.toBeInstanceOf(Error);
    const current = await adminReset(user._id, actor);
    release();
    expect(await stalled).toMatchObject({ status: 409 });
    expect(
      await resetPassword(
        String(user._id),
        new URL(current.link).searchParams.get('token'),
        'FinalPassword123!',
      ),
    ).not.toBeInstanceOf(Error);
  } finally {
    release();
    await stalled;
    writing.mockRestore();
  }
});
