const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const { createModels } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');

let mongoServer;
let service;

function objectId(hex) {
  return new mongoose.Types.ObjectId(hex);
}

async function createSuperAdmin({ _id, email }) {
  return mongoose.models.User.create({
    _id,
    email,
    name: email.split('@')[0],
    provider: 'local',
    role: SystemRoles.ADMIN,
    isSuperAdmin: true,
    approvalStatus: 'active',
    reportingSubjectId: `usr_${_id.toString().slice(-8)}`,
    sessionVersion: 0,
  });
}

describe('AccountStateService cross-process super-admin safety', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    service = require('./AccountStateService');
    await require('~/models').ensureAdminAccountStorage();
  });

  afterEach(async () => {
    await Promise.all(
      Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})),
    );
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('serializes two independent super-admin mutations so at least one active super admin remains', async () => {
    const first = await createSuperAdmin({
      _id: objectId('64f200000000000000000001'),
      email: 'root-one@example.com',
    });
    const second = await createSuperAdmin({
      _id: objectId('64f200000000000000000002'),
      email: 'root-two@example.com',
    });

    const results = await Promise.allSettled([
      service.setAccountStatus({
        actor: first.toObject(),
        targetUserId: second._id,
        status: 'suspended',
      }),
      service.setAccountStatus({
        actor: second.toObject(),
        targetUserId: first._id,
        status: 'suspended',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({
      status: 400,
    });

    const activeSuperAdmins = await mongoose.models.User.countDocuments({
      role: SystemRoles.ADMIN,
      isSuperAdmin: true,
      approvalStatus: 'active',
    });
    const locks = await mongoose.models.AdminMutationLock.countDocuments({});

    expect(activeSuperAdmins).toBe(1);
    expect(locks).toBe(0);
  });
});
