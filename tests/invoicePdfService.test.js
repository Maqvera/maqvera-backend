import { test } from "node:test";
import assert from "node:assert/strict";
import InvoicePdfService from "../services/InvoicePdfService.js";

const baseInvoice = {
  invoiceNumber: "INV-2026-000123",
  invoiceType: "Commercial",
  status: "Issued",
  issueDate: new Date("2026-09-01"),
  dueDate: new Date("2026-09-08"),
  customerName: "Jane Doe",
  currency: "USD",
  items: [{ description: "Umrah Package", quantity: 1, unitPrice: 1000, lineTotal: 1000, lineDiscountAmount: 0, lineTaxAmount: 0 }],
  subtotal: 1000,
  taxTotal: 0,
  discountTotal: 0,
  grandTotal: 1000
};

test("InvoicePdfService renders without company/bookingDetails (no profile set up yet)", async () => {
  const buffer = await InvoicePdfService.generatePdfBuffer({ ...baseInvoice });
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 0);
});

test("InvoicePdfService renders company branding and full bank details block", async () => {
  const buffer = await InvoicePdfService.generatePdfBuffer({
    ...baseInvoice,
    company: {
      name: "Maqvera Travel", vatNumber: "VAT123", registrationNumber: "REG456", address: "Makkah, KSA",
      bankDetails: { bankName: "Al Rajhi Bank", accountName: "Maqvera Travel LLC", accountNumberLast4: "1234", iban: "SA1234567890", swiftCode: "RJHISARI" }
    }
  });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
});

test("InvoicePdfService renders hotel/room detail block when bookingDetails is present", async () => {
  const buffer = await InvoicePdfService.generatePdfBuffer({
    ...baseInvoice,
    bookingDetails: {
      guestName: "Jane Doe",
      paxCount: 2,
      hotels: [{
        hotelName: "Swissotel Al Maqam", hotelConfirmationNumber: "CNF-001", roomType: "Deluxe Twin", view: "haram_view",
        checkIn: new Date("2026-09-01"), checkOut: new Date("2026-09-05"), nights: 4,
        adultCount: 2, childCount: 0, infantCount: 0, mealPlan: "half_board"
      }]
    }
  });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
});
