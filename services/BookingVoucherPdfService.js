import PDFDocument from "pdfkit";

/**
 * Agency-branded Client Voucher PDF (booking-module PRD Part B item #7).
 * Same `pdfkit` generate-buffer pattern as services/InvoicePdfService.js /
 * services/ReceiptPdfService.js. Layout follows Document 3 §45: company
 * header -> CLIENT VOUCHER title + ref/generated-by -> client/guest section
 * -> service section -> room/service detail lines -> terms -> cancellation
 * policy -> operational contacts.
 *
 * `company` (name/logoUrl/address/phone/email) and `documentSettings`
 * (termsAndConditions/cancellationPolicy/operationalContacts) are optional
 * and sourced from TenantProfileModel once that exists (PRD Part C item
 * #15 wires this in) — this service renders whatever it's given and never
 * fabricates placeholder branding text when they're absent, matching this
 * PRD's own "don't create fake/placeholder fields" rule from item #4.
 */
class BookingVoucherPdfService {
  static async generatePdfBuffer({ voucherNumber, generatedAt, generatedBy, company, customer, booking, typeDetails, documentSettings }) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      if (company?.name) doc.fontSize(14).text(company.name, { align: "center" });
      doc.fontSize(20).text("CLIENT VOUCHER", { align: "center" });
      doc.moveDown();

      doc.fontSize(10);
      doc.text(`Voucher Number: ${voucherNumber}`);
      doc.text(`Booking Reference: ${booking.bookingNumber}`);
      if (company?.vatNumber) doc.text(`VAT Number: ${company.vatNumber}`);
      doc.text(`Generated: ${new Date(generatedAt).toISOString().split("T")[0]}${generatedBy ? ` by ${generatedBy}` : ""}`);
      doc.moveDown();

      doc.fontSize(11).text("Client Details", { underline: true });
      doc.fontSize(10);
      doc.text(`Name: ${customer.name}`);
      if (customer.email) doc.text(`Email: ${customer.email}`);
      if (customer.phone) doc.text(`Phone: ${customer.phone}`);
      doc.moveDown();

      doc.fontSize(11).text("Service Details", { underline: true });
      doc.fontSize(10);
      doc.text(`Booking Type: ${booking.bookingType}`);
      if (booking.travelDate) doc.text(`Travel Date: ${new Date(booking.travelDate).toISOString().split("T")[0]}`);
      if (booking.returnDate) doc.text(`Return Date: ${new Date(booking.returnDate).toISOString().split("T")[0]}`);
      doc.moveDown();

      (typeDetails?.hotels || []).forEach((hotel, index) => {
        doc.fontSize(10).text(
          `Hotel ${index + 1}: ${hotel.hotelName} (${hotel.city || "N/A"}) — ${hotel.roomType}, ` +
          `${hotel.mealPlan}, Check-in ${new Date(hotel.checkIn).toISOString().split("T")[0]}, ` +
          `Check-out ${new Date(hotel.checkOut).toISOString().split("T")[0]}, ` +
          `${hotel.roomsCount} room(s), ${hotel.guestsCount} guest(s)`
        );
      });
      (typeDetails?.flights || []).forEach((flight, index) => {
        doc.fontSize(10).text(`Flight ${index + 1}: ${flight.reservationNumber || flight.providerConfirmationNumber || "N/A"}`);
      });
      (typeDetails?.carRentals || []).forEach((rental, index) => {
        doc.fontSize(10).text(
          `Car Rental ${index + 1}: ${rental.rentalCompany} — ${rental.vehicleType || "N/A"}, ` +
          `Pickup ${rental.pickupLocation} (${new Date(rental.pickupDateTime).toISOString().slice(0, 16).replace("T", " ")}), ` +
          `Dropoff ${rental.dropoffLocation} (${new Date(rental.dropoffDateTime).toISOString().slice(0, 16).replace("T", " ")})`
        );
      });
      if ((typeDetails?.hotels?.length || 0) + (typeDetails?.flights?.length || 0) + (typeDetails?.carRentals?.length || 0) > 0) doc.moveDown();

      if (documentSettings?.termsAndConditions) {
        doc.fontSize(11).text("Terms & Conditions", { underline: true });
        doc.fontSize(9).text(documentSettings.termsAndConditions);
        doc.moveDown();
      }
      if (documentSettings?.cancellationPolicy) {
        doc.fontSize(11).text("Cancellation Policy", { underline: true });
        doc.fontSize(9).text(documentSettings.cancellationPolicy);
        doc.moveDown();
      }
      if (documentSettings?.operationalContacts) {
        doc.fontSize(11).text("Operational Contacts", { underline: true });
        doc.fontSize(9).text(documentSettings.operationalContacts);
      }

      doc.end();
    });
  }
}

export default BookingVoucherPdfService;
