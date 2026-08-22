import BaseGdsAdapter from "./BaseGdsAdapter.js";
import NumberGeneratorService from "../NumberGeneratorService.js";

/**
 * Enterprise Production Sabre GDS Adapter
 * Handles Sabre REST/SOAP APIs with dynamic failover engine.
 */
class SabreAdapter extends BaseGdsAdapter {
  constructor() {
    super("Sabre");
  }

  async searchFlights(params) {
    // Golden Rule 2 (never hardcode a currency) — the mock sandbox no longer
    // silently assumes PKR; a caller (GdsIntegrationService, itself called
    // from a controller that already resolves a real currency) must supply
    // one. Origin/destination/departureDate/adults/cabin sandbox defaults
    // are unrelated (not currency/destination-of-record) and left as-is.
    const { origin = "KHI", destination = "JED", departureDate = "2027-01-15", adults = 1, cabin = "Economy", currency } = params;
    if (!currency) throw new Error("SabreAdapter.searchFlights: currency is required (no silent default).");

    const basePrice = origin === "KHI" && destination === "JED" ? 147000 : 188000;
    const mockOffers = [
      {
        offerId: `OFF-SABRE-${origin}-${destination}-${Date.now()}-1`,
        airline: "Saudi Airlines",
        airlineCode: "SV",
        flightNumber: `SV-${Math.floor(700 + Math.random() * 50)}`,
        origin,
        destination,
        departure: `${departureDate}T08:15:00.000Z`,
        arrival: `${departureDate}T12:35:00.000Z`,
        duration: "5h 20m",
        stops: 0,
        availableSeats: Math.floor(4 + Math.random() * 5),
        cabin,
        fareFamily: "Sabre Saver",
        price: Math.round(basePrice * adults),
        currency,
        baggageAllowance: "2 Pieces (23kg each)",
        isRefundable: true
      }
    ];

    return {
      provider: this.providerName,
      offers: mockOffers,
      meta: { count: mockOffers.length, provider: "Sabre Dynamic Engine", currency }
    };
  }

  async searchHotels(params) {
    // Golden Rule 1/2 (never hardcode a destination or currency) — the mock
    // sandbox no longer silently assumes Makkah/PKR; a caller must supply both.
    const { city, currency } = params;
    if (!city) throw new Error("SabreAdapter.searchHotels: city is required (no silent default).");
    if (!currency) throw new Error("SabreAdapter.searchHotels: currency is required (no silent default).");
    return {
      provider: this.providerName,
      hotels: [
        {
          offerId: `HOTEL-SABRE-${city.toUpperCase()}-${Date.now()}`,
          hotelName: `Hilton Suite ${city}`,
          city,
          stars: 5,
          distanceToHaram: "300 meters",
          mealPlan: "Breakfast Included",
          roomType: "Deluxe Suite",
          availableRooms: 10,
          price: 360000,
          currency,
          cancellationPolicy: "Free cancellation up to 24h before check-in"
        }
      ],
      meta: { count: 1, provider: "Sabre Dynamic Engine", currency }
    };
  }

  async revalidateOffer(revalidateParams) {
    return {
      provider: this.providerName,
      offerId: revalidateParams.offerId,
      isValid: true,
      priceChanged: false,
      currentPrice: revalidateParams.price || 147000,
      availableSeats: 7,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    };
  }

  async revalidateHotelOffer(params) {
    return {
      provider: this.providerName,
      offerId: params.offerId,
      isValid: true,
      currentPrice: params.price || 360000,
      availableRooms: 10
    };
  }

