// PRD A10 — shared pre-generation gate for booking-driven documents
// (Invoice: POST /bookings/:bookingId/invoice, Voucher: POST
// /bookings/:bookingId/vouchers). Required fields (guest name, hotel,
// check-in/out, room type, PAX, reference, status) must all be present
// before a PDF is rendered — missing data blocks generation with a named
// list of what's missing, rather than producing a document with blanks.
export const validateBookingForDocumentGeneration = (booking, { travelers = [], hotelServices = [] } = {}) => {
  const missing = [];

  if (!booking) {
    throw new Error("Booking not found.");
  }
  if (!booking.bookingReference && !booking.bookingNumber) missing.push("booking reference");
  if (!booking.status) missing.push("booking status");

  const primaryTraveler = travelers.find((t) => t.isPrimary || t.isPrimaryTraveler) || travelers[0] || null;
  if (!primaryTraveler) {
    missing.push("guest/traveler");
  } else if (!`${primaryTraveler.firstName || ""}`.trim() && !`${primaryTraveler.lastName || ""}`.trim()) {
    missing.push("guest name");
  }

  hotelServices.forEach((service, index) => {
    const label = hotelServices.length > 1 ? ` (hotel service ${index + 1})` : "";
    const details = service.details || {};
    if (!details.hotelName) missing.push(`hotel name${label}`);
    if (!details.checkIn) missing.push(`check-in date${label}`);
    if (!details.checkOut) missing.push(`check-out date${label}`);
    if (!details.roomType) missing.push(`room type${label}`);
    if (!details.adultCount) missing.push(`PAX${label}`);
  });

  if (missing.length > 0) {
    throw new Error(`Cannot generate document — missing required field(s): ${missing.join(", ")}`);
  }
};
