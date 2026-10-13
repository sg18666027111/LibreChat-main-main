const cookies = require('cookie');
const jwt = require('jsonwebtoken');
const { tenantContextMiddleware } = require('@librechat/api');
const { findSession, getUserById } = require('~/models');
const requireJwtAuth = require('./requireJwtAuth');

/** A valid refresh session can authorize its own logout after its access JWT expires. */
async function requireLogoutAuth(req, res, next) {
  const parsed = req.headers.cookie ? cookies.parse(req.headers.cookie) : {};
  if (parsed.refreshToken && parsed.token_provider !== 'openid') {
    let payload;
    try {
      payload = jwt.verify(parsed.refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      return requireJwtAuth(req, res, next);
    }
    try {
      const session = await findSession({ userId: payload.id, refreshToken: parsed.refreshToken });
      const user = session
        ? await getUserById(payload.id, '-password -totpSecret -backupCodes')
        : null;
      if (user) {
        req.user = user;
        req.authStrategy = 'jwt';
        req.logoutSession = session;
        return tenantContextMiddleware(req, res, next);
      }
    } catch (error) {
      return next(error);
    }
  }
  return requireJwtAuth(req, res, next);
}

module.exports = requireLogoutAuth;
