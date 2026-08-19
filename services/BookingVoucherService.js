import BookingHeaderModel from "../models/BookingHeaderModel.js";
import BookingVoucherModel from "../models/BookingVoucherModel.js";
import BookingServiceModel from "../models/BookingServiceModel.js";
import BookingTravelerModel from "../models/BookingTravelerModel.js";
import CustomerModel from "../models/CustomerModel.js";
import HotelBookingModel from "../models/HotelBookingModel.js";
import FlightBookingModel from "../models/FlightBookingModel.js";
import CarRentalBookingModel from "../models/CarRentalBookingModel.js";
import NumberGeneratorService from "./NumberGeneratorService.js";
import BookingVoucherPdfService from "./BookingVoucherPdfService.js";
import storeDocumentPdf from "../utils/documentPdfStorage.js";
import { resolveTenantBranding, resolveTenantDocumentSettings } from "../utils/tenantBranding.js";
import { validateBookingForDocumentGeneration } from "../utils/bookingDocumentValidation.js";
import { effectiveNights } from "../utils/hotelServiceDetails.js";
import InvoiceDocumentQrService from "./InvoiceDocumentQrService.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

/**
 * Orchestrates Client Voucher generation (booking-module PRD Part B item
 * #7): gathers the booking's own real data (never a supplier-response
 * field), mints a real voucher number, renders + stores the PDF, and
 * persists an immutable snapshot of what was rendered — same
 * generate -> store -> persist shape as InvoiceService._generatePdf.
 */
