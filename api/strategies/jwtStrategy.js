const { logger } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const { getUserById, updateUser, findSession, findToken } = require('~/models');

const { accessTokenFingerprint } = require('~/server/utils/accessTokenFingerprint');

// JWT strategy
const jwtLogin = () =>
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET,
    },
    async (payload, done) => {
      try {
        const user = await getUserById(payload?.id, '-password -__v -totpSecret -backupCodes');
        if (user) {
          const tokenSessionVersion = Number(payload?.sessionVersion ?? 0);
          const currentSessionVersion = Number(user.sessionVersion ?? 0);
          if (tokenSessionVersion !== currentSessionVersion) {
            logger.warn('[jwtLogin] JwtStrategy => stale session version for user: ' + payload?.id);
            done(null, false, { message: 'Session invalidated' });
            return;
          }
          if (payload.sessionId) {
            const session = await findSession({ userId: payload.id, sessionId: payload.sessionId });
            if (!session) {
              return done(null, false, { message: 'Session invalidated' });
            }
          } else {
            const revoked = await findToken({
              userId: payload.id,
              type: 'access_token_revocation',
              token: accessTokenFingerprint(payload),
            });
            if (revoked && new Date(revoked.expiresAt).getTime() > Date.now()) {
              return done(null, false, { message: 'Session invalidated' });
            }
          }
          user.id = user._id.toString();
          if (!user.role) {
            user.role = SystemRoles.USER;
            await updateUser(user.id, { role: user.role });
          }
          done(null, user);
        } else {
          logger.warn('[jwtLogin] JwtStrategy => no user found: ' + payload?.id);
          done(null, false);
        }
      } catch (err) {
        done(err, false);
      }
    },
  );

module.exports = jwtLogin;
