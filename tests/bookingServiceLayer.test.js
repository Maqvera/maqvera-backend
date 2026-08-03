import test from 'node:test';
import assert from 'node:assert/strict';
import { getBookingConfig } from '../utils/bookingConfig.js';

test('booking service validation values can be configured from env', async () => {
  const originalServiceTypes = process.env.BOOKING_SERVICE_TYPES_JSON;
  const originalServiceCategories = process.env.BOOKING_SERVICE_CATEGORIES_JSON;
  const originalWorkflowStatuses = process.env.BOOKING_SERVICE_WORKFLOW_STATUSES_JSON;
  const originalDefaultWorkflowStatus = process.env.DEFAULT_SERVICE_WORKFLOW_STATUS;
  const originalDefaultServiceStatus = process.env.DEFAULT_SERVICE_STATUS;
  const originalDefaultPriority = process.env.DEFAULT_SERVICE_PRIORITY;
  const originalCurrencies = process.env.SUPPORTED_CURRENCIES_JSON;

  process.env.BOOKING_SERVICE_TYPES_JSON = JSON.stringify(['custom_service']);
  process.env.BOOKING_SERVICE_CATEGORIES_JSON = JSON.stringify(['custom_category']);
  process.env.BOOKING_SERVICE_WORKFLOW_STATUSES_JSON = JSON.stringify(['created', 'custom_state']);
  process.env.DEFAULT_SERVICE_WORKFLOW_STATUS = 'custom_state';
  process.env.DEFAULT_SERVICE_STATUS = 'active';
  process.env.DEFAULT_SERVICE_PRIORITY = 'high';
  process.env.SUPPORTED_CURRENCIES_JSON = JSON.stringify(['USD', 'SAR']);

  try {
    const config = getBookingConfig();

    assert.deepEqual(config.serviceTypes, ['custom_service']);
    assert.deepEqual(config.serviceCategories, ['custom_category']);
    assert.deepEqual(config.serviceWorkflowStatuses, ['created', 'custom_state']);
    assert.equal(config.defaultServiceWorkflowStatus, 'custom_state');
    assert.equal(config.defaultServiceStatus, 'active');
    assert.equal(config.defaultServicePriority, 'high');
    assert.deepEqual(config.supportedCurrencies, ['usd', 'sar']);

    const { bookingSchemas } = await import('../middleware/validateRequest.js');
    const { value, error } = bookingSchemas.addBookingServices.validate({
      serviceType: 'custom_service',
      serviceCategory: 'custom_category',
      serviceName: 'Test Service',
      currencyId: 'SAR',
      workflowStatus: 'custom_state',
      priority: 'high'
    });

    assert.equal(error, undefined);
    assert.equal(value.serviceType, 'custom_service');
    assert.equal(value.currencyId, 'sar');
    assert.equal(value.workflowStatus, 'custom_state');
  } finally {
    if (originalServiceTypes === undefined) delete process.env.BOOKING_SERVICE_TYPES_JSON;
    else process.env.BOOKING_SERVICE_TYPES_JSON = originalServiceTypes;

    if (originalServiceCategories === undefined) delete process.env.BOOKING_SERVICE_CATEGORIES_JSON;
    else process.env.BOOKING_SERVICE_CATEGORIES_JSON = originalServiceCategories;

    if (originalWorkflowStatuses === undefined) delete process.env.BOOKING_SERVICE_WORKFLOW_STATUSES_JSON;
    else process.env.BOOKING_SERVICE_WORKFLOW_STATUSES_JSON = originalWorkflowStatuses;

    if (originalDefaultWorkflowStatus === undefined) delete process.env.DEFAULT_SERVICE_WORKFLOW_STATUS;
    else process.env.DEFAULT_SERVICE_WORKFLOW_STATUS = originalDefaultWorkflowStatus;

    if (originalDefaultServiceStatus === undefined) delete process.env.DEFAULT_SERVICE_STATUS;
    else process.env.DEFAULT_SERVICE_STATUS = originalDefaultServiceStatus;

    if (originalDefaultPriority === undefined) delete process.env.DEFAULT_SERVICE_PRIORITY;
    else process.env.DEFAULT_SERVICE_PRIORITY = originalDefaultPriority;

    if (originalCurrencies === undefined) delete process.env.SUPPORTED_CURRENCIES_JSON;
    else process.env.SUPPORTED_CURRENCIES_JSON = originalCurrencies;
  }
});
