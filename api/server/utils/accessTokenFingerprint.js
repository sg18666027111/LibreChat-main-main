const { createHash } = require('node:crypto');

// The verified payload identifies legacy JWTs without storing usable bearer tokens.
const accessTokenFingerprint = (payload) =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');

module.exports = { accessTokenFingerprint };
