/**
 * Base GDS Provider Adapter Interface
 * All external GDS/Hotel provider adapters (Amadeus, Sabre, etc.) must implement this contract.
 */
class BaseGdsAdapter {
  constructor(providerName) {
    this.providerName = providerName;
  }

  async searchFlights(searchParams) {
    throw new Error(`searchFlights() not implemented in ${this.providerName}`);
  }

  async searchHotels(searchParams) {
    throw new Error(`searchHotels() not implemented in ${this.providerName}`);
  }

  async revalidateHotelOffer(revalidateParams) {
    throw new Error(`revalidateHotelOffer() not implemented in ${this.providerName}`);
  }

  async createHotelBooking(bookingParams) {
    throw new Error(`createHotelBooking() not implemented in ${this.providerName}`);
  }

  async modifyHotelBooking(modifyParams) {
    throw new Error(`modifyHotelBooking() not implemented in ${this.providerName}`);
  }

  async cancelHotelBooking(cancelParams) {
    throw new Error(`cancelHotelBooking() not implemented in ${this.providerName}`);
  }

  async generateHotelVoucher(voucherParams) {
    throw new Error(`generateHotelVoucher() not implemented in ${this.providerName}`);
  }

  async syncHotelBooking(pnr) {
    throw new Error(`syncHotelBooking() not implemented in ${this.providerName}`);
  }

  async revalidateOffer(revalidateParams) {
    throw new Error(`revalidateOffer() not implemented in ${this.providerName}`);
  }

  async getCalendarSearch(calendarParams) {
    throw new Error(`getCalendarSearch() not implemented in ${this.providerName}`);
  }

  async getFareRules(rulesParams) {
    throw new Error(`getFareRules() not implemented in ${this.providerName}`);
  }

  async getBaggageInfo(baggageParams) {
    throw new Error(`getBaggageInfo() not implemented in ${this.providerName}`);
  }

  async getSeatMap(seatMapParams) {
    throw new Error(`getSeatMap() not implemented in ${this.providerName}`);
  }

  async getAirlinePricing(pricingParams) {
    throw new Error(`getAirlinePricing() not implemented in ${this.providerName}`);
  }

  async createFlightBooking(bookingParams) {
    throw new Error(`createFlightBooking() not implemented in ${this.providerName}`);
  }

  async getFlightBookingByPnr(pnr) {
    throw new Error(`getFlightBookingByPnr() not implemented in ${this.providerName}`);
  }

  async cancelBooking(cancelParams) {
    throw new Error(`cancelBooking() not implemented in ${this.providerName}`);
  }

  async syncFlightBooking(pnr) {
    throw new Error(`syncFlightBooking() not implemented in ${this.providerName}`);
  }

  async createHotelBooking(bookingParams) {
    throw new Error(`createHotelBooking() not implemented in ${this.providerName}`);
  }

  async issueTicket(ticketParams) {
    throw new Error(`issueTicket() not implemented in ${this.providerName}`);
  }

  async voidTicket(voidParams) {
    throw new Error(`voidTicket() not implemented in ${this.providerName}`);
  }

  async reissueTicket(reissueParams) {
    throw new Error(`reissueTicket() not implemented in ${this.providerName}`);
  }

  async requestRefund(refundParams) {
    throw new Error(`requestRefund() not implemented in ${this.providerName}`);
  }

  async addSSR(ssrParams) {
    throw new Error(`addSSR() not implemented in ${this.providerName}`);
  }

  async addOSI(osiParams) {
    throw new Error(`addOSI() not implemented in ${this.providerName}`);
  }

  async issueEMD(emdParams) {
    throw new Error(`issueEMD() not implemented in ${this.providerName}`);
  }

  async cancelBooking(cancelParams) {
    throw new Error(`cancelBooking() not implemented in ${this.providerName}`);
  }

  async checkHealth() {
    return { provider: this.providerName, status: "UP", latencyMs: 45 };
  }

  // EXT-004/008/009/011-022 — AmadeusAdapter-only methods GdsIntegrationService
  // calls generically via `adapter[method](...)` for whichever provider the
  // caller selects. Without a base default here, selecting a provider (e.g.
  // Sabre) that hasn't implemented one of these throws a raw, unhandled
  // `TypeError: adapter.X is not a function` instead of the clean, caught,
  // mapped-to-4xx Error every other unimplemented method on this class
  // already produces.
  async getFlightOfferPricing(rawFlightOffer, options) {
    throw new Error(`getFlightOfferPricing() not implemented in ${this.providerName}`);
  }

  async getFlightOrderSeatMap(seatMapParams) {
    throw new Error(`getFlightOrderSeatMap() not implemented in ${this.providerName}`);
  }

  async assignSeats(seatAssignmentParams) {
    throw new Error(`assignSeats() not implemented in ${this.providerName}`);
  }

  async getFlightStatus(flightStatusParams) {
    throw new Error(`getFlightStatus() not implemented in ${this.providerName}`);
  }

  async getFlightSchedules(scheduleParams) {
    throw new Error(`getFlightSchedules() not implemented in ${this.providerName}`);
  }

  async searchLocations(locationParams) {
    throw new Error(`searchLocations() not implemented in ${this.providerName}`);
  }

  async getAirlinesByCodes(airlineLookupParams) {
    throw new Error(`getAirlinesByCodes() not implemented in ${this.providerName}`);
  }

  async getFlightInspiration(inspirationParams) {
    throw new Error(`getFlightInspiration() not implemented in ${this.providerName}`);
  }

  async getBrandedFares(brandedFareParams) {
    throw new Error(`getBrandedFares() not implemented in ${this.providerName}`);
  }

  async getAncillaryServices(ancillaryParams) {
    throw new Error(`getAncillaryServices() not implemented in ${this.providerName}`);
  }

  async searchHotelList(hotelListParams) {
    throw new Error(`searchHotelList() not implemented in ${this.providerName}`);
  }

  async getHotelOffers(hotelOfferParams) {
    throw new Error(`getHotelOffers() not implemented in ${this.providerName}`);
  }

  async getHotelOfferPricing(hotelPricingParams) {
    throw new Error(`getHotelOfferPricing() not implemented in ${this.providerName}`);
  }

  async createHotelBookingReservation(hotelBookingParams) {
    throw new Error(`createHotelBookingReservation() not implemented in ${this.providerName}`);
  }
}

export default BaseGdsAdapter;
