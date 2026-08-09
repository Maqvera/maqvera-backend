import test from 'node:test';
import assert from 'node:assert/strict';
import { userSchemas } from '../middleware/validateRequest.js';

test('userSchemas.createUser validates a complete payload', () => {
  const result = userSchemas.createUser.validate({
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    departmentId: 'dept-1',
    roleIds: ['role-1'],
    designation: 'Manager'
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.firstName, 'Jane');
  assert.equal(result.value.email, 'jane@example.com');
});

test('userSchemas.createUser rejects invalid email and missing department', () => {
  const result = userSchemas.createUser.validate({
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'not-an-email',
    roleIds: ['role-1']
  }, { abortEarly: false });

  assert.ok(result.error);
  assert.match(result.error.message, /departmentId/);
  assert.match(result.error.message, /email/);
});