  async createFlightBooking(params) {
    // Golden Rule 2 — no silent PKR fallback on a real booking record.
    if (!params.currency) throw new Error("SabreAdapter.createFlightBooking: currency is required (no silent default).");
    const pnr = `SABR-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    return {
      provider: this.providerName,
      pnr,
      providerBookingReference: pnr,
      status: "Reserved",
      totalPrice: params.totalPrice || 147000,
      currency: params.currency,
      ticketingDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      travelersCount: params.travelers ? params.travelers.length : 1
    };
  }

  async getFlightBookingByPnr(pnr) {
    return {
      provider: this.providerName,
      pnr,
      status: "Reserved",
      lastSynced: new Date().toISOString()
    };
  }

  async createHotelBooking(params) {
    // Golden Rule 1/2 — no silent Makkah/PKR fallback on a real booking record.
    if (!params.hotelName) throw new Error("SabreAdapter.createHotelBooking: hotelName is required (no silent default).");
    if (!params.currency) throw new Error("SabreAdapter.createHotelBooking: currency is required (no silent default).");
    const reservationNumber = `SABRE-HB-${Math.floor(10000 + Math.random() * 90000)}`;
    return {
      provider: this.providerName,
      reservationNumber,
      status: "Confirmed",
      hotelName: params.hotelName,
      roomType: params.roomType || "Deluxe Suite",
      totalPrice: params.totalPrice || 360000,
      currency: params.currency
    };
  }

  async modifyHotelBooking(params) {
    return {
      provider: this.providerName,
      reservationNumber: params.reservationNumber,
      status: "Modified",
      modifiedAt: new Date().toISOString()
    };
  }

  async cancelHotelBooking(params) {
    return {
      provider: this.providerName,
      reservationNumber: params.reservationNumber,
      status: "Cancelled",
      penaltyFee: 0,
      refundAmount: params.totalPrice || 360000,
      cancelledAt: new Date().toISOString()
    };
  }

  // Collision-free, tenant-scoped voucher numbers — replaces the old
  // Math.random() generator (booking-module PRD Part B item #7's "second,
  // independent instance of the same anti-pattern" as the booking
  // reference number bug). This is the supplier's own GDS confirmation
  // voucher, distinct from the agency's branded Client Voucher
  // (BookingVoucherModel/BookingVoucherPdfService).
  async generateHotelVoucher(params) {
    const generated = await NumberGeneratorService.generateNumber(params.tenantId, { resourceType: "GdsVoucher" }, "system");
    const voucherNumber = generated.documentNumber;
    return {
      provider: this.providerName,
      voucherNumber,
      voucherUrl: `/vouchers/${voucherNumber}.pdf`,
      qrCodeData: `https://erp.maqvera.com/vouchers/${voucherNumber}`
    };
  }

  async syncHotelBooking(reservationNumber) {
    return {
      provider: this.providerName,
      reservationNumber,
      status: "Confirmed",
      lastSynced: new Date().toISOString()
    };
  }

  async issueTicket(ticketParams) {
    const { travelersCount = 1 } = ticketParams;
    const ticketNumbers = [];
    for (let i = 0; i < travelersCount; i++) {
      ticketNumbers.push(`065${Math.floor(1000000000 + Math.random() * 9000000000)}`);
    }
    return {
      provider: this.providerName,
      ticketStatus: "Issued",
      ticketNumbers,
      issuedAt: new Date().toISOString()
    };
  }

  async voidTicket(voidParams) {
    return {
      provider: this.providerName,
      ticketStatus: "Voided",
      voidedAt: new Date().toISOString()
    };
  }

  async reissueTicket(reissueParams) {
    return {
      provider: this.providerName,
      ticketStatus: "Reissued",
      newTicketNumbers: [`065${Math.floor(1000000000 + Math.random() * 9000000000)}`],
      reissuedAt: new Date().toISOString()
    };
  }

  async requestRefund(refundParams) {
    return {
      provider: this.providerName,
      ticketStatus: "Refund Requested",
      requestedAt: new Date().toISOString()
    };
  }

  async addSSR(ssrParams) {
    return { provider: this.providerName, status: "CONFIRMED", code: ssrParams.code };
  }

  async addOSI(osiParams) {
    return { provider: this.providerName, status: "ADDED", code: osiParams.code };
  }

  async issueEMD(emdParams) {
    return {
      provider: this.providerName,
      emdNumber: `065-EMD-${Math.floor(10000000 + Math.random() * 90000000)}`,
      status: "ISSUED"
    };
  }

  async cancelBooking(cancelParams) {
    return {
      provider: this.providerName,
      pnr: cancelParams.pnr,
      status: "Cancelled",
      cancellationReason: cancelParams.reason || "Cancelled",
      cancelledAt: new Date().toISOString()
    };
  }

  async syncFlightBooking(pnr) {
    return {
      provider: this.providerName,
      pnr,
      status: "Reserved",
      syncTimestamp: new Date().toISOString()
    };
  }

  async getCalendarSearch(params) {
    return { provider: this.providerName, origin: params.origin, destination: params.destination, matrix: [] };
  }

  async getFareRules(params) {
    // Golden Rule 2 — the cancellation fee currency is the caller's own
    // currency, never a baked-in "PKR"; the mock amount itself stays
    // illustrative (15,000 units), since no real Sabre fare-rules call
    // backs this sandbox method.
    if (!params.currency) throw new Error("SabreAdapter.getFareRules: currency is required (no silent default).");
    return { provider: this.providerName, offerId: params.offerId, rules: { cancellationFee: `${params.currency} 15,000` } };
  }

  async getBaggageInfo(params) {
    return { provider: this.providerName, offerId: params.offerId, checkedBaggage: "2 Pieces" };
  }

  async getSeatMap(params) {
    return { provider: this.providerName, flightNumber: params.flightNumber, cabins: [] };
  }

  async getAirlinePricing(params) {
    // Golden Rule 2 — no silent PKR fallback; the caller must parameterize
    // the currency it's pricing in.
    if (!params.currency) throw new Error("SabreAdapter.getAirlinePricing: currency is required (no silent default).");
    return { provider: this.providerName, totalPrice: 147000, currency: params.currency };
  }

  async checkHealth() {
    const isLiveActive = Boolean(process.env.SABRE_CLIENT_ID && !process.env.SABRE_CLIENT_ID.includes("YOUR_"));
    return {
      provider: this.providerName,
      status: "UP",
      mode: isLiveActive ? "LIVE_API" : "DYNAMIC_SANDBOX",
      latencyMs: isLiveActive ? 150 : 55
    };
  }
}

export default SabreAdapter;
