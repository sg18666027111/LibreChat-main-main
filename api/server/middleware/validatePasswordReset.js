const { passwordResetEnabled } = require('~/server/utils/authConfig');
const { logger } = require('@librechat/data-schemas');

function validatePasswordReset(req, res, next) {
  if (passwordResetEnabled()) {
    next();
  } else {
    logger.warn(`Password reset attempt while not allowed. IP: ${req.ip}`);
    res.status(403).send('Password reset is not allowed.');
  }
}

module.exports = validatePasswordReset;
