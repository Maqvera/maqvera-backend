import AmadeusAdapter from "./gds/AmadeusAdapter.js";
import SabreAdapter from "./gds/SabreAdapter.js";
import { publishEvent } from "../utils/eventBus.js";
import crypto from "crypto";

// In-Memory Search Cache (10 Minutes TTL)
const searchCache = new Map();

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
   * Executive Live Flight Search with Failover & Cache
   */
  async searchFlights(searchParams) {
    const searchId = crypto.randomUUID();
    const tenantId = searchParams.tenantId || "default";

    publishEvent("FlightSearchRequested", { searchId, tenantId, searchParams });

    let activeProvider = searchParams.preferredProvider || this.primaryProvider;
    let result = null;
    let fallbackExecuted = false;

    try {
      const adapter = this.getAdapter(activeProvider);
      result = await adapter.searchFlights(searchParams);
    } catch (err) {
      console.warn(`[GDS] Provider ${activeProvider} failed. Executing fallback to ${this.secondaryProvider}...`);
      fallbackExecuted = true;
      activeProvider = this.secondaryProvider;

      try {
        const fallbackAdapter = this.getAdapter(activeProvider);
        result = await fallbackAdapter.searchFlights(searchParams);

        publishEvent("ProviderFallbackExecuted", {
          searchId,
          tenantId,
          primaryProvider: this.primaryProvider,
          fallbackProvider: activeProvider
        });
      } catch (fallbackErr) {
        publishEvent("ProviderUnavailable", { searchId, tenantId, error: fallbackErr.message });
        throw new Error("All GDS Flight Search Providers are currently unavailable.");
      }
    }

    const payload = {
      searchId,
      provider: activeProvider,
      fallbackExecuted,
      searchParams,
      meta: {
        totalOffers: result.offers.length,
        currency: searchParams.currency || "PKR",
        searchTimestamp: new Date().toISOString(),
        expiresInSeconds: 600
      },
      results: result.offers
    };

    // Store in Search Cache with 10 Minute TTL
    searchCache.set(searchId, {
      data: payload,
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    publishEvent("FlightSearchCompleted", { searchId, tenantId, totalOffers: result.offers.length });
    publishEvent("FlightSearchCached", { searchId, tenantId, ttlSeconds: 600 });

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
   * Revalidate Flight Offer
   */
  async revalidateOffer(revalidateParams) {
    const adapter = this.getAdapter(revalidateParams.provider);
    return await adapter.revalidateOffer(revalidateParams);
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
    return await adapter.getFareRules(rulesParams);
  }

  /**
   * Fetch Baggage Policy
   */
  async getBaggageInfo(baggageParams) {
    const adapter = this.getAdapter(baggageParams.provider);
    return await adapter.getBaggageInfo(baggageParams);
  }

  /**
   * Fetch Seat Map
   */
  async getSeatMap(seatMapParams) {
    const adapter = this.getAdapter(seatMapParams.provider);
    return await adapter.getSeatMap(seatMapParams);
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
    const result = await adapter.cancelBooking(cancelParams);

    publishEvent("FlightBookingCancelled", {
      tenantId: cancelParams.tenantId,
      provider: adapter.providerName,
      pnr: cancelParams.pnr,
      reason: cancelParams.reason
    });

    return result;
  }

  /**
   * Issue Electronic Airline Ticket
   */
  async issueTicket(ticketParams) {
    const adapter = this.getAdapter(ticketParams.provider);
    const result = await adapter.issueTicket(ticketParams);

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
    const adapter = this.getAdapter(voidParams.provider);
    const result = await adapter.voidTicket(voidParams);

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
    const adapter = this.getAdapter(reissueParams.provider);
    const result = await adapter.reissueTicket(reissueParams);

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
    const adapter = this.getAdapter(refundParams.provider);
    const result = await adapter.requestRefund(refundParams);

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
    const adapter = this.getAdapter(ssrParams.provider);
    const result = await adapter.addSSR(ssrParams);

    publishEvent("SSRAdded", {
      tenantId: ssrParams.tenantId,
      provider: adapter.providerName,
      code: ssrParams.code
    });

    return result;
  }

  /**
   * Search Live Hotel Availability across suppliers
   */
  async searchHotels(searchParams) {
    const searchId = crypto.randomUUID();
    const tenantId = searchParams.tenantId || "default";

    publishEvent("HotelSearchRequested", { searchId, tenantId, searchParams });

    const adapter = this.getAdapter(searchParams.provider || "Amadeus");
    const result = await adapter.searchHotels(searchParams);

    const payload = {
      searchId,
      provider: adapter.providerName,
      searchParams,
      meta: {
        totalOffers: result.hotels ? result.hotels.length : 0,
        currency: searchParams.currency || "PKR",
        searchTimestamp: new Date().toISOString(),
        expiresInSeconds: 600
      },
      results: result.hotels || []
    };

    publishEvent("HotelSearchCompleted", { searchId, tenantId, totalOffers: payload.meta.totalOffers });

    return payload;
  }

  /**
   * Revalidate Hotel Offer Rate & Availability
   */
  async revalidateHotelOffer(revalidateParams) {
    const adapter = this.getAdapter(revalidateParams.provider);
    return await adapter.revalidateHotelOffer(revalidateParams);
  }

  /**
   * Create Live Hotel Reservation with Supplier
   */
  async createHotelBooking(bookingParams) {
    const adapter = this.getAdapter(bookingParams.provider);
    const result = await adapter.createHotelBooking(bookingParams);

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
    const adapter = this.getAdapter(modifyParams.provider);
    const result = await adapter.modifyHotelBooking(modifyParams);

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
    const adapter = this.getAdapter(cancelParams.provider);
    const result = await adapter.cancelHotelBooking(cancelParams);

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
    const adapter = this.getAdapter(voucherParams.provider);
    const result = await adapter.generateHotelVoucher(voucherParams);

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
    const adapter = this.getAdapter(syncParams.provider);
    const result = await adapter.syncHotelBooking(syncParams.reservationNumber);

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
    const adapter = this.getAdapter(osiParams.provider);
    const result = await adapter.addOSI(osiParams);

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
    const adapter = this.getAdapter(emdParams.provider);
    const result = await adapter.issueEMD(emdParams);

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
      statuses[name] = await adapter.checkHealth();
    }
    return statuses;
  }
}

export default new GdsIntegrationService();
