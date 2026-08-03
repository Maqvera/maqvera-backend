import dotenv from 'dotenv';

dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getGdsConfig = (provider = 'amadeus') => {
  const baseUrl = process.env.AMADEUS_BASE_URL || process.env.GDS_BASE_URL || 'https://test.api.amadeus.com';
  const defaultCurrency = process.env.GDS_DEFAULT_CURRENCY || 'PKR';
  const defaultOrigin = process.env.GDS_DEFAULT_ORIGIN || 'KHI';
  const defaultDestination = process.env.GDS_DEFAULT_DESTINATION || 'JED';

  if (provider === 'amadeus') {
    return {
      provider: 'amadeus',
      baseUrl,
      defaultCurrency,
      defaultOrigin,
      defaultDestination,
      fallbackFlightBasePrice: parseNumber(process.env.GDS_FALLBACK_FLIGHT_BASE_PRICE, 145000),
      fallbackFlightAltBasePrice: parseNumber(process.env.GDS_FALLBACK_FLIGHT_ALT_BASE_PRICE, 185000),
      fallbackHotelBasePrice: parseNumber(process.env.GDS_FALLBACK_HOTEL_BASE_PRICE, 350000),
      fallbackAirline: process.env.GDS_FALLBACK_AIRLINE || 'Saudi Airlines',
      fallbackAirlineCode: process.env.GDS_FALLBACK_AIRLINE_CODE || 'SV',
      fallbackAltAirline: process.env.GDS_FALLBACK_ALT_AIRLINE || 'Emirates',
      fallbackAltAirlineCode: process.env.GDS_FALLBACK_ALT_AIRLINE_CODE || 'EK',
      fallbackBaggageAllowance: process.env.GDS_FALLBACK_BAGGAGE_ALLOWANCE || '2 Pieces (23kg each)',
      fallbackHotelCancellationPolicy: process.env.GDS_FALLBACK_HOTEL_CANCELLATION_POLICY || 'Free cancellation up to 48 hours before check-in',
      fallbackHotelRoomType: process.env.GDS_FALLBACK_HOTEL_ROOM_TYPE || 'Quad Room',
      fallbackHotelMealPlan: process.env.GDS_FALLBACK_HOTEL_MEAL_PLAN || 'Breakfast Included',
      fallbackHotelDistance: process.env.GDS_FALLBACK_HOTEL_DISTANCE || '250 meters',
      fallbackHotelStars: parseNumber(process.env.GDS_FALLBACK_HOTEL_STARS, 5),
      fallbackFlightDuration: process.env.GDS_FALLBACK_FLIGHT_DURATION || '5h 20m',
      fallbackAltFlightDuration: process.env.GDS_FALLBACK_ALT_FLIGHT_DURATION || '8h 30m',
      fallbackFlightStops: parseNumber(process.env.GDS_FALLBACK_FLIGHT_STOPS, 0),
      fallbackAltFlightStops: parseNumber(process.env.GDS_FALLBACK_ALT_FLIGHT_STOPS, 1)
    };
  }

  return {
    provider,
    baseUrl,
    defaultCurrency,
    defaultOrigin,
    defaultDestination
  };
};

export default getGdsConfig;