class BookingVoucherService {
  static async generateVoucher(bookingId, tenantId, userId) {
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
    if (!booking) throw new Error("Booking not found.");

    const [customer, hotelLegs, flightLegs, carRentalLegs, company, documentSettings, travelers, manualHotelServices, transportServices, ziyaratServices] = await Promise.all([
      CustomerModel.findOne({ _id: booking.customerId, tenantId }).lean(),
      HotelBookingModel.find({ bookingId, tenantId }).lean(),
      FlightBookingModel.find({ bookingId, tenantId }).lean(),
      CarRentalBookingModel.find({ bookingId, tenantId }).lean(),
      resolveTenantBranding(tenantId),
      resolveTenantDocumentSettings(tenantId),
      BookingTravelerModel.find({ bookingId, tenantId, status: "active" }).lean(),
      BookingServiceModel.find({ bookingId, tenantId, serviceType: "hotel", status: "active" }).lean(),
      // "Transport" / "Mazarat" (Ziyarat — religious-site visits) are real,
      // already-modeled BookingServiceModel.serviceType values, not an
      // unmodeled concept — surfaced here rather than left as a permanently
      // blank template field.
      BookingServiceModel.find({ bookingId, tenantId, serviceType: "transport", status: "active" }).lean(),
      BookingServiceModel.find({ bookingId, tenantId, serviceType: "ziyarat", status: "active" }).lean()
    ]);
    if (!customer) throw new Error("Customer not found.");

    // PRD A10 — block generation with a named list of missing fields rather
    // than rendering a voucher with blanks. hotelServices here covers both
    // the manual/AI-parsed path (BookingServiceModel.details, PRD A8) and
    // the GDS path is validated separately below via manualHotelServices +
    // hotelLegs together, since either source can satisfy "a hotel exists".
    validateBookingForDocumentGeneration(booking, {
      travelers,
      hotelServices: hotelLegs.length === 0 ? manualHotelServices : []
    });

    // Manual/AI-parsed hotel bookings (no GDS HotelBookingModel record) —
    // PRD A5's own gap: this voucher used to only read the GDS legs above
    // and silently produced an empty typeDetails.hotels for a
    // manually-created or supplier-PDF-extracted booking (PRD A8's
    // structured BookingServiceModel.details). Normalized into the same
    // shape as a GDS hotel leg so the PDF template doesn't need to branch.
    // Field names deliberately match HotelBookingModel's GDS leg shape
    // (city/roomType/mealPlan/checkIn/checkOut/roomsCount/guestsCount) so
    // BookingVoucherPdfService's rendering loop doesn't need to branch by
    // source.
    const manualHotelLegs = manualHotelServices.map((s) => {
      const d = s.details || {};
      return {
        hotelName: d.hotelName || s.serviceName,
        // Field name matches HotelBookingModel's GDS-leg shape (see below)
        // so the PDF template never needs to branch by source.
        hotelConfirmationNumber: d.hotelConfirmationNumber || null,
        city: d.city || null,
        roomType: d.roomType || null,
        view: d.view || null,
        mealPlan: d.mealPlan || null,
        // utils/hotelServiceDetails.js's normalization schema names this
        // `ratePerNight`/`season`/`mealPrice` — aliased/passed through here
        // to match HotelBookingModel's own field names (roomRatePerNight),
        // same "one shape for both sources" convention as roomsCount/
        // guestsCount below.
        roomRatePerNight: d.ratePerNight != null ? Number(d.ratePerNight) : null,
        mealPrice: d.mealPrice != null ? Number(d.mealPrice) : null,
        season: d.season || null,
        checkIn: d.checkIn || null,
        checkOut: d.checkOut || null,
        nights: effectiveNights(d),
        roomsCount: d.roomQuantity || 1,
        guestsCount: (d.adultCount || 0) + (d.childCount || 0) + (d.infantCount || 0) || 1
      };
    });

    // GDS-sourced legs (HotelBookingModel) already carry roomRatePerNight/
    // mealPrice/season/city/view as real top-level fields — only
    // `hotelConfirmationNumber` needs normalizing onto the same name the
    // manual path above uses (the GDS model's own field is
    // providerConfirmationNumber/reservationNumber).
    const normalizedHotelLegs = hotelLegs.map((h) => ({ ...h, hotelConfirmationNumber: h.providerConfirmationNumber || h.reservationNumber || null }));

    const generated = await NumberGeneratorService.generateNumber(tenantId, { resourceType: "Voucher" }, userId || null);
    const voucherNumber = generated.documentNumber;
    const generatedAt = new Date();

    // PRD Issue 1 — same additive fields as InvoiceService's own
    // _resolveBookingDetailsForPdf; PRD Issue 6c — guest (the traveler) is
    // deliberately kept separate from client (the booking company/
    // individual) below, since these can legitimately be different people.
    const primaryTraveler = travelers.find((t) => t.isPrimary || t.isPrimaryTraveler) || travelers[0] || null;
    const guest = {
      name: primaryTraveler ? `${primaryTraveler.firstName || ""} ${primaryTraveler.lastName || ""}`.trim() : null,
      nationality: primaryTraveler?.nationality || null,
      mobile: primaryTraveler?.customerSnapshot?.snapshotPhone || null
    };
    const client = {
      companyName: customer.companyName || null,
      individualName: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || null
    };

    const customerSnapshot = {
      name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.companyName || "Customer",
      email: customer.email || null,
      phone: customer.phone || null
    };
    const bookingSnapshot = {
      bookingNumber: booking.bookingNumber || booking.bookingReference,
      bookingType: booking.bookingType,
      bookingStatus: booking.status,
      travelDate: booking.travelDate,
      returnDate: booking.returnDate
    };
    const effectiveHotelLegs = normalizedHotelLegs.length > 0 ? normalizedHotelLegs : manualHotelLegs;
    const typeDetails = {
      ...(effectiveHotelLegs.length > 0 ? { hotels: effectiveHotelLegs } : {}),
      ...(flightLegs.length > 0 ? { flights: flightLegs } : {}),
      ...(carRentalLegs.length > 0 ? { carRentals: carRentalLegs } : {}),
      transport: transportServices.map((s) => s.serviceName).join(", ") || null,
      mazarat: ziyaratServices.map((s) => s.serviceName).join(", ") || null
    };

    // Every voucher generation mints a fresh document (this service never
    // updates one in place — see BookingVoucherModel.js's snapshot-over-live
    // doc comment), so there's no "reuse existing token" case here unlike
    // InvoiceService, which mutates one long-lived document.
    const qrAccessToken = InvoiceDocumentQrService.generateAccessToken();
    const viewUrl = InvoiceDocumentQrService.buildViewUrl(getFinanceConfig().receiptVerificationBaseUrl, qrAccessToken);
    const qrPngBuffer = await InvoiceDocumentQrService.generateQrPngBuffer(viewUrl);
    const qrCodeDataUri = `data:image/png;base64,${qrPngBuffer.toString("base64")}`;

    const buffer = await BookingVoucherPdfService.generatePdfBuffer({
      voucherNumber, generatedAt, generatedBy: userId || null,
      // No distinct "print" action/timestamp exists in this codebase for a
      // voucher (unlike a receipt's download counter) — printedBy is the
      // same generating user at generation time, same pragmatic resolution
      // InvoiceService uses for its own printedBy.
      printedBy: userId || null,
      company, customer: customerSnapshot, guest, client, booking: bookingSnapshot, typeDetails, documentSettings, qrCodeDataUri
    });
    const stored = await storeDocumentPdf({ tenantId, folder: "booking-vouchers", filename: `${voucherNumber}.pdf`, buffer });

    const voucher = await BookingVoucherModel.create({
      tenantId,
      bookingId: booking._id,
      voucherNumber,
      pdfUrl: stored.url,
      qrAccessToken,
      // Frozen at generation time — see BookingVoucherModel.js's own doc
      // comment on the snapshot-vs-live decision this field encodes.
      snapshotData: { company, customer: customerSnapshot, guest, client, booking: bookingSnapshot, typeDetails, documentSettings },
      generatedAt,
      generatedBy: userId || null
    });

    return voucher.toJSON();
  }

  static async listVouchers(bookingId, tenantId) {
    return BookingVoucherModel.find({ bookingId, tenantId }).sort({ createdAt: -1 }).lean();
  }
}

export default BookingVoucherService;
