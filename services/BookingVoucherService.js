import BookingHeaderModel from "../models/BookingHeaderModel.js";
import BookingVoucherModel from "../models/BookingVoucherModel.js";
import CustomerModel from "../models/CustomerModel.js";
import HotelBookingModel from "../models/HotelBookingModel.js";
import FlightBookingModel from "../models/FlightBookingModel.js";
import CarRentalBookingModel from "../models/CarRentalBookingModel.js";
import NumberGeneratorService from "./NumberGeneratorService.js";
import BookingVoucherPdfService from "./BookingVoucherPdfService.js";
import storeDocumentPdf from "../utils/documentPdfStorage.js";
import { resolveTenantBranding, resolveTenantDocumentSettings } from "../utils/tenantBranding.js";

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

    const [customer, hotelLegs, flightLegs, carRentalLegs, company, documentSettings] = await Promise.all([
      CustomerModel.findOne({ _id: booking.customerId, tenantId }).lean(),
      HotelBookingModel.find({ bookingId, tenantId }).lean(),
      FlightBookingModel.find({ bookingId, tenantId }).lean(),
      CarRentalBookingModel.find({ bookingId, tenantId }).lean(),
      resolveTenantBranding(tenantId),
      resolveTenantDocumentSettings(tenantId)
    ]);
    if (!customer) throw new Error("Customer not found.");

    const generated = await NumberGeneratorService.generateNumber(tenantId, { resourceType: "Voucher" }, userId || null);
    const voucherNumber = generated.documentNumber;
    const generatedAt = new Date();

    const customerSnapshot = {
      name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.companyName || "Customer",
      email: customer.email || null,
      phone: customer.phone || null
    };
    const bookingSnapshot = {
      bookingNumber: booking.bookingNumber || booking.bookingReference,
      bookingType: booking.bookingType,
      travelDate: booking.travelDate,
      returnDate: booking.returnDate
    };
    const typeDetails = {
      ...(hotelLegs.length > 0 ? { hotels: hotelLegs } : {}),
      ...(flightLegs.length > 0 ? { flights: flightLegs } : {}),
      ...(carRentalLegs.length > 0 ? { carRentals: carRentalLegs } : {})
    };

    const buffer = await BookingVoucherPdfService.generatePdfBuffer({
      voucherNumber, generatedAt, generatedBy: userId || null,
      company, customer: customerSnapshot, booking: bookingSnapshot, typeDetails, documentSettings
    });
    const stored = await storeDocumentPdf({ tenantId, folder: "booking-vouchers", filename: `${voucherNumber}.pdf`, buffer });

    const voucher = await BookingVoucherModel.create({
      tenantId,
      bookingId: booking._id,
      voucherNumber,
      pdfUrl: stored.url,
      // Frozen at generation time — see BookingVoucherModel.js's own doc
      // comment on the snapshot-vs-live decision this field encodes.
      snapshotData: { company, customer: customerSnapshot, booking: bookingSnapshot, typeDetails, documentSettings },
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
