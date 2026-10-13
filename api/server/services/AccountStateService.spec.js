const mongoose = require('mongoose');

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn() },
}));
jest.mock('librechat-data-provider', () => ({
  SystemRoles: { USER: 'USER', ADMIN: 'ADMIN' },
}));
jest.mock('@librechat/api', () => ({
  comparePassword: jest.fn(),
}));
jest.mock('~/models', () => ({
  acquireAdminMutationLock: jest.fn(async () => true),
  deleteAllUserSessions: jest.fn(),
  releaseAdminMutationLock: jest.fn(async () => true),
  updateUser: jest.fn(async (_id, update) => ({ _id, ...update })),
}));

const { releaseAdminMutationLock, updateUser } = require('~/models');
const {
  assertNotLastSuperAdmin,
  getBusinessBlock,
  getLoginBlock,
  setAccountRole,
  setAccountStatus,
} = require('./AccountStateService');

function objectId(hex) {
  return new mongoose.Types.ObjectId(hex);
}

function mockUserModel({ target, superAdminCount = 1 }) {
  mongoose.models.User = {
    findById: jest.fn(() => ({
      select: jest.fn(async () => target),
    })),
    countDocuments: jest.fn(async () => superAdminCount),
    updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
  };
  mongoose.models.AdminAuditLog = {
    create: jest.fn(async () => ({})),
  };
}

describe('AccountStateService super-admin safety', () => {
  const actor = {
    _id: objectId('64f000000000000000000001'),
    email: 'root@example.com',
    role: 'ADMIN',
    isSuperAdmin: true,
  };
  const targetSuperAdmin = {
    _id: objectId('64f000000000000000000002'),
    email: 'target@example.com',
    role: 'ADMIN',
    isSuperAdmin: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks suspending the last active super administrator', async () => {
    mockUserModel({ target: targetSuperAdmin, superAdminCount: 1 });

    await expect(
      setAccountStatus({
        actor,
        targetUserId: targetSuperAdmin._id,
        status: 'suspended',
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(updateUser).not.toHaveBeenCalled();
  });

  it('blocks downgrading the last active super administrator', async () => {
    mockUserModel({ target: targetSuperAdmin, superAdminCount: 1 });

    await expect(
      setAccountRole({
        actor,
        targetUserId: targetSuperAdmin._id,
        adminRole: 'admin',
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(updateUser).not.toHaveBeenCalled();
  });

  it('blocks self-management for administrators and super administrators', async () => {
    mockUserModel({ target: actor, superAdminCount: 2 });

    await expect(
      setAccountStatus({
        actor,
        targetUserId: actor._id,
        status: 'suspended',
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(updateUser).not.toHaveBeenCalled();
  });

  it('blocks ordinary administrators from managing themselves before super-admin checks', async () => {
    const ordinaryAdmin = {
      _id: objectId('64f000000000000000000003'),
      email: 'admin@example.com',
      role: 'ADMIN',
      isSuperAdmin: false,
    };
    mockUserModel({ target: ordinaryAdmin, superAdminCount: 2 });

    await expect(
      setAccountStatus({
        actor: ordinaryAdmin,
        targetUserId: ordinaryAdmin._id,
        status: 'suspended',
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: '不能对当前登录账号执行此操作',
    });

    expect(updateUser).not.toHaveBeenCalled();
  });

  it('allows changing a super administrator when another active super administrator remains', async () => {
    mockUserModel({ target: targetSuperAdmin, superAdminCount: 2 });

    await setAccountStatus({
      actor,
      targetUserId: targetSuperAdmin._id,
      status: 'suspended',
    });

    expect(updateUser).toHaveBeenCalledWith(
      targetSuperAdmin._id.toString(),
      expect.objectContaining({ approvalStatus: 'suspended' }),
    );
  });

  it('does not mask a completed mutation when releasing the database lock fails', async () => {
    mockUserModel({ target: targetSuperAdmin, superAdminCount: 2 });
    releaseAdminMutationLock.mockRejectedValueOnce(new Error('temporary network error'));

    await expect(
      setAccountStatus({
        actor,
        targetUserId: targetSuperAdmin._id,
        status: 'suspended',
      }),
    ).resolves.toEqual(expect.objectContaining({ approvalStatus: 'suspended' }));

    expect(updateUser).toHaveBeenCalledWith(
      targetSuperAdmin._id.toString(),
      expect.objectContaining({ approvalStatus: 'suspended' }),
    );
  });

  it('exposes the same last-super-admin guard for deletion orchestration', async () => {
    mockUserModel({ target: targetSuperAdmin, superAdminCount: 1 });

    await expect(assertNotLastSuperAdmin(targetSuperAdmin)).rejects.toMatchObject({ status: 400 });
  });
});

describe('AccountStateService business status gates', () => {
  const pendingUser = {
    _id: objectId('64f000000000000000000004'),
    email: 'pending@example.com',
    role: 'USER',
    approvalStatus: 'pending',
  };

  function requestFor(method, originalUrl) {
    return { method, originalUrl, user: pendingUser };
  }

  it('allows only explicit safe endpoints for accounts awaiting approval', () => {
    expect(getBusinessBlock(requestFor('POST', '/api/auth/logout'))).toBeNull();
    expect(getBusinessBlock(requestFor('GET', '/api/user'))).toBeNull();
    expect(getBusinessBlock(requestFor('GET', '/api/user?refresh=true'))).toBeNull();

    expect(getBusinessBlock(requestFor('POST', '/api/user/plugins'))).toMatchObject({
      approvalStatus: 'pending',
    });
    expect(getBusinessBlock(requestFor('POST', '/api/user/settings/favorites'))).toMatchObject({
      approvalStatus: 'pending',
    });
    expect(getBusinessBlock(requestFor('POST', '/api/user/terms/accept'))).toMatchObject({
      approvalStatus: 'pending',
    });
  });
});

test.each(['pending', 'rejected', 'suspended', 'deleting'])(
  'blocks %s users at login',
  (approvalStatus) => {
    expect(getLoginBlock({ approvalStatus })).toMatchObject({ approvalStatus });
  },
);
test('approved users can log in', () => {
  expect(getLoginBlock({ approvalStatus: 'active' })).toBeNull();
});
