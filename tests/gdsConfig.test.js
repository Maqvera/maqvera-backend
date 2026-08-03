import test from 'node:test';
import assert from 'node:assert/strict';
import { getGdsConfig } from '../utils/gdsConfig.js';
import AmadeusAdapter from '../services/gds/AmadeusAdapter.js';
import gdsHttpClient from '../utils/gdsHttpClient.js';

test('getGdsConfig reads environment-driven defaults', () => {
  process.env.AMADEUS_BASE_URL = 'https://example.test';
  process.env.GDS_DEFAULT_CURRENCY = 'EUR';
  process.env.GDS_DEFAULT_ORIGIN = 'ISB';
  process.env.GDS_DEFAULT_DESTINATION = 'AUH';
  process.env.GDS_FALLBACK_FLIGHT_BASE_PRICE = '200000';
  process.env.GDS_FALLBACK_HOTEL_BASE_PRICE = '450000';

  const config = getGdsConfig('amadeus');

  assert.equal(config.baseUrl, 'https://example.test');
  assert.equal(config.defaultCurrency, 'EUR');
  assert.equal(config.defaultOrigin, 'ISB');
  assert.equal(config.defaultDestination, 'AUH');
  assert.equal(config.fallbackFlightBasePrice, 200000);
  assert.equal(config.fallbackHotelBasePrice, 450000);
});

test('AmadeusAdapter uses configured fallback values when live API is unavailable', async () => {
  process.env.GDS_DEFAULT_ORIGIN = 'ISB';
  process.env.GDS_DEFAULT_DESTINATION = 'AUH';
  process.env.GDS_FALLBACK_FLIGHT_BASE_PRICE = '220000';
  process.env.GDS_FALLBACK_FLIGHT_ALT_BASE_PRICE = '260000';
  process.env.GDS_FALLBACK_AIRLINE = 'Qatar Airways';
  process.env.GDS_FALLBACK_AIRLINE_CODE = 'QR';
  process.env.GDS_FALLBACK_ALT_AIRLINE = 'Etihad';
  process.env.GDS_FALLBACK_ALT_AIRLINE_CODE = 'EY';
  process.env.GDS_FALLBACK_BAGGAGE_ALLOWANCE = '1 Piece (7kg)';

  const originalRequest = gdsHttpClient.requestAmadeus;
  gdsHttpClient.requestAmadeus = async () => null;

  try {
    const adapter = new AmadeusAdapter();
    const result = await adapter.searchFlights({
      origin: 'ISB',
      destination: 'AUH',
      departureDate: '2027-02-01',
      adults: 2,
      cabin: 'Business',
      currency: 'USD'
    });

    assert.equal(result.offers[0].price, 440000);
    assert.equal(result.offers[0].airline, 'Qatar Airways');
    assert.equal(result.offers[0].airlineCode, 'QR');
    assert.equal(result.offers[0].baggageAllowance, '1 Piece (7kg)');
  } finally {
    gdsHttpClient.requestAmadeus = originalRequest;
  }
});
