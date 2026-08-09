import test from 'node:test';
import assert from 'node:assert/strict';
import { getCustomerConfig } from '../utils/customerConfig.js';
import { customerSchemas } from '../middleware/validateRequest.js';

test('getCustomerConfig reads customer defaults from environment variables', () => {
  process.env.DEFAULT_CUSTOMER_CATEGORY = 'premium';
  process.env.DEFAULT_CUSTOMER_STATUS = 'lead';
  process.env.DEFAULT_CUSTOMER_LANGUAGE = 'ur';
  process.env.DEFAULT_CUSTOMER_CURRENCY = 'PKR';
  process.env.DEFAULT_CUSTOMER_TIMEZONE = 'Asia/Karachi';

  const config = getCustomerConfig();

  assert.equal(config.defaultCategory, 'premium');
  assert.equal(config.defaultStatus, 'lead');
  assert.equal(config.defaultLanguage, 'ur');
  assert.equal(config.defaultCurrency, 'PKR');
  assert.equal(config.defaultTimezone, 'Asia/Karachi');
});

test('customerSchemas.createCustomer validates a complete customer payload', () => {
  const result = customerSchemas.createCustomer.validate({
    firstName: 'Aisha',
    lastName: 'Khan',
    primaryEmail: 'aisha@example.com',
    primaryPhone: '+923001234567'
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.firstName, 'Aisha');
  assert.equal(result.value.primaryEmail, 'aisha@example.com');
});

test('customerSchemas.createCustomer preserves contract fields for customer type and language references', () => {
  const result = customerSchemas.createCustomer.validate({
    firstName: 'Aisha',
    lastName: 'Khan',
    primaryEmail: 'aisha@example.com',
    primaryPhone: '+923001234567',
    customerType: 'Individual',
    nationalityId: 'country-123',
    preferredLanguageId: 'ur'
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.customerType, 'Individual');
  assert.equal(result.value.nationalityId, 'country-123');
  assert.equal(result.value.preferredLanguageId, 'ur');
});

test('customerSchemas.createCustomer rejects invalid contact data', () => {
  const result = customerSchemas.createCustomer.validate({
    firstName: 'Aisha',
    lastName: 'Khan',
    primaryEmail: 'not-an-email',
    primaryPhone: ''
  }, { abortEarly: false });

  assert.ok(result.error);
  assert.match(result.error.message, /primaryEmail/);
  assert.match(result.error.message, /primaryPhone/);
});

test('getCustomerConfig reads note and preference defaults from environment variables', () => {
  process.env.DEFAULT_CUSTOMER_NOTE_CATEGORY = 'Operations';
  process.env.DEFAULT_CUSTOMER_NOTE_VISIBILITY = 'Management';
  process.env.DEFAULT_CUSTOMER_MEAL_PREFERENCE = 'vegetarian';
  process.env.DEFAULT_CUSTOMER_SEAT_PREFERENCE = 'aisle';
  process.env.DEFAULT_CUSTOMER_NOTIFICATION_PREFERENCES = JSON.stringify({ email: false, sms: true, whatsapp: false, push: true });

  const config = getCustomerConfig();

  assert.equal(config.defaultNoteCategory, 'Operations');
  assert.equal(config.defaultNoteVisibility, 'Management');
  assert.equal(config.defaultMealPreference, 'vegetarian');
  assert.equal(config.defaultSeatPreference, 'aisle');
  assert.deepEqual(config.defaultNotificationPreferences, { email: false, sms: true, whatsapp: false, push: true });
});

test('customerSchemas.updateCustomer strips traveler-specific fields that should be handled by dedicated endpoints', () => {
  const result = customerSchemas.updateCustomer.validate({
    firstName: 'Aisha',
    passports: [{ passportNumber: 'ABC123' }],
    emergencyContacts: [{ name: 'Ali' }]
  }, { abortEarly: false });

  assert.equal(result.error, undefined);
  assert.equal(result.value.passports, undefined);
  assert.equal(result.value.emergencyContacts, undefined);
  assert.equal(result.value.firstName, 'Aisha');
});

test('getCustomerConfig reads dynamic note and document storage defaults from environment variables', () => {
  process.env.CUSTOMER_ALLOWED_NOTE_CATEGORIES = 'Support,Medical';
  process.env.CUSTOMER_ALLOWED_NOTE_VISIBILITIES = 'Private,Management';
  process.env.DOCUMENT_STORAGE_BACKEND = 's3';
  process.env.DOCUMENT_STORAGE_PROVIDER = 'AWS S3';

  const config = getCustomerConfig();

  assert.deepEqual(config.allowedNoteCategories, ['Support', 'Medical']);
  assert.deepEqual(config.allowedNoteVisibilities, ['Private', 'Management']);
  assert.equal(config.documentStorageBackend, 's3');
  assert.equal(config.defaultDocumentStorageProvider, 'AWS S3');
});
