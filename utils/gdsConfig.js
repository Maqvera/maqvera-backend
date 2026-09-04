import dotenv from 'dotenv';

dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Search-request validation policy — "Cabin Valid", "Currency Supported",
 * "Maximum passengers configurable" business rules. Config-driven (env-var
 * JSON override) rather than a hardcoded array in the controller, matching
 * every other domain enum in this codebase.
 */
/**
 * Ticketing/PNR servicing policy (API-006D) — "Void allowed only within
 * airline policy", "Supported SSR/OSI/EMD" business rules. Config-driven
 * rather than hardcoded arrays in the controller.
 */
export const getTicketingPolicyConfig = () => ({
  voidWindowHours: parseNumber(process.env.GDS_TICKET_VOID_WINDOW_HOURS, 24),
  defaultCancellationPenaltyPct: parseNumber(process.env.GDS_DEFAULT_CANCELLATION_PENALTY_PCT, 20),
  supportedSsrCodes: parseJson(process.env.GDS_SUPPORTED_SSR_CODES_JSON, [
    "WCHR", "SPML", "INFT", "EXST", "MEDA", "PETC", "UMNR", "OTHS"
  ]),
  supportedOsiTypes: parseJson(process.env.GDS_SUPPORTED_OSI_TYPES_JSON, [
    "VIP Passenger", "Language Preference", "Special Handling", "Corporate Traveler", "Medical Notes"
  ]),
  supportedEmdTypes: parseJson(process.env.GDS_SUPPORTED_EMD_TYPES_JSON, [
    "Extra Baggage", "Seat Upgrade", "Lounge Access", "Sports Equipment", "Priority Boarding", "Wi-Fi", "Meal Upgrade"
  ])
});

/**
 * EXT-005 §17 "Retry Policy: Automatic Retry, 3 Attempts, Exponential
 * Backoff." A dedicated policy distinct from getFlightSearchValidationConfig's
 * generic maxRetries (1, no backoff) since the doc names a specific attempt
 * count and backoff strategy for ticket issuance.
 */
export const getTicketIssuanceRetryPolicy = () => ({
  maxAttempts: parseNumber(process.env.GDS_TICKET_ISSUANCE_MAX_ATTEMPTS, 3),
  backoffBaseMs: parseNumber(process.env.GDS_TICKET_ISSUANCE_BACKOFF_BASE_MS, 500)
});

/**
 * EXT-008 §9/§14 "Cache lifetime = 5 minutes... Redis... TTL 300 Seconds."
 */
export const getSeatMapPolicy = () => ({
  cacheTtlSeconds: parseNumber(process.env.GDS_SEAT_MAP_CACHE_TTL_SECONDS, 300),
  timeoutMs: parseNumber(process.env.GDS_SEAT_MAP_TIMEOUT_MS, 15000),
  maxRetries: parseNumber(process.env.GDS_SEAT_MAP_MAX_RETRIES, 1)
});

/**
 * EXT-011 §10 "Read-only integration... [no caching mentioned, unlike
 * EXT-008's explicit 5-minute cache]." Deliberately has no cacheTtlSeconds —
 * status is meant to be live on every call, the same "No Cache, Always
 * Live" precedent EXT-003 pricing already established.
 */
export const getFlightStatusPolicy = () => ({
  timeoutMs: parseNumber(process.env.GDS_FLIGHT_STATUS_TIMEOUT_MS, 15000),
  maxRetries: parseNumber(process.env.GDS_FLIGHT_STATUS_MAX_RETRIES, 1),
  // A live estimated-vs-scheduled gap below this is treated as on-time
  // noise, not a real delay worth surfacing as "Delayed"/publishing FlightDelayed.
  delayThresholdMinutes: parseNumber(process.env.GDS_FLIGHT_STATUS_DELAY_THRESHOLD_MINUTES, 15),
  // EXT-018 §9 "Flight Rescheduled" — distinct from an on-the-day delay: a
  // shift this large between Amadeus's current scheduled departure/arrival
  // and what this codebase already had stored means the airline actually
  // changed the timetable since booking, not just today's estimate.
  rescheduleThresholdMinutes: parseNumber(process.env.GDS_FLIGHT_RESCHEDULE_THRESHOLD_MINUTES, 60)
});

/**
 * EXT-018 §6/§7/§15 — background scheduler configuration. Two cron tiers
 * (high-priority flights sync more often, per §6), retry/backoff for a
 * per-flight sync failure, and a bounded lookahead window so the
 * background job never queries/syncs flights far in the future (keeps
 * Amadeus call volume — and cost — proportional to what's actually
 * relevant soon, the same cost-consciousness this whole EXT series has
 * applied throughout).
 */
