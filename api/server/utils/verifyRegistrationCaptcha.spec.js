jest.mock('axios', () => ({ post: jest.fn() }));
const axios = require('axios');
const { verifyRegistrationCaptcha } = require('./verifyRegistrationCaptcha');
const config = { siteKey: 'public-key' };
const savedSecret = process.env.TURNSTILE_SECRET_KEY;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.TURNSTILE_SECRET_KEY = 'test-secret';
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = savedSecret;
});
test.each([undefined, '', ' ', 123, 'x'.repeat(2049)])(
  'rejects missing or invalid challenge %p',
  async (token) => {
    expect(await verifyRegistrationCaptcha(config, token)).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  },
);
test.each(['invalid-input-response', 'timeout-or-duplicate'])(
  'rejects invalid, expired or replayed challenges (%s)',
  async (reason) => {
    axios.post.mockResolvedValue({ data: { success: false, 'error-codes': [reason] } });
    expect(await verifyRegistrationCaptcha(config, 'test-challenge')).toBe(false);
  },
);
test('accepts only an affirmative provider verification', async () => {
  axios.post.mockResolvedValue({ data: { success: true } });
  expect(await verifyRegistrationCaptcha(config, 'test-challenge')).toBe(true);
  expect(axios.post).toHaveBeenCalledWith(
    expect.stringContaining('/siteverify'),
    { secret: 'test-secret', response: 'test-challenge' },
    { timeout: 5000 },
  );
});
test('fails closed on outage or missing secret', async () => {
  axios.post.mockRejectedValue(new Error('timeout'));
  expect(await verifyRegistrationCaptcha(config, 'test-challenge')).toBe(false);
  delete process.env.TURNSTILE_SECRET_KEY;
  expect(await verifyRegistrationCaptcha(config, 'test-challenge')).toBe(false);
});
test('keeps the existing optional Turnstile setting', async () => {
  expect(await verifyRegistrationCaptcha(undefined, undefined)).toBe(true);
  expect(axios.post).not.toHaveBeenCalled();
});
