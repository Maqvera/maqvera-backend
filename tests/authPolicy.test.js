import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePasswordPolicy } from '../utils/passwordPolicy.js';

test('validatePasswordPolicy enforces the configured password rules', () => {
  process.env.PASSWORD_MIN_LENGTH = '8';
  process.env.PASSWORD_REQUIRE_UPPERCASE = 'true';
  process.env.PASSWORD_REQUIRE_LOWERCASE = 'true';
  process.env.PASSWORD_REQUIRE_NUMBER = 'true';
  process.env.PASSWORD_REQUIRE_SPECIAL = 'true';

  const strongPassword = 'StrongPass1!';
  const weakPassword = 'weak';

  assert.deepEqual(validatePasswordPolicy(strongPassword), { valid: true, errors: [] });
  assert.deepEqual(validatePasswordPolicy(weakPassword), {
    valid: false,
    errors: [
      'Password must be at least 8 characters long.',
      'Password must include at least one uppercase letter.',
      'Password must include at least one number.',
      'Password must include at least one special character.'
    ]
  });
});