export const getFlightScheduleSyncPolicy = () => ({
  cronSchedule: process.env.FLIGHT_SCHEDULE_SYNC_CRON_SCHEDULE || "*/15 * * * *",
  highPriorityCronSchedule: process.env.FLIGHT_SCHEDULE_SYNC_HIGH_PRIORITY_CRON_SCHEDULE || "*/5 * * * *",
  maxRetries: parseNumber(process.env.FLIGHT_SCHEDULE_SYNC_MAX_RETRIES, 5),
  retryDelayMs: parseNumber(process.env.FLIGHT_SCHEDULE_SYNC_RETRY_DELAY_MS, 30000),
  syncWindowDaysAhead: parseNumber(process.env.FLIGHT_SCHEDULE_SYNC_WINDOW_DAYS_AHEAD, 7),
  batchSize: parseNumber(process.env.FLIGHT_SCHEDULE_SYNC_BATCH_SIZE, 50)
});

/**
 * EXT-012 §16/§17 "Redis Cache... TTL 30 Minutes" and "Timeout"/"Rate
 * Limit" error handling. Distinct from getFlightStatusPolicy (deliberately
 * uncached — status must always be live) since schedule data is exactly
 * the kind of slower-changing lookup this doc explicitly wants cached.
 */
export const getFlightSchedulePolicy = () => ({
  timeoutMs: parseNumber(process.env.GDS_FLIGHT_SCHEDULE_TIMEOUT_MS, 15000),
  maxRetries: parseNumber(process.env.GDS_FLIGHT_SCHEDULE_MAX_RETRIES, 1),
  cacheTtlSeconds: parseNumber(process.env.GDS_FLIGHT_SCHEDULE_CACHE_TTL_SECONDS, 1800),
  maxAdvanceBookingDays: parseNumber(process.env.GDS_FLIGHT_SCHEDULE_MAX_ADVANCE_DAYS, 365)
});

/**
 * EXT-015 §16/§11 "Redis Cache... TTL 30 Minutes" / "Internal business
 * filters applied after provider response" (§15 "Company Business Rules").
 * `blockedDestinations`/`boostedDestinations` are the real, config-driven
 * hook for that business-rule layer — never a hardcoded array in the
 * service.
 */
export const getFlightInspirationPolicy = () => ({
  timeoutMs: parseNumber(process.env.GDS_FLIGHT_INSPIRATION_TIMEOUT_MS, 15000),
  maxRetries: parseNumber(process.env.GDS_FLIGHT_INSPIRATION_MAX_RETRIES, 1),
  cacheTtlSeconds: parseNumber(process.env.GDS_FLIGHT_INSPIRATION_CACHE_TTL_SECONDS, 1800),
  maxResults: parseNumber(process.env.GDS_FLIGHT_INSPIRATION_MAX_RESULTS, 20),
  defaultResults: parseNumber(process.env.GDS_FLIGHT_INSPIRATION_DEFAULT_RESULTS, 10),
  fallbackCurrency: process.env.GDS_FLIGHT_INSPIRATION_FALLBACK_CURRENCY || "USD",
  blockedDestinations: parseJson(process.env.GDS_FLIGHT_INSPIRATION_BLOCKED_DESTINATIONS_JSON, []),
  boostedDestinations: parseJson(process.env.GDS_FLIGHT_INSPIRATION_BOOSTED_DESTINATIONS_JSON, [])
});

/**
 * EXT-016 §16 "Short-term Redis Cache... TTL 10 Minutes... Offer expires
 * automatically." Deliberately short — shorter than the underlying search
 * cache's own TTL (`GDS_SEARCH_CACHE_TTL_SECONDS`, default 600s/10min) is
 * never a concern here since AmadeusFlightBrandedFaresService re-validates
 * the underlying offer via `revalidateOffer` on every call regardless of
 * cache hit, so an expired offer is always rejected before a stale cached
 * fare list could ever be served ("Never Cache Expired Offers", §20).
 */
export const getBrandedFaresPolicy = () => ({
  timeoutMs: parseNumber(process.env.GDS_BRANDED_FARES_TIMEOUT_MS, 15000),
  maxRetries: parseNumber(process.env.GDS_BRANDED_FARES_MAX_RETRIES, 1),
  cacheTtlSeconds: parseNumber(process.env.GDS_BRANDED_FARES_CACHE_TTL_SECONDS, 600)
});

