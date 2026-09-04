// Structured, validated shape for BookingServiceModel.details when
// serviceType === "hotel" — see PRD item A8. BookingServiceModel.details
// stays Mongoose Mixed (shared by every other serviceType, which remain
// free-form ad-hoc line items), but for hotel services every write must
// pass through normalizeHotelServiceDetails() so the stored object always
// has the same explicit, validated field set instead of an arbitrary blob.
export const REQUIRED_HOTEL_DETAIL_FIELDS = ["hotelName", "roomType", "adultCount", "checkIn", "checkOut"];

export const computeNights = (checkIn, checkOut) => {
  const msPerNight = 24 * 60 * 60 * 1000;
  return Math.max(Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / msPerNight), 0);
};

// Nights is always the server-computed value derived from checkIn/checkOut.
// A caller-supplied override never replaces it silently — it's kept as a
// separate, audited overrideNights field alongside who/why/when.
export const normalizeHotelServiceDetails = (rawDetails = {}, { performedBy = null, existing = null } = {}) => {
  const merged = { ...(existing || {}), ...(rawDetails || {}) };

  const missing = REQUIRED_HOTEL_DETAIL_FIELDS.filter((field) => merged[field] === undefined || merged[field] === null || merged[field] === "");
  if (missing.length > 0) {
    throw new Error(`Missing required hotel detail field(s): ${missing.join(", ")}`);
  }

  const checkIn = new Date(merged.checkIn);
  const checkOut = new Date(merged.checkOut);
  if (Number.isNaN(checkIn.getTime()) || Number.isNaN(checkOut.getTime())) {
    throw new Error("checkIn and checkOut must be valid dates.");
  }
  if (checkOut <= checkIn) {
    throw new Error("checkOut must be after checkIn.");
  }

  const normalized = {
    hotelName: `${merged.hotelName}`.trim(),
    hotelConfirmationNumber: merged.hotelConfirmationNumber ? `${merged.hotelConfirmationNumber}`.trim() : null,
    city: merged.city ? `${merged.city}`.trim() : null,
    season: merged.season ? `${merged.season}`.trim() : null,
    roomType: `${merged.roomType}`.trim(),
    roomQuantity: Math.max(parseInt(merged.roomQuantity, 10) || 1, 1),
    view: merged.view ? `${merged.view}`.trim().toLowerCase() : null,
    adultCount: Math.max(parseInt(merged.adultCount, 10) || 0, 1),
    childCount: Math.max(parseInt(merged.childCount, 10) || 0, 0),
    infantCount: Math.max(parseInt(merged.infantCount, 10) || 0, 0),
    mealPlan: merged.mealPlan ? `${merged.mealPlan}`.trim().toLowerCase() : null,
    mealPrice: Number(merged.mealPrice) || 0,
    checkIn,
    checkOut,
    nights: computeNights(checkIn, checkOut),
    ratePerNight: Number(merged.ratePerNight) || 0,
    overrideNights: null,
    overrideNightsReason: null,
    overriddenBy: null,
    overriddenAt: null
  };

  if (merged.overrideNights !== undefined && merged.overrideNights !== null && merged.overrideNights !== "") {
    const overrideValue = parseInt(merged.overrideNights, 10);
    if (!Number.isFinite(overrideValue) || overrideValue < 1) {
      throw new Error("overrideNights must be a positive integer.");
    }
    if (!merged.overrideNightsReason || !`${merged.overrideNightsReason}`.trim()) {
      throw new Error("overrideNightsReason is required when overrideNights is provided.");
    }
    normalized.overrideNights = overrideValue;
    normalized.overrideNightsReason = `${merged.overrideNightsReason}`.trim();
    normalized.overriddenBy = performedBy;
    normalized.overriddenAt = new Date();
  }

  if (merged.catalogServiceId) {
    normalized.catalogServiceId = merged.catalogServiceId;
  }

  return normalized;
};

// Effective nights for downstream consumers (voucher/invoice rendering,
// pricing) — the audited override when present, otherwise the computed value.
export const effectiveNights = (hotelDetails) => {
  if (!hotelDetails) return 0;
  return hotelDetails.overrideNights ?? hotelDetails.nights ?? 0;
};
