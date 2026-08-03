import test from 'node:test';
import assert from 'node:assert/strict';
import { customerSchemas } from '../middleware/validateRequest.js';

test('customer emergency contact schema validates the expected contract fields', () => {
  const { error, value } = customerSchemas.customerEmergencyContact.validate({
    name: 'Fatima Ahmed',
    relationship: 'Wife',
    phone: '+923001112233',
    email: 'fatima@example.com',
    country: 'Pakistan',
    priority: 1,
    preferredContactMethod: 'whatsapp',
    isPrimary: true
  });

  assert.equal(error, undefined);
  assert.equal(value.name, 'Fatima Ahmed');
  assert.equal(value.relationship, 'Wife');
  assert.equal(value.isPrimary, true);
});

test('customer emergency contact schema rejects missing required fields', () => {
  const { error } = customerSchemas.customerEmergencyContact.validate({
    relationship: 'Wife',
    phone: '+923001112233'
  });

  assert.ok(error);
  assert.match(error.message, /name/);
});
