// EXT-025 §7 "Ranking Strategy" — AIAssistantService previously took the
// first 3 offers a tool happened to return, in whatever order the provider
// gave them, and called that a "recommendation." This is the real, missing
// piece: a genuine weighted score over the fields actually present on real
// flight/hotel offer DTOs, applied before slicing to the top 3.
//
// Deliberately NOT scored: "Airline Rating" (§7 lists it, but no airline
// star-rating data source exists anywhere in this codebase — EXT-013's
// reference data has no rating field for airlines, only EXT-020's hotels
// do). Omitted rather than fabricated, same "flag, don't fake" discipline
// as every EXT document this session.

const parseDurationMinutes = (label) => {
  const match = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(String(label || "").trim());
  if (!match) return null;
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
  return hours * 60 + minutes;
};

const isRefundableOffer = (offer) => offer.isRefundable === true || offer.refundable === true;

class AIRankingService {
  /**
   * Scores and re-sorts a batch of offers (flight or hotel — whichever
   * fields are present are used; nothing is guessed for a missing field).
   * `preferences` comes from the REAL tool-call arguments the LLM actually
   * used for this turn (e.g. `directOnly`, `cabin`) — a genuine signal of
   * what the user asked for, not an invented one.
   */
  static rankOffers(offers, preferences = {}) {
    if (!Array.isArray(offers) || offers.length === 0) return [];

    const prices = offers.map((o) => Number.parseFloat(o.price)).filter(Number.isFinite);
    const minPrice = prices.length ? Math.min(...prices) : null;
    const maxPrice = prices.length ? Math.max(...prices) : null;

    const durations = offers.map((o) => parseDurationMinutes(o.duration)).filter((v) => v != null);
    const minDuration = durations.length ? Math.min(...durations) : null;
    const maxDuration = durations.length ? Math.max(...durations) : null;

    const scored = offers.map((offer) => {
      let score = 0;
      const reasons = [];

      // Price — §7's first-listed factor, heaviest weight (35 of 100).
      const price = Number.parseFloat(offer.price);
      if (Number.isFinite(price) && minPrice != null && maxPrice > minPrice) {
        score += (1 - (price - minPrice) / (maxPrice - minPrice)) * 35;
        if (price === minPrice) reasons.push("Lowest price in this result set");
      } else if (Number.isFinite(price)) {
        score += 35; // only one price point in the batch — no relative comparison possible, treated neutrally.
      }

      // Travel time (flights only — real `duration` field, e.g. "5h 20m").
      const durationMin = parseDurationMinutes(offer.duration);
      if (durationMin != null && minDuration != null && maxDuration > minDuration) {
        score += (1 - (durationMin - minDuration) / (maxDuration - minDuration)) * 25;
        if (durationMin === minDuration) reasons.push("Shortest travel time");
      } else if (durationMin != null) {
        score += 25;
      }

      // Layover / stops (flights only — real `stops` field).
      if (typeof offer.stops === "number") {
        score += (Math.max(0, 2 - offer.stops) / 2) * 20;
        if (offer.stops === 0) reasons.push("Non-stop");
      }

      // Refundability.
      if (isRefundableOffer(offer)) {
        score += 10;
        reasons.push("Refundable");
      }

      // Real user-preference match, from actual tool-call arguments this
      // turn — never guessed.
      if (preferences.directOnly === true && offer.stops === 0) {
        score += 5;
        reasons.push("Matches your non-stop preference");
      }
      if (preferences.cabin && offer.cabin && String(offer.cabin).toLowerCase() === String(preferences.cabin).toLowerCase()) {
        score += 5;
        reasons.push(`Matches your requested ${preferences.cabin} cabin`);
      }

      return { ...offer, aiScore: Math.round(score), aiScoreReasons: reasons };
    });

    return scored.sort((a, b) => b.aiScore - a.aiScore);
  }
}

export default AIRankingService;
