const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

/** Completes the existing optional Turnstile challenge on the server. */
async function verifyRegistrationCaptcha(config, token) {
  if (!config?.siteKey) {
    return true;
  }
  if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
    return false;
  }
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    logger.error('[registration] Turnstile enabled without TURNSTILE_SECRET_KEY');
    return false;
  }
  try {
    const { data } = await axios.post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { secret, response: token },
      { timeout: 5000 },
    );
    return data?.success === true;
  } catch {
    // Axios error objects include the secret and challenge in request data.
    logger.warn('[registration] Turnstile verification unavailable');
    return false;
  }
}

module.exports = { verifyRegistrationCaptcha };
