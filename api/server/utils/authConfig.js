const { isEnabled } = require('@librechat/api');

const registrationEnabled = () =>
  process.env.ALLOW_REGISTRATION === undefined || isEnabled(process.env.ALLOW_REGISTRATION);

const passwordResetEnabled = () =>
  process.env.ALLOW_PASSWORD_RESET === undefined || isEnabled(process.env.ALLOW_PASSWORD_RESET);

module.exports = { registrationEnabled, passwordResetEnabled };
