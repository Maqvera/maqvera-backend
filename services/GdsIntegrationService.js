import AmadeusAdapter from "./gds/AmadeusAdapter.js";
import SabreAdapter from "./gds/SabreAdapter.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFlightSearchValidationConfig, getAmadeusHttpPolicy } from "../utils/gdsConfig.js";
import crypto from "crypto";

// In-Memory Search Cache (10 Minutes TTL)
const searchCache = new Map();

// EXT-020 — per-offer hotel room-offer cache, keyed by offerId, mirroring
// searchCache's role for flight offers (populated here, read back by
// EXT-021's own future pricing-verification step the same way
// revalidateOffer() already reads searchCache for flights — see
// getHotelOfferById below).
const hotelOfferCache = new Map();

/**
 * Per-provider Circuit Breaker — "AI Coding Rule: Circuit Breaker". Tracks
 * consecutive failures per provider; once a provider trips open, calls skip
 * it entirely (no wasted timeout wait on a known-broken provider) until the
 * cooldown elapses, then allows one half-open trial call.
 */
class CircuitBreaker {
  constructor() {
    this.state = new Map(); // provider -> { failures, status, openedAt }
  }

  _get(provider) {
    if (!this.state.has(provider)) {
      this.state.set(provider, { failures: 0, status: "closed", openedAt: null });
    }
    return this.state.get(provider);
  }

  canAttempt(provider) {
    const policy = getFlightSearchValidationConfig();
    const entry = this._get(provider);
    if (entry.status !== "open") return true;
    if (Date.now() - entry.openedAt >= policy.circuitBreakerCooldownMs) {
      entry.status = "half-open";
      return true;
    }
    return false;
  }

  recordSuccess(provider) {
    this.state.set(provider, { failures: 0, status: "closed", openedAt: null });
  }

  recordFailure(provider) {
    const policy = getFlightSearchValidationConfig();
    const entry = this._get(provider);
    entry.failures += 1;
    if (entry.failures >= policy.circuitBreakerThreshold) {
      entry.status = "open";
      entry.openedAt = Date.now();
    }
  }

  getStatus(provider) {
    const entry = this._get(provider);
    return { status: entry.status, failures: entry.failures, openedAt: entry.openedAt ? new Date(entry.openedAt).toISOString() : null };
  }
}

/**
 * GDS Integration Service
 * Multi-provider flight & hotel search engine with caching, failover, and event publishing.
 */
class GdsIntegrationService {
  constructor() {
    this.adapters = {
      Amadeus: new AmadeusAdapter(),
      Sabre: new SabreAdapter()
    };
    this.primaryProvider = process.env.GDS_PRIMARY_PROVIDER || "Amadeus";
    this.secondaryProvider = process.env.GDS_SECONDARY_PROVIDER || "Sabre";
    this.circuitBreaker = new CircuitBreaker();
  }

  /**
   * Get provider adapter by name
   */
  getAdapter(providerName) {
    const key = providerName || this.primaryProvider;
    const adapter = this.adapters[key];
    if (!adapter) {
      throw new Error(`Provider adapter [${key}] is not registered.`);
    }
    return adapter;
  }

