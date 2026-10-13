// No application setupFiles: never load .env.test, .env, or application database setup.
module.exports = {
  rootDir: '../../../../..',
  testEnvironment: 'node',
  testMatch: ['**/batchAsyncRecovery.mongo.spec.js'],
  testTimeout: 60000,
  setupFiles: [],
};
