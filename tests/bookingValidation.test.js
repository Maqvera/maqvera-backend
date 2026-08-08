import test from 'node:test';
import assert from 'node:assert/strict';
import { getBookingConfig } from '../utils/bookingConfig.js';

test('bookingSchemas.createBooking accepts a valid booking payload', async () => {
  const { bookingSchemas } = await import('../middleware/validateRequest.js');
  const result = bookingSchemas.createBooking.validate({
    customerId: '507f1f77bcf86cd799439011',
    bookingType: 'umrah',
    travelDate: '2026-12-01',
    currencyId: 'USD',
    totalAmount: 1500
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.bookingType, 'umrah');
  assert.equal(result.value.currencyId, 'USD');
});

test('bookingSchemas.createBooking rejects missing customerId and invalid bookingType', async () => {
  const { bookingSchemas } = await import('../middleware/validateRequest.js');
  const result = bookingSchemas.createBooking.validate({
    bookingType: 'invalid'
  }, { abortEarly: false });

  assert.ok(result.error);
  assert.match(result.error.message, /customerId/);
  assert.match(result.error.message, /bookingType/);
});

test('bookingSchemas.updateBooking accepts editable-field updates', async () => {
  const { bookingSchemas } = await import('../middleware/validateRequest.js');
  const result = bookingSchemas.updateBooking.validate({
    priority: 'high',
    remarks: 'Customer requested early check-in.'
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.priority, 'high');
});

test('bookingSchemas.updateBooking rejects status/paymentStatus/totalAmount (Section 31 editable-fields list excludes them — status changes go through PATCH /bookings/{id}/workflow)', async () => {
  const { bookingSchemas } = await import('../middleware/validateRequest.js');
  const result = bookingSchemas.updateBooking.validate({
    status: 'confirmed',
    paymentStatus: 'partially_paid',
    totalAmount: 5000
  }, { abortEarly: false });

  assert.ok(result.error);
  assert.match(result.error.message, /status/);
  assert.match(result.error.message, /paymentStatus/);
  assert.match(result.error.message, /totalAmount/);
});

test('booking validation values can be configured from env', async () => {
  const originalTypes = process.env.BOOKING_TYPES_JSON;
  const originalStatuses = process.env.BOOKING_STATUSES_JSON;
  const originalPaymentStatuses = process.env.BOOKING_PAYMENT_STATUSES_JSON;
  const originalVisaStatuses = process.env.BOOKING_VISA_STATUSES_JSON;

  process.env.BOOKING_TYPES_JSON = JSON.stringify(['custom_type']);
  process.env.BOOKING_STATUSES_JSON = JSON.stringify(['draft', 'custom_status']);
  process.env.BOOKING_PAYMENT_STATUSES_JSON = JSON.stringify(['unpaid', 'custom_paid']);
  process.env.BOOKING_VISA_STATUSES_JSON = JSON.stringify(['pending', 'custom_visa']);

  try {
    const config = getBookingConfig();
    assert.deepEqual(config.bookingTypes, ['custom_type']);
    assert.deepEqual(config.bookingStatuses, ['draft', 'custom_status']);
    assert.deepEqual(config.paymentStatuses, ['unpaid', 'custom_paid']);
    assert.deepEqual(config.visaStatuses, ['pending', 'custom_visa']);

    const { bookingSchemas } = await import('../middleware/validateRequest.js');
    const { value, error } = bookingSchemas.createBooking.validate({
      customerId: 'customer-123',
      bookingType: 'custom_type'
    });

    assert.equal(error, undefined);
    assert.equal(value.bookingType, 'custom_type');
  } finally {
    if (originalTypes === undefined) delete process.env.BOOKING_TYPES_JSON;
    else process.env.BOOKING_TYPES_JSON = originalTypes;

    if (originalStatuses === undefined) delete process.env.BOOKING_STATUSES_JSON;
    else process.env.BOOKING_STATUSES_JSON = originalStatuses;

    if (originalPaymentStatuses === undefined) delete process.env.BOOKING_PAYMENT_STATUSES_JSON;
    else process.env.BOOKING_PAYMENT_STATUSES_JSON = originalPaymentStatuses;

    if (originalVisaStatuses === undefined) delete process.env.BOOKING_VISA_STATUSES_JSON;
    else process.env.BOOKING_VISA_STATUSES_JSON = originalVisaStatuses;
  }
});

test('booking traveler values can be configured from env', () => {
  const originalTravelerTypes = process.env.BOOKING_TRAVELER_TYPES_JSON;
  const originalTravelerStatuses = process.env.BOOKING_TRAVELER_STATUSES_JSON;
  const originalDefaultType = process.env.DEFAULT_TRAVELER_TYPE;
  const originalDefaultStatus = process.env.DEFAULT_TRAVELER_STATUS;

  process.env.BOOKING_TRAVELER_TYPES_JSON = JSON.stringify(['custom_traveler']);
  process.env.BOOKING_TRAVELER_STATUSES_JSON = JSON.stringify(['registered', 'custom_status']);
  process.env.DEFAULT_TRAVELER_TYPE = 'custom_traveler';
  process.env.DEFAULT_TRAVELER_STATUS = 'custom_status';

  try {
    const config = getBookingConfig();

    assert.deepEqual(config.travelerTypes, ['custom_traveler']);
    assert.deepEqual(config.travelerStatuses, ['registered', 'custom_status']);
    assert.equal(config.defaultTravelerType, 'custom_traveler');
    assert.equal(config.defaultTravelerStatus, 'custom_status');
  } finally {
    if (originalTravelerTypes === undefined) delete process.env.BOOKING_TRAVELER_TYPES_JSON;
    else process.env.BOOKING_TRAVELER_TYPES_JSON = originalTravelerTypes;

    if (originalTravelerStatuses === undefined) delete process.env.BOOKING_TRAVELER_STATUSES_JSON;
    else process.env.BOOKING_TRAVELER_STATUSES_JSON = originalTravelerStatuses;

    if (originalDefaultType === undefined) delete process.env.DEFAULT_TRAVELER_TYPE;
    else process.env.DEFAULT_TRAVELER_TYPE = originalDefaultType;

    if (originalDefaultStatus === undefined) delete process.env.DEFAULT_TRAVELER_STATUS;
    else process.env.DEFAULT_TRAVELER_STATUS = originalDefaultStatus;
  }
});
