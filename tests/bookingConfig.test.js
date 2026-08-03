import test from 'node:test';
import assert from 'node:assert/strict';
import { getBookingConfig } from '../utils/bookingConfig.js';

test('getBookingConfig returns environment-driven booking defaults', () => {
  const previous = {
    DEFAULT_BRANCH_ID: process.env.DEFAULT_BRANCH_ID,
    DEFAULT_CURRENCY: process.env.DEFAULT_CURRENCY,
    DEFAULT_BOOKING_TYPE: process.env.DEFAULT_BOOKING_TYPE,
    DEFAULT_BOOKING_STATUS: process.env.DEFAULT_BOOKING_STATUS,
    DEFAULT_BOOKING_PRIORITY: process.env.DEFAULT_BOOKING_PRIORITY,
    DEFAULT_PAYMENT_STATUS: process.env.DEFAULT_PAYMENT_STATUS,
    DEFAULT_VISA_STATUS: process.env.DEFAULT_VISA_STATUS
  };

  try {
    process.env.DEFAULT_BRANCH_ID = 'DUBAI';
    process.env.DEFAULT_CURRENCY = 'AED';
    process.env.DEFAULT_BOOKING_TYPE = 'custom_package';
    process.env.DEFAULT_BOOKING_STATUS = 'quotation';
    process.env.DEFAULT_BOOKING_PRIORITY = 'high';
    process.env.DEFAULT_PAYMENT_STATUS = 'partially_paid';
    process.env.DEFAULT_VISA_STATUS = 'submitted';

    const config = getBookingConfig();
    assert.equal(config.defaultBranchId, 'DUBAI');
    assert.equal(config.defaultCurrency, 'AED');
    assert.equal(config.defaultBookingType, 'custom_package');
    assert.equal(config.defaultBookingStatus, 'quotation');
    assert.equal(config.defaultPriority, 'high');
    assert.equal(config.defaultPaymentStatus, 'partially_paid');
    assert.equal(config.defaultVisaStatus, 'submitted');
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});
