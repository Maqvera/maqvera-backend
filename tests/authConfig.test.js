import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuthConfig } from '../utils/authConfig.js';

test('getAuthConfig returns environment-driven auth settings', () => {
  process.env.ACCESS_TOKEN_EXPIRES_IN = '20m';
  process.env.REFRESH_TOKEN_EXPIRES_IN = '45d';
  process.env.EMAIL_FROM_NAME = 'MAQVERA';
  process.env.EMAIL_FROM = 'alerts@example.com';
  process.env.FRONTEND_URL = 'https://app.example.com';
  process.env.LOGIN_LOCKOUT_MINUTES = '12';
  process.env.PASSWORD_RESET_TTL_HOURS = '3';

  const config = getAuthConfig();

  assert.equal(config.accessTokenExpiresIn, '20m');
  assert.equal(config.refreshTokenExpiresIn, '45d');
  assert.equal(config.emailFrom, 'MAQVERA <alerts@example.com>');
  assert.equal(config.frontendUrl, 'https://app.example.com');
  assert.equal(config.loginLockoutMinutes, 12);
  assert.equal(config.passwordResetTtlHours, 3);
});
