jest.mock('@librechat/api', () => ({
  isEnabled: (value) => value === 'true',
  checkEmailConfig: jest.fn(() => true),
}));
const { checkEmailConfig } = require('@librechat/api');
const { registrationEnabled, passwordResetEnabled } = require('./authConfig');
const validateRegistration = require('../middleware/validateRegistration');
const validatePasswordReset = require('../middleware/validatePasswordReset');
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});
test('registration defaults on and agrees with its API gate', () => {
  delete process.env.ALLOW_REGISTRATION;
  expect(registrationEnabled()).toBe(true);
  const next = jest.fn();
  validateRegistration({}, {}, next);
  expect(next).toHaveBeenCalled();
});
test('explicit registration disable is respected', () => {
  process.env.ALLOW_REGISTRATION = 'false';
  expect(registrationEnabled()).toBe(false);
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  validateRegistration({}, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});
test('mail-ready installations expose password reset and allow the API by default', () => {
  delete process.env.ALLOW_PASSWORD_RESET;
  checkEmailConfig.mockReturnValue(true);
  expect(passwordResetEnabled()).toBe(true);
  const next = jest.fn();
  validatePasswordReset({}, {}, next);
  expect(next).toHaveBeenCalled();
});
test('explicit password reset disable is respected', () => {
  process.env.ALLOW_PASSWORD_RESET = 'false';
  expect(passwordResetEnabled()).toBe(false);
});
test('administrator-assisted recovery works without email configuration', () => {
  delete process.env.ALLOW_PASSWORD_RESET;
  checkEmailConfig.mockReturnValue(false);
  expect(passwordResetEnabled()).toBe(true);
  const next = jest.fn();
  validatePasswordReset({}, {}, next);
  expect(next).toHaveBeenCalled();
});