/**
 * EXT-017 §16 "Redis Cache... TTL 10 Minutes... Ancillary pricing
 * refreshed automatically." Same 10-minute tier as EXT-016's branded
 * fares, same "re-validate the underlying offer on every call" pattern —
 * see AmadeusAncillaryServicesService.
 */
export const getAncillaryServicesPolicy = () => ({
  timeoutMs: parseNumber(process.env.GDS_ANCILLARY_SERVICES_TIMEOUT_MS, 15000),
  maxRetries: parseNumber(process.env.GDS_ANCILLARY_SERVICES_MAX_RETRIES, 1),
  cacheTtlSeconds: parseNumber(process.env.GDS_ANCILLARY_SERVICES_CACHE_TTL_SECONDS, 600)
});

/**
 * EXT-019 §10/§16 "Maximum Page Size = 100" / "Redis Cache... TTL 15
 * Minutes". Deliberately distinct from `getHotelSearchValidationConfig`
 * below (API-006E, the pre-existing legacy hotel-distribution pipeline's
 * own maxRooms/maxGuestsPerBooking policy) — this document's own hotel
 * DISCOVERY search has different validation concerns entirely (page size,
 * not room/guest counts).
 */
export const getHotelListSearchPolicy = () => ({
  timeoutMs: parseNumber(process.env.GDS_HOTEL_LIST_SEARCH_TIMEOUT_MS, 15000),
  maxRetries: parseNumber(process.env.GDS_HOTEL_LIST_SEARCH_MAX_RETRIES, 1),
  cacheTtlSeconds: parseNumber(process.env.GDS_HOTEL_LIST_SEARCH_CACHE_TTL_SECONDS, 900),
  maxPageSize: parseNumber(process.env.GDS_HOTEL_LIST_SEARCH_MAX_PAGE_SIZE, 100),
  defaultPageSize: parseNumber(process.env.GDS_HOTEL_LIST_SEARCH_DEFAULT_PAGE_SIZE, 20)
});

/**
 * EXT-020 §10/§16 "Adult Count Valid" / "Room Count Positive" / "Redis
 * Cache... TTL 5 Minutes... Offers expire automatically." Deliberately
 * distinct from `getHotelSearchValidationConfig` below (the legacy
 * API-006E pipeline's own maxRooms/maxGuestsPerBooking policy).
 */
export const getHotelOfferPolicy = () => ({
  timeoutMs: parseNumber(process.env.GDS_HOTEL_OFFER_TIMEOUT_MS, 15000),
  maxRetries: parseNumber(process.env.GDS_HOTEL_OFFER_MAX_RETRIES, 1),
  cacheTtlSeconds: parseNumber(process.env.GDS_HOTEL_OFFER_CACHE_TTL_SECONDS, 300),
  maxAdults: parseNumber(process.env.GDS_HOTEL_OFFER_MAX_ADULTS, 9),
  maxRooms: parseNumber(process.env.GDS_HOTEL_OFFER_MAX_ROOMS, 9),
  maxAdvanceBookingDays: parseNumber(process.env.GDS_HOTEL_OFFER_MAX_ADVANCE_DAYS, 365)
});

/**
 * EXT-021 §16 "No long-term caching... Very short Redis cache (maximum 60
 * seconds) may be used only for duplicate requests." Deliberately far
 * shorter than EXT-020's own 5-minute search cache — this is a
 * pre-booking re-verification step, not a browsing cache.
 */
export const getHotelPricingPolicy = () => ({
  timeoutMs: parseNumber(process.env.GDS_HOTEL_PRICING_TIMEOUT_MS, 15000),
  maxRetries: parseNumber(process.env.GDS_HOTEL_PRICING_MAX_RETRIES, 1),
  cacheTtlSeconds: parseNumber(process.env.GDS_HOTEL_PRICING_CACHE_TTL_SECONDS, 60)
});

/**
 * EXT-022 §16 "Booking requests are never served from cache. Each booking
 * request is sent directly to the provider." — no cacheTtlSeconds here,
 * deliberately, unlike every read-oriented EXT-series policy above.
 */
export const getHotelBookingPolicy = () => ({
  timeoutMs: parseNumber(process.env.GDS_HOTEL_BOOKING_TIMEOUT_MS, 20000),
  maxRetries: parseNumber(process.env.GDS_HOTEL_BOOKING_MAX_RETRIES, 1)
});

/**
 * EXT-023 §16 "Frequently accessed bookings may be cached in Redis. Cache
 * TTL 5 Minutes." — caches the formatted retrieval response, not a live
 * provider call (see AmadeusHotelBookingRetrievalService's own honest-gap
 * note: Amadeus's real Hotel Booking API has no GET-by-id retrieval
 * operation, unlike Flight Order Management).
 */
