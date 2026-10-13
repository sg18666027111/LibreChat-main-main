const { registrationEnabled } = require('~/server/utils/authConfig');

function validateRegistration(req, res, next) {
  if (req.invite) {
    return next();
  }

  if (registrationEnabled()) {
    next();
  } else {
    return res.status(403).json({
      message: 'Registration is not allowed.',
    });
  }
}

module.exports = validateRegistration;
