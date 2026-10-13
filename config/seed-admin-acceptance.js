const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { createModels } = require('../packages/data-schemas');

const ACCEPTANCE_DB = 'librechat_admin_acceptance';
const DEFAULT_URI = `mongodb://127.0.0.1:27037/${ACCEPTANCE_DB}`;

function assertLocalAcceptanceUri(uri) {
  const parsed = new URL(uri);
  const host = parsed.hostname;
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    throw new Error('Acceptance seed refuses non-local MongoDB hosts.');
  }
  if (dbName !== ACCEPTANCE_DB) {
    throw new Error(`Acceptance seed requires database name ${ACCEPTANCE_DB}.`);
  }
}

function getPassword() {
  const password = process.env.ADMIN_ACCEPTANCE_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error(
      'Set ADMIN_ACCEPTANCE_PASSWORD to a local test password with at least 12 chars.',
    );
  }
  return password;
}

function createReportingSubjectId() {
  return `usr_${crypto.randomUUID().replace(/-/g, '')}`;
}

async function upsertUser(User, input, passwordHash) {
  return User.findOneAndUpdate(
    { email: input.email },
    {
      $set: {
        name: input.name,
        username: input.username,
        email: input.email,
        provider: 'local',
        role: input.role,
        isSuperAdmin: input.isSuperAdmin,
        approvalStatus: input.approvalStatus,
        emailVerified: true,
        password: passwordHash,
        sessionVersion: 0,
      },
      $setOnInsert: {
        reportingSubjectId: input.reportingSubjectId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function main() {
  const mongoUri = process.env.MONGO_URI || DEFAULT_URI;
  assertLocalAcceptanceUri(mongoUri);

  await mongoose.connect(mongoUri);
  createModels(mongoose);

  if (process.argv.includes('--clean')) {
    await mongoose.connection.dropDatabase();
    console.log(`Cleaned local acceptance database ${ACCEPTANCE_DB}.`);
    await mongoose.disconnect();
    return;
  }

  const passwordHash = bcrypt.hashSync(getPassword(), 10);
  const User = mongoose.models.User;
  const users = [
    {
      email: 'acceptance.super@example.test',
      name: 'Acceptance Super Admin',
      username: 'acceptance-super',
      role: 'ADMIN',
      isSuperAdmin: true,
      approvalStatus: 'active',
      reportingSubjectId: createReportingSubjectId(),
    },
    {
      email: 'acceptance.admin@example.test',
      name: 'Acceptance Admin',
      username: 'acceptance-admin',
      role: 'ADMIN',
      isSuperAdmin: false,
      approvalStatus: 'active',
      reportingSubjectId: createReportingSubjectId(),
    },
    {
      email: 'acceptance.employee1@example.test',
      name: 'Acceptance Employee One',
      username: 'acceptance-employee1',
      role: 'USER',
      isSuperAdmin: false,
      approvalStatus: 'active',
      reportingSubjectId: createReportingSubjectId(),
    },
    {
      email: 'acceptance.employee2@example.test',
      name: 'Acceptance Employee Two',
      username: 'acceptance-employee2',
      role: 'USER',
      isSuperAdmin: false,
      approvalStatus: 'active',
      reportingSubjectId: createReportingSubjectId(),
    },
    {
      email: 'acceptance.pending@example.test',
      name: 'Acceptance Pending',
      username: 'acceptance-pending',
      role: 'USER',
      isSuperAdmin: false,
      approvalStatus: 'pending',
      reportingSubjectId: createReportingSubjectId(),
    },
    {
      email: 'acceptance.delete@example.test',
      name: 'Acceptance Delete Target',
      username: 'acceptance-delete',
      role: 'USER',
      isSuperAdmin: false,
      approvalStatus: 'active',
      reportingSubjectId: createReportingSubjectId(),
    },
  ];

  for (const user of users) {
    await upsertUser(User, user, passwordHash);
  }

  console.log(
    JSON.stringify(
      {
        database: ACCEPTANCE_DB,
        users: users.map(({ email, role, isSuperAdmin, approvalStatus }) => ({
          email,
          role,
          isSuperAdmin,
          approvalStatus,
        })),
        password: 'ADMIN_ACCEPTANCE_PASSWORD environment variable',
        cleanup: 'npm run seed:admin-acceptance -- --clean',
      },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