export const getHotelBookingRetrievalPolicy = () => ({
  cacheTtlSeconds: parseNumber(process.env.GDS_HOTEL_BOOKING_RETRIEVAL_CACHE_TTL_SECONDS, 300)
});

/**
 * Hotel search validation policy (API-006E) — "Guests Valid", "Rooms
 * Valid" business rules. Reuses the flight module's supported-currency
 * policy since it's genuinely the same tenant-wide currency list, not a
 * hotel-specific one.
 */
export const getHotelSearchValidationConfig = () => ({
  maxRooms: parseNumber(process.env.GDS_HOTEL_MAX_ROOMS, 10),
  maxGuestsPerBooking: parseNumber(process.env.GDS_HOTEL_MAX_GUESTS, 20),
  maxAdvanceBookingDays: parseNumber(process.env.GDS_HOTEL_MAX_ADVANCE_BOOKING_DAYS, 365)
});

/**
 * EXT-002 §14 "Rate Limiting... Retry with exponential backoff" — real
 * policy for gdsHttpClient's own HTTP calls to Amadeus (distinct from
 * GdsIntegrationService's provider-level retry/circuit-breaker, which
 * retries a whole adapter method call, not individual HTTP requests).
 */
export const getAmadeusHttpPolicy = () => ({
  maxRetries: parseNumber(process.env.GDS_AMADEUS_HTTP_MAX_RETRIES, 3),
  backoffBaseMs: parseNumber(process.env.GDS_AMADEUS_HTTP_BACKOFF_BASE_MS, 500),
  // "No cached fares longer than configured TTL" — was a hardcoded literal
  // (10 * 60 * 1000) inline in GdsIntegrationService.js.
  searchCacheTtlSeconds: parseNumber(process.env.GDS_SEARCH_CACHE_TTL_SECONDS, 600)
});

/**
 * EXT-003 §20 "Performance: No Cache, Always Live, Timeout 30 Seconds,
 * Retry Once, Circuit Breaker Enabled" — a distinct policy from the
 * general GDS_REQUEST_TIMEOUT_MS/GDS_MAX_RETRIES used by search, since
 * pricing calls are allowed to take longer and must not share the more
 * aggressive search retry budget.
 */
export const getAmadeusPricingPolicy = () => ({
  timeoutMs: parseNumber(process.env.AMADEUS_PRICING_TIMEOUT_MS, 30000),
  maxRetries: parseNumber(process.env.AMADEUS_PRICING_MAX_RETRIES, 1),
  maxOfferAgeSeconds: parseNumber(process.env.AMADEUS_PRICING_MAX_OFFER_AGE_SECONDS, 600)
});

export const getFlightSearchValidationConfig = () => ({
  maxPassengers: parseNumber(process.env.GDS_MAX_PASSENGERS, 9),
  maxAdvanceBookingDays: parseNumber(process.env.GDS_MAX_ADVANCE_BOOKING_DAYS, 365),
  supportedCabins: parseJson(process.env.GDS_SUPPORTED_CABINS_JSON, ["Economy", "PremiumEconomy", "Business", "First"]),
  supportedCurrencies: parseJson(process.env.GDS_SUPPORTED_CURRENCIES_JSON, ["PKR", "USD", "SAR", "AED", "EUR", "GBP"]),
  requestTimeoutMs: parseNumber(process.env.GDS_REQUEST_TIMEOUT_MS, 8000),
  maxRetries: parseNumber(process.env.GDS_MAX_RETRIES, 1),
  circuitBreakerThreshold: parseNumber(process.env.GDS_CIRCUIT_BREAKER_THRESHOLD, 3),
  circuitBreakerCooldownMs: parseNumber(process.env.GDS_CIRCUIT_BREAKER_COOLDOWN_MS, 30000)
});

export const getGdsConfig = (provider = 'amadeus') => {
  const baseUrl = process.env.AMADEUS_BASE_URL || process.env.GDS_BASE_URL || 'https://test.api.amadeus.com';
  // These three are per-tenant-deployment config (set explicitly in
  // .env.example to PKR/KHI/JED for this agency's current primary market),
  // never a value baked into search/booking logic itself — every real
  // currency/route calculation in this codebase resolves through
  // CurrencyService/the caller's own request instead of reading these.
  // A different-market tenant overrides all three via its own .env; these
  // are NOT hardcoded business logic, just this deployment's own default.
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
