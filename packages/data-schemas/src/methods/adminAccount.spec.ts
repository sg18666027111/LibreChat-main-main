import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { createMethods } from './index';
import { normalizeEmailForBlocklist } from './adminAccount';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterEach(async () => {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB connection was not initialized');
  }
  await db.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('admin account migration and blocklist methods', () => {
  it('runs against an empty database and only ensures storage', async () => {
    const result = await methods.runAdminAccountBackfill();

    expect(result.indexesEnsured).toBe(true);
    expect(result.activeStatus.modifiedCount).toBe(0);
    expect(result.reportingSubjectId.modifiedCount).toBe(0);
  });

  it('initializes legacy users without changing existing pending users', async () => {
    const users = mongoose.connection.collection('users');
    await users.insertMany([
      { email: 'legacy-active@example.com', provider: 'local' },
      {
        email: 'pending@example.com',
        provider: 'local',
        approvalStatus: 'pending',
        role: 'USER',
        isSuperAdmin: false,
        sessionVersion: 5,
        reportingSubjectId: 'usr_existing',
      },
      {
        email: 'partial@example.com',
        provider: 'local',
        approvalStatus: 'active',
        reportingSubjectId: 'usr_partial',
      },
    ]);

    const result = await methods.runAdminAccountBackfill({
      createReportingId: () => 'usr_generated',
    });

    expect(result.activeStatus.modifiedCount).toBe(1);
    expect(result.reportingSubjectId.modifiedCount).toBe(1);

    const legacy = await users.findOne({ email: 'legacy-active@example.com' });
    const pending = await users.findOne({ email: 'pending@example.com' });
    const partial = await users.findOne({ email: 'partial@example.com' });

    expect(legacy).toEqual(
      expect.objectContaining({
        approvalStatus: 'active',
        role: 'USER',
        isSuperAdmin: false,
        sessionVersion: 0,
        reportingSubjectId: 'usr_generated',
      }),
    );
    expect(pending?.approvalStatus).toBe('pending');
    expect(partial).toEqual(
      expect.objectContaining({
        approvalStatus: 'active',
        role: 'USER',
        isSuperAdmin: false,
        sessionVersion: 0,
        reportingSubjectId: 'usr_partial',
      }),
    );
  });

  it('is repeatable and does not modify users on a second run', async () => {
    const users = mongoose.connection.collection('users');
    await users.insertOne({ email: 'legacy@example.com', provider: 'local' });

    await methods.runAdminAccountBackfill({ createReportingId: () => 'usr_repeatable' });
    const second = await methods.runAdminAccountBackfill({ createReportingId: () => 'usr_unused' });

    expect(second.activeStatus.modifiedCount).toBe(0);
    expect(second.reportingSubjectId.modifiedCount).toBe(0);
    const user = await users.findOne({ email: 'legacy@example.com' });
    expect(user?.reportingSubjectId).toBe('usr_repeatable');
  });

  it('retries reportingSubjectId generation after a unique index collision', async () => {
    const users = mongoose.connection.collection('users');
    await users.insertMany([
      { email: 'has-id@example.com', provider: 'local', reportingSubjectId: 'usr_collision' },
      { email: 'needs-id@example.com', provider: 'local' },
    ]);

    const ids = ['usr_collision', 'usr_after_collision'];
    await methods.runAdminAccountBackfill({ createReportingId: () => ids.shift() as string });

    const user = await users.findOne({ email: 'needs-id@example.com' });
    expect(user?.reportingSubjectId).toBe('usr_after_collision');
  });

  it('creates deletion jobs idempotently and records step progress', async () => {
    const targetUserId = new mongoose.Types.ObjectId();
    const createdBy = new mongoose.Types.ObjectId();

    const first = await methods.createUserDeletionJob({
      targetReportingSubjectId: 'usr_delete_me',
      targetUserId,
      targetEmailNormalized: 'delete@example.com',
      createdBy,
    });
    const duplicate = await methods.createUserDeletionJob({
      targetReportingSubjectId: 'usr_delete_me',
      targetUserId,
      targetEmailNormalized: 'delete@example.com',
      createdBy,
    });

    expect(String(duplicate?._id)).toBe(String(first?._id));
    await methods.setUserDeletionJobStep({
      jobId: first._id,
      step: 'files',
      status: 'succeeded',
      count: 2,
    });
    const updated = await methods.setUserDeletionJobStep({
      jobId: first._id,
      step: 'files',
      status: 'succeeded',
      count: 3,
    });

    expect(updated?.stepResults).toHaveLength(1);
    expect(updated?.stepResults[0]).toEqual(expect.objectContaining({ step: 'files', count: 3 }));
  });

  it('retains non-completed deletion jobs until an operator can retry them', async () => {
    const targetUserId = new mongoose.Types.ObjectId();
    const createdBy = new mongoose.Types.ObjectId();

    const created = await methods.createUserDeletionJob({
      targetReportingSubjectId: 'usr_retryable',
      targetUserId,
      targetEmailNormalized: 'retry@example.com',
      createdBy,
    });
    expect(created?.expiresAt).toBeUndefined();

    const running = await methods.setUserDeletionJobRunning(created._id);
    expect(running?.status).toBe('running');
    expect(running?.expiresAt).toBeUndefined();

    const failed = await methods.failUserDeletionJob(
      created._id,
      new Error('storage failed'),
      'files',
    );
    expect(failed?.status).toBe('failed');
    expect(failed?.expiresAt).toBeUndefined();

    const completed = await methods.completeUserDeletionJob(created._id);
    expect(completed?.status).toBe('completed');
    expect(completed?.targetUserId).toBeNull();
    expect(completed?.expiresAt).toBeInstanceOf(Date);
  });

  it('blocks, matches, and unblocks normalized emails without a TTL index', async () => {
    await methods.upsertEmailBlock({
      email: ' Deleted.User+Test@Example.COM ',
      reportingSubjectId: 'usr_blocked',
    });

    expect(await methods.isEmailBlocked('deleted.user+test@example.com')).toBe(true);
    await methods.unblockEmail('DELETED.USER+TEST@example.com', new mongoose.Types.ObjectId());
    expect(await methods.isEmailBlocked('deleted.user+test@example.com')).toBe(false);

    const indexes = await mongoose.connection.collection('emailblocklists').indexes();
    expect(indexes.some((index) => index.expireAfterSeconds != null)).toBe(false);
  });

  it('canonicalizes Unicode domains and rejects invisible email bypass characters', async () => {
    await methods.upsertEmailBlock({
      email: ' Usér@Exämple.COM ',
      reportingSubjectId: 'usr_unicode_blocked',
    });

    expect(normalizeEmailForBlocklist('Use\u0301r@xn--exmple-cua.com')).toBe(
      'usér@xn--exmple-cua.com',
    );
    expect(await methods.isEmailBlocked('Use\u0301r@xn--exmple-cua.com')).toBe(true);

    expect(() => normalizeEmailForBlocklist('blocked\u200b@example.com')).toThrow(
      /Email contains unsupported characters/,
    );
    await expect(methods.isEmailBlocked('blocked\u200b@example.com')).resolves.toBe(true);
  });

  it('uses a database lease for cross-process admin mutation locks', async () => {
    const first = await methods.acquireAdminMutationLock({
      key: 'super-admin:tenant:acme',
      ownerId: 'process-a',
      leaseMs: 30_000,
      now: new Date('2026-07-31T00:00:00.000Z'),
    });
    const second = await methods.acquireAdminMutationLock({
      key: 'super-admin:tenant:acme',
      ownerId: 'process-b',
      leaseMs: 30_000,
      now: new Date('2026-07-31T00:00:01.000Z'),
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    await expect(
      methods.releaseAdminMutationLock('super-admin:tenant:acme', 'process-b'),
    ).resolves.toBe(false);
    await expect(
      methods.releaseAdminMutationLock('super-admin:tenant:acme', 'process-a'),
    ).resolves.toBe(true);
    await expect(
      methods.acquireAdminMutationLock({
        key: 'super-admin:tenant:acme',
        ownerId: 'process-b',
        leaseMs: 30_000,
      }),
    ).resolves.toBe(true);
  });

  it('allows a different process to acquire an expired admin mutation lease', async () => {
    await methods.acquireAdminMutationLock({
      key: 'super-admin:default',
      ownerId: 'process-a',
      leaseMs: 1000,
      now: new Date('2026-07-31T00:00:00.000Z'),
    });

    await expect(
      methods.acquireAdminMutationLock({
        key: 'super-admin:default',
        ownerId: 'process-b',
        leaseMs: 1000,
        now: new Date('2026-07-31T00:00:02.000Z'),
      }),
    ).resolves.toBe(true);
  });
});
