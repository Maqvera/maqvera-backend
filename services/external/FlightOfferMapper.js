/**
 * FlightOfferMapper — EXT-002 §10/§11. Maps a provider adapter's internal
 * offer shape (currently only AmadeusAdapter's) into the Standard Flight
 * DTO every external-integration consumer receives, so "Controllers never
 * expose Amadeus models" stays literally true.
 *
 * This is intentionally a SEPARATE shape from the one API-006B/006C/006D/
 * AIToolRegistry already consume internally (`offerId`/`price`/`departure`/
 * ...) — renaming those fields now would be a breaking change across four
 * already-shipped, tested modules. The mapper translates, it doesn't
 * replace, the internal shape.
 */
class FlightOfferMapper {
  static toDTO(offer, provider = "Amadeus") {
    const segments = Array.isArray(offer.segments) && offer.segments.length > 0
      ? offer.segments
      : [{
          airline: offer.airline,
          airlineCode: offer.airlineCode,
          flightNumber: offer.flightNumber,
          origin: offer.origin,
          destination: offer.destination,
          departureTime: offer.departure,
          arrivalTime: offer.arrival,
          duration: offer.duration
        }];

    return {
      provider,
      providerOfferId: offer.offerId,
      // EXT-003 §8 "Price Expiry Validation" — real timestamp of when this
      // offer was actually retrieved, so a pricing-verification call can
      // genuinely check how stale it is instead of trusting an offer with
      // no way to know its own age.
      searchedAt: new Date().toISOString(),
      airline: offer.airline,
      airlineCode: offer.airlineCode,
      flightNumber: offer.flightNumber,
      origin: offer.origin,
      destination: offer.destination,
      departureTime: offer.departure,
      arrivalTime: offer.arrival,
      duration: offer.duration,
      cabin: offer.cabin,
      availableSeats: offer.availableSeats,
      baggage: offer.baggageAllowance,
      totalPrice: offer.price,
      currency: offer.currency,
      fareType: offer.fareFamily,
      refundable: Boolean(offer.isRefundable),
      segments,
      // Honest either way: the real raw Amadeus API item when live data was
      // used, or an explicit note when this is the dynamic-sandbox fallback
      // (no live AMADEUS_CLIENT_ID/SECRET configured) — never presented as
      // if it came from the real provider.
      rawProviderData: offer._source === "live"
        ? offer._raw
        : { source: "dynamic-sandbox", note: "No live Amadeus credentials configured; this offer is synthetic development data, not a real provider response." }
    };
  }

  static toDTOList(offers, provider = "Amadeus") {
    return (offers || []).map((offer) => this.toDTO(offer, provider));
  }
}

export default FlightOfferMapper;
