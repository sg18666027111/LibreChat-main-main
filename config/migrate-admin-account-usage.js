const path = require('path');
const mongoose = require('mongoose');
const { createModels, createMethods } = require('../packages/data-schemas');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');

(async () => {
  await connect();
  createModels(mongoose);
  const methods = createMethods(mongoose);
  const result = await methods.runAdminAccountBackfill();
  console.log(
    JSON.stringify(
      {
        activeStatus: result.activeStatus,
        legacyDisabledStatus: result.legacyDisabledStatus,
        role: result.role,
        isSuperAdmin: result.isSuperAdmin,
        sessionVersion: result.sessionVersion,
        reportingSubjectId: result.reportingSubjectId,
        indexesEnsured: result.indexesEnsured,
        completedAt: result.completedAt,
      },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error('Admin account usage migration failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