  /**
   * AI Coding Rule "Retry Failed Providers" — a bounded, configurable retry
   * on the SAME provider before treating it as failed and falling over to
   * the next one. Only retries on genuine call failures, not on the
   * caller's own validation errors (those never reach here).
   */
  async _callWithRetry(adapter, method, args) {
    const policy = getFlightSearchValidationConfig();
    let lastError;
    for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
      try {
        return await adapter[method](...args);
      } catch (err) {
        lastError = err;
        if (attempt < policy.maxRetries) {
          console.warn(`[GDS] ${adapter.providerName}.${method} attempt ${attempt + 1} failed (${err.message}); retrying...`);
        }
      }
    }
    throw lastError;
  }

  /**
   * Executive Live Flight Search with Failover & Cache
   */
  async searchFlights(searchParams) {
    const searchId = crypto.randomUUID();
    const tenantId = searchParams.tenantId || "default";
    const correlationId = searchParams.correlationId || searchId;

    publishEvent("FlightSearchRequested", { searchId, correlationId, tenantId, searchParams });

    let activeProvider = searchParams.preferredProvider || this.primaryProvider;
    let result = null;
    let fallbackExecuted = false;

    if (this.circuitBreaker.canAttempt(activeProvider)) {
      try {
        const adapter = this.getAdapter(activeProvider);
        result = await this._callWithRetry(adapter, "searchFlights", [searchParams]);
        this.circuitBreaker.recordSuccess(activeProvider);
      } catch (err) {
        console.warn(`[GDS] Provider ${activeProvider} failed. Executing fallback to ${this.secondaryProvider}...`);
        this.circuitBreaker.recordFailure(activeProvider);
      }
    } else {
      console.warn(`[GDS] Circuit breaker open for ${activeProvider}; skipping straight to fallback.`);
    }

    if (!result) {
      fallbackExecuted = true;
      const primaryProvider = activeProvider;
      activeProvider = this.secondaryProvider;

      if (!this.circuitBreaker.canAttempt(activeProvider)) {
        publishEvent("ProviderUnavailable", { searchId, correlationId, tenantId, error: "Circuit breaker open for fallback provider." });
        throw new Error("All GDS Flight Search Providers are currently unavailable.");
      }

      try {
        const fallbackAdapter = this.getAdapter(activeProvider);
        result = await this._callWithRetry(fallbackAdapter, "searchFlights", [searchParams]);
        this.circuitBreaker.recordSuccess(activeProvider);

        publishEvent("ProviderFallbackExecuted", {
          searchId,
          correlationId,
          tenantId,
          primaryProvider,
          fallbackProvider: activeProvider
        });
      } catch (fallbackErr) {
        this.circuitBreaker.recordFailure(activeProvider);
        publishEvent("ProviderUnavailable", { searchId, correlationId, tenantId, error: fallbackErr.message });
        throw new Error("All GDS Flight Search Providers are currently unavailable.");
      }
    }

    const { searchCacheTtlSeconds } = getAmadeusHttpPolicy();
    const payload = {
      searchId,
      correlationId,
      kind: "flight",
      provider: activeProvider,
      fallbackExecuted,
      searchParams,
      meta: {
        totalOffers: result.offers.length,
        currency: searchParams.currency || "PKR",
        searchTimestamp: new Date().toISOString(),
        expiresInSeconds: searchCacheTtlSeconds
      },
      results: result.offers
    };

    // "No cached fares longer than configured TTL" — was a hardcoded
    // literal; now GDS_SEARCH_CACHE_TTL_SECONDS.
    searchCache.set(searchId, {
      data: payload,
      expiresAt: Date.now() + searchCacheTtlSeconds * 1000
    });

    publishEvent("FlightSearchCompleted", { searchId, correlationId, tenantId, totalOffers: result.offers.length });
    publishEvent("FlightSearchCached", { searchId, correlationId, tenantId, ttlSeconds: searchCacheTtlSeconds });

    return payload;
  }

  /**
   * Retrieve cached search results by searchId
   */
  async getSearchById(searchId) {
    const cached = searchCache.get(searchId);
    if (!cached) {
      return null;
    }
    if (Date.now() > cached.expiresAt) {
      searchCache.delete(searchId);
      return null;
    }
    return cached.data;
  }

  /**
   * Revalidate Flight Offer — "Offer Exists", "Offer Not Expired", "Fare
   * Still Valid", "Seats Available" validation rules. Previously a blind
   * passthrough that trusted the adapter's stub (always `isValid: true`,
   * fabricated seats/price) regardless of whether the offerId was ever real
   * or the 10-minute search TTL had expired. Now looks the offer up in the
   * actual search cache first — the same one populated by `searchFlights` —
   * so revalidation reflects the real, previously-returned offer.
   */
  async revalidateOffer(revalidateParams) {
    const { offerId, tenantId } = revalidateParams;
    let matchedOffer = null;
    let matchedSearch = null;

    for (const entry of searchCache.values()) {
      if (Date.now() > entry.expiresAt) continue;
      if (entry.data.kind !== "flight") continue;
      if (tenantId && entry.data.searchParams?.tenantId !== tenantId) continue;
      const found = (entry.data.results || []).find((o) => o.offerId === offerId);
      if (found) {
        matchedOffer = found;
        matchedSearch = entry.data;
        break;
      }
    }

    if (!matchedOffer) {
      return {
        provider: revalidateParams.provider || this.primaryProvider,
        offerId,
        isValid: false,
        reason: "Offer not found or the original search has expired. Please search again.",
        availableSeats: 0
      };
    }

    const adapter = this.getAdapter(matchedSearch.provider);
    const providerResult = await this._callWithRetry(adapter, "revalidateOffer", [{ offerId, price: matchedOffer.price }]);
    const availableSeats = providerResult.availableSeats ?? matchedOffer.availableSeats ?? 0;
    const requestedPassengers = (matchedSearch.searchParams?.adults || 0) + (matchedSearch.searchParams?.children || 0) + (matchedSearch.searchParams?.infants || 0);

    return {
      provider: matchedSearch.provider,
      offerId,
      isValid: Boolean(providerResult.isValid) && availableSeats > 0,
      priceChanged: providerResult.currentPrice != null && providerResult.currentPrice !== matchedOffer.price,
      originalPrice: matchedOffer.price,
      currentPrice: providerResult.currentPrice ?? matchedOffer.price,
      currency: matchedOffer.currency,
      availableSeats,
      requestedPassengers,
      expiresAt: providerResult.expiresAt,
      // EXT-004 — surfaces the real raw Amadeus offer (when the original
      // search was live, per EXT-002's _source/_raw tagging) so a booking
      // call downstream of this revalidation can actually pass Amadeus's
      // real Flight Create Orders API the complete offer object it
      // requires, instead of a bare offer ID string.
      rawOffer: matchedOffer._source === "live" ? matchedOffer._raw : null,
      rawOfferSource: matchedOffer._source || "dynamic-sandbox"
    };
  }

  /**
   * Create a live PNR with the provider — "Adapter Pattern", "Retry Policy",
   * "Circuit Breaker". This facade method was missing entirely even though
   * every adapter implements `createFlightBooking`, meaning the module's
   * core endpoint (POST /flight-bookings) threw a TypeError on every call.
   */
  async createFlightBooking(bookingParams) {
    const provider = bookingParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "createFlightBooking", [bookingParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * Synchronize a booking's live status with the provider. Also missing
   * entirely — POST /flight-bookings/:id/sync threw a TypeError on every
   * call before this fix. Adapters take a raw PNR string, not an object.
   */
  async syncFlightBooking(syncParams) {
    const adapter = this.getAdapter(syncParams.provider);
    return await this._callWithRetry(adapter, "syncFlightBooking", [syncParams.pnr]);
  }

  /**
   * Get Low Fare Calendar
   */
  async getCalendarSearch(calendarParams) {
    const adapter = this.getAdapter(calendarParams.provider);
    return await adapter.getCalendarSearch(calendarParams);
  }

  /**
   * Fetch Fare Rules
   */
  async getFareRules(rulesParams) {
    const adapter = this.getAdapter(rulesParams.provider);
    return await this._callWithRetry(adapter, "getFareRules", [rulesParams]);
  }

  /**
   * Fetch Baggage Policy
   */
  async getBaggageInfo(baggageParams) {
    const adapter = this.getAdapter(baggageParams.provider);
    return await adapter.getBaggageInfo(baggageParams);
  }

  /**
   * Fetch Seat Map (API-006B pre-booking preview — keyed by flightNumber)
   */
  async getSeatMap(seatMapParams) {
    const adapter = this.getAdapter(seatMapParams.provider);
    return await adapter.getSeatMap(seatMapParams);
  }

  /**
   * EXT-008 — Post-Booking Seat Map for an existing confirmed flight order.
   * Shares the same circuit breaker as every other Amadeus-facing call
   * ("Amadeus Connected" validation) plus the standard retry wrapper.
   */
  async getFlightOrderSeatMap(seatMapParams) {
    const provider = seatMapParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "getFlightOrderSeatMap", [seatMapParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * EXT-009 — Seat Assignment against an existing confirmed flight order.
   * Same circuit breaker + retry pattern as every other provider-facing
   * write in this service.
   */
  async assignSeats(seatAssignmentParams) {
    const provider = seatAssignmentParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "assignSeats", [seatAssignmentParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * EXT-011 — Live Flight Status. Same circuit breaker + retry pattern as
   * every other Amadeus-facing call in this service.
   */
  async getFlightStatus(flightStatusParams) {
    const provider = flightStatusParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "getFlightStatus", [flightStatusParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * EXT-012 — Flight Schedule lookup. Same circuit breaker + retry pattern
   * as every other Amadeus-facing call in this service.
   */
  async getFlightSchedules(scheduleParams) {
    const provider = scheduleParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "getFlightSchedules", [scheduleParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * EXT-013 — Reference Data lookups (Airport & City Search / Airline Code
   * Lookup). Same circuit breaker + retry pattern as every other
   * Amadeus-facing call in this service.
   */
  async searchLocations(locationParams) {
    const provider = locationParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "searchLocations", [locationParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  async getAirlinesByCodes(airlineLookupParams) {
    const provider = airlineLookupParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "getAirlinesByCodes", [airlineLookupParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * EXT-015 — Flight Inspiration (destination discovery). Same circuit
   * breaker + retry pattern as every other Amadeus-facing call.
   */
  async getFlightInspiration(inspirationParams) {
    const provider = inspirationParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "getFlightInspiration", [inspirationParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * EXT-016 — Branded Fares / Flight Offers Upselling. Same circuit
   * breaker + retry pattern as every other Amadeus-facing call.
   */
  async getBrandedFares(brandedFareParams) {
    const provider = brandedFareParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "getBrandedFares", [brandedFareParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * EXT-017 — Ancillary Services catalog for an offer. Same circuit
   * breaker + retry pattern as every other Amadeus-facing call.
   */
  async getAncillaryServices(ancillaryParams) {
    const provider = ancillaryParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "getAncillaryServices", [ancillaryParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * EXT-019 — Hotel List (discovery) search. Deliberately distinct from
   * `searchHotels()` above (the legacy hotel-distribution pipeline). Same
   * circuit breaker + retry pattern as every other Amadeus-facing call.
   */
  async searchHotelList(hotelListParams) {
    const provider = hotelListParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "searchHotelList", [hotelListParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * EXT-020 — Hotel Offers (room availability & pricing). Same circuit
   * breaker + retry pattern as every other Amadeus-facing call. Caches
   * each returned raw offer by offerId (§16's own 5-minute TTL) so
   * EXT-021's future pricing-verification step can look it up the exact
   * same way `revalidateOffer()` already looks up flight offers.
   */
  async searchHotelOffers(hotelOfferParams) {
    const provider = hotelOfferParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "getHotelOffers", [hotelOfferParams]);
      this.circuitBreaker.recordSuccess(provider);

      const ttlSeconds = hotelOfferParams.cacheTtlSeconds || 300;
      for (const offer of result.offers || []) {
        if (!offer.offerId) continue;
        hotelOfferCache.set(offer.offerId, {
          data: { offer, hotel: result.hotel, hotelId: hotelOfferParams.hotelId, provider, source: result._source },
          expiresAt: Date.now() + ttlSeconds * 1000
        });
      }

      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * EXT-021's own future lookup point — mirrors `revalidateOffer()`'s
   * exact shape for flight offers (`isValid`/`rawOffer`/`rawOfferSource`),
   * so pricing verification can be built the same way flight pricing
   * verification already was, per the roadmap's own explicit intent.
   */
  getHotelOfferById(offerId) {
    const cached = hotelOfferCache.get(offerId);
    if (!cached) return { isValid: false, rawOffer: null, rawOfferSource: null, hotel: null, hotelId: null };
    if (Date.now() > cached.expiresAt) {
      hotelOfferCache.delete(offerId);
      return { isValid: false, rawOffer: null, rawOfferSource: null, hotel: null, hotelId: null };
    }
    return { isValid: true, rawOffer: cached.data.offer, rawOfferSource: cached.data.source, hotel: cached.data.hotel, hotelId: cached.data.hotelId };
  }

  /**
   * EXT-021 — Hotel Offer Pricing re-verification (the hotel-side analog
   * to `getFlightOfferPricing`). Same circuit breaker + retry pattern as
   * every other Amadeus-facing call.
   */
  async getHotelOfferPricing(hotelPricingParams) {
    const provider = hotelPricingParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "getHotelOfferPricing", [hotelPricingParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * EXT-022 — Hotel Booking creation (the real Amadeus reservation).
   * Deliberately distinct from `createHotelBooking()` above (the legacy,
   * fully-fabricated hotel-distribution pipeline). Same circuit breaker +
   * retry pattern as every other Amadeus-facing write.
   */
  async createHotelBookingReservation(hotelBookingParams) {
    const provider = hotelBookingParams.provider || this.primaryProvider;
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    try {
      const adapter = this.getAdapter(provider);
      const result = await this._callWithRetry(adapter, "createHotelBookingReservation", [hotelBookingParams]);
      this.circuitBreaker.recordSuccess(provider);
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * Fetch Airline Pricing Breakdown
   */
  async getAirlinePricing(pricingParams) {
    const adapter = this.getAdapter(pricingParams.provider);
    return await adapter.getAirlinePricing(pricingParams);
  }

  /**
   * Cancel Live Flight Booking (PNR)
   */
  async cancelFlightBooking(cancelParams) {
    const adapter = this.getAdapter(cancelParams.provider);
    const result = await this._callWithRetry(adapter, "cancelBooking", [cancelParams]);

    publishEvent("FlightBookingCancelled", {
      tenantId: cancelParams.tenantId,
      provider: adapter.providerName,
      pnr: cancelParams.pnr,
      reason: cancelParams.reason
    });

    return result;
  }

  /**
   * Generic "call the provider through the circuit breaker + retry policy"
   * wrapper — "AI Coding Rules: Retry Policy, Circuit Breaker" apply to
   * every provider-facing ticketing action (issue/void/reissue/refund/
   * SSR/OSI/EMD), not just search and booking creation.
   */
  async _callProvider(provider, method, args) {
    if (!this.circuitBreaker.canAttempt(provider)) {
      throw new Error(`Provider ${provider} is currently unavailable (circuit breaker open).`);
    }
    const adapter = this.getAdapter(provider);
    try {
      const result = await this._callWithRetry(adapter, method, args);
      this.circuitBreaker.recordSuccess(provider);
      return { adapter, result };
    } catch (err) {
      this.circuitBreaker.recordFailure(provider);
      throw err;
    }
  }

  /**
   * Issue Electronic Airline Ticket
   */
  async issueTicket(ticketParams) {
    const { adapter, result } = await this._callProvider(ticketParams.provider, "issueTicket", [ticketParams]);

    publishEvent("TicketIssued", {
      tenantId: ticketParams.tenantId,
      provider: adapter.providerName,
      pnr: ticketParams.pnr,
      ticketNumbers: result.ticketNumbers
    });

    return result;
  }

  /**
   * Void Electronic Ticket
   */
  async voidTicket(voidParams) {
    const { adapter, result } = await this._callProvider(voidParams.provider, "voidTicket", [voidParams]);

    publishEvent("TicketVoided", {
      tenantId: voidParams.tenantId,
      provider: adapter.providerName,
      pnr: voidParams.pnr
    });

    return result;
  }

  /**
   * Reissue / Exchange Ticket
   */
  async reissueTicket(reissueParams) {
    const { adapter, result } = await this._callProvider(reissueParams.provider, "reissueTicket", [reissueParams]);

    publishEvent("TicketReissued", {
      tenantId: reissueParams.tenantId,
      provider: adapter.providerName,
      pnr: reissueParams.pnr,
      newTicketNumbers: result.newTicketNumbers
    });

    return result;
  }

  /**
   * Request Ticket Refund
   */
  async requestRefund(refundParams) {
    const { adapter, result } = await this._callProvider(refundParams.provider, "requestRefund", [refundParams]);

    publishEvent("RefundRequested", {
      tenantId: refundParams.tenantId,
      provider: adapter.providerName,
      pnr: refundParams.pnr
    });

    return result;
  }

  /**
   * Add Special Service Request (SSR)
   */
  async addSSR(ssrParams) {
    const { adapter, result } = await this._callProvider(ssrParams.provider, "addSSR", [ssrParams]);

    publishEvent("SSRAdded", {
      tenantId: ssrParams.tenantId,
      provider: adapter.providerName,
      code: ssrParams.code
    });

    return result;
  }

  /**
   * Search Live Hotel Availability across suppliers — "Cache Search
   * Results", "Provider fallback enabled". Previously never wrote to
   * searchCache at all, so GET /hotel-search/:searchId always 404'd and
   * revalidation had nothing real to look up. Mirrors searchFlights'
   * circuit-breaker + retry + fallback + cache pattern.
   */
  async searchHotels(searchParams) {
    const searchId = crypto.randomUUID();
    const tenantId = searchParams.tenantId || "default";

    publishEvent("HotelSearchRequested", { searchId, tenantId, searchParams });

    let activeProvider = searchParams.provider || this.primaryProvider;
    let result = null;
    let fallbackExecuted = false;

    if (this.circuitBreaker.canAttempt(activeProvider)) {
      try {
        const adapter = this.getAdapter(activeProvider);
        result = await this._callWithRetry(adapter, "searchHotels", [searchParams]);
        this.circuitBreaker.recordSuccess(activeProvider);
      } catch (err) {
        console.warn(`[GDS] Hotel provider ${activeProvider} failed. Executing fallback to ${this.secondaryProvider}...`);
        this.circuitBreaker.recordFailure(activeProvider);
      }
    }

    if (!result) {
      fallbackExecuted = true;
      activeProvider = this.secondaryProvider;
      if (!this.circuitBreaker.canAttempt(activeProvider)) {
        publishEvent("ProviderUnavailable", { searchId, tenantId, error: "Circuit breaker open for fallback provider." });
        throw new Error("All hotel supplier providers are currently unavailable.");
      }
      try {
        const fallbackAdapter = this.getAdapter(activeProvider);
        result = await this._callWithRetry(fallbackAdapter, "searchHotels", [searchParams]);
        this.circuitBreaker.recordSuccess(activeProvider);
      } catch (fallbackErr) {
        this.circuitBreaker.recordFailure(activeProvider);
        publishEvent("ProviderUnavailable", { searchId, tenantId, error: fallbackErr.message });
        throw new Error("All hotel supplier providers are currently unavailable.");
      }
    }

    const { searchCacheTtlSeconds } = getAmadeusHttpPolicy();
    const payload = {
      searchId,
      kind: "hotel",
      provider: activeProvider,
      fallbackExecuted,
      searchParams,
      meta: {
        totalOffers: result.hotels ? result.hotels.length : 0,
        currency: searchParams.currency || "PKR",
        searchTimestamp: new Date().toISOString(),
        expiresInSeconds: searchCacheTtlSeconds
      },
      results: result.hotels || []
    };

    searchCache.set(searchId, { data: payload, expiresAt: Date.now() + searchCacheTtlSeconds * 1000 });

    publishEvent("HotelSearchCompleted", { searchId, tenantId, totalOffers: payload.meta.totalOffers });

    return payload;
  }

  /**
   * Revalidate Hotel Offer Rate & Availability — "Offer Exists", "Offer
   * Valid", "Rooms Available". Previously a blind passthrough that always
   * returned `isValid: true` regardless of whether the offerId was ever
   * real. Now looks the offer up in the real search cache, same fix
   * pattern as revalidateOffer for flights.
   */
  async revalidateHotelOffer(revalidateParams) {
    const { offerId, tenantId } = revalidateParams;
    let matchedOffer = null;
    let matchedSearch = null;

    for (const entry of searchCache.values()) {
      if (Date.now() > entry.expiresAt) continue;
      if (entry.data.kind !== "hotel") continue;
      if (tenantId && entry.data.searchParams?.tenantId !== tenantId) continue;
      const found = entry.data.results.find((o) => o.offerId === offerId);
      if (found) {
        matchedOffer = found;
        matchedSearch = entry.data;
        break;
      }
    }

    if (!matchedOffer) {
      return {
        provider: revalidateParams.provider || this.primaryProvider,
        offerId,
        isValid: false,
        reason: "Hotel offer not found or the original search has expired. Please search again.",
        availableRooms: 0
      };
    }

    const adapter = this.getAdapter(matchedSearch.provider);
    const providerResult = await this._callWithRetry(adapter, "revalidateHotelOffer", [{ offerId, price: matchedOffer.price }]);
    const availableRooms = providerResult.availableRooms ?? matchedOffer.availableRooms ?? 0;

    return {
      provider: matchedSearch.provider,
      offerId,
      isValid: Boolean(providerResult.isValid) && availableRooms > 0,
      priceChanged: providerResult.currentPrice != null && providerResult.currentPrice !== matchedOffer.price,
      originalPrice: matchedOffer.price,
      currentPrice: providerResult.currentPrice ?? matchedOffer.price,
      currency: matchedOffer.currency,
      availableRooms,
      hotelName: matchedOffer.hotelName,
      city: matchedOffer.city,
      roomType: matchedOffer.roomType,
      mealPlan: matchedOffer.mealPlan,
      cancellationPolicy: matchedOffer.cancellationPolicy,
      requestedRooms: matchedSearch.searchParams?.rooms || 1,
      requestedGuests: (matchedSearch.searchParams?.adults || 0) + (matchedSearch.searchParams?.children || 0)
    };
  }

  /**
   * Create Live Hotel Reservation with Supplier
   */
  async createHotelBooking(bookingParams) {
    const { adapter, result } = await this._callProvider(bookingParams.provider, "createHotelBooking", [bookingParams]);

    publishEvent("HotelBooked", {
      tenantId: bookingParams.tenantId,
      provider: adapter.providerName,
      reservationNumber: result.reservationNumber,
      bookingResult: result
    });

    return result;
  }

  /**
   * Modify Existing Hotel Reservation
   */
  async modifyHotelBooking(modifyParams) {
    const { adapter, result } = await this._callProvider(modifyParams.provider, "modifyHotelBooking", [modifyParams]);

    publishEvent("HotelBookingModified", {
      tenantId: modifyParams.tenantId,
      provider: adapter.providerName,
      reservationNumber: modifyParams.reservationNumber
    });

    return result;
  }

  /**
   * Cancel Hotel Reservation
   */
  async cancelHotelBooking(cancelParams) {
    const { adapter, result } = await this._callProvider(cancelParams.provider, "cancelHotelBooking", [cancelParams]);

    publishEvent("HotelBookingCancelled", {
      tenantId: cancelParams.tenantId,
      provider: adapter.providerName,
      reservationNumber: cancelParams.reservationNumber
    });

    return result;
  }

  /**
   * Generate Hotel Accommodation Voucher
   */
  async generateHotelVoucher(voucherParams) {
    const { result } = await this._callProvider(voucherParams.provider, "generateHotelVoucher", [voucherParams]);

    publishEvent("VoucherGenerated", {
      tenantId: voucherParams.tenantId,
      voucherNumber: result.voucherNumber
    });

    return result;
  }

  /**
   * Synchronize Hotel Reservation with Supplier
   */
  async syncHotelBooking(syncParams) {
    const { adapter, result } = await this._callProvider(syncParams.provider, "syncHotelBooking", [syncParams.reservationNumber]);

    publishEvent("HotelBookingSynchronized", {
      tenantId: syncParams.tenantId,
      provider: adapter.providerName,
      reservationNumber: syncParams.reservationNumber
    });

    return result;
  }

  /**
   * Add Other Service Information (OSI)
   */
  async addOSI(osiParams) {
    const { adapter, result } = await this._callProvider(osiParams.provider, "addOSI", [osiParams]);

    publishEvent("OSIAdded", {
      tenantId: osiParams.tenantId,
      provider: adapter.providerName,
      code: osiParams.code
    });

    return result;
  }

  /**
   * Issue Electronic Miscellaneous Document (EMD)
   */
  async issueEMD(emdParams) {
    const { adapter, result } = await this._callProvider(emdParams.provider, "issueEMD", [emdParams]);

    publishEvent("EMDIssued", {
      tenantId: emdParams.tenantId,
      provider: adapter.providerName,
      emdNumber: result.emdNumber
    });

    return result;
  }

  /**
   * Check Provider Health & Circuit Status
   */
  async getProviderStatus() {
    const statuses = {};
    for (const [name, adapter] of Object.entries(this.adapters)) {
      const health = await adapter.checkHealth();
      statuses[name] = { ...health, circuitBreaker: this.circuitBreaker.getStatus(name) };
    }
    return statuses;
  }
}

export default new GdsIntegrationService();
