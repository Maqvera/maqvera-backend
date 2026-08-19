import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import InvoicePdfService from "../services/InvoicePdfService.js";
import { closeBrowser } from "../services/HtmlPdfRenderer.js";

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

// PRD "HTML-Template PDF Architecture Migration" Issue 5 — brought the
// Invoice template up to the same terms/cancellation/operational-contacts
// structure BookingVoucherPdfService already had, per the person's
// explicit confirmation these belong on the Invoice too.
test("InvoicePdfService renders Terms/Cancellation/Operational Contacts when documentSettings is present", async () => {
  const withSettings = await InvoicePdfService.generatePdfBuffer({
    ...baseInvoice,
    documentSettings: {
      termsAndConditions: "All bookings are subject to our standard terms.",
      cancellationPolicy: "Cancellations within 48 hours are non-refundable.",
      operationalContacts: "24/7 support: +966 12 345 6789"
    }
  });
  const withoutSettings = await InvoicePdfService.generatePdfBuffer({ ...baseInvoice });

  assert.ok(Buffer.isBuffer(withSettings) && withSettings.length > 0);
  assert.ok(withSettings.length > withoutSettings.length, "rendering the terms/cancellation/contacts blocks must produce a larger PDF");
});

// PRD "HTML-Template PDF Architecture Migration" Issue 3 — the logo is now
// a plain <img src="{{company.logoUrl}}"> in the template, fetched by
// headless Chromium's own network stack, not by Node's fetch — so a Node-
// level fetch mock (the pdfkit-era test's approach) no longer intercepts
// anything real. These tests instead spin up a genuine local HTTP server
// serving a real PNG, so Chromium actually fetches and embeds it —  a true
// end-to-end check, matching this codebase's "real implementation only,
// never mock an integration" discipline.
const ONE_PX_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const withLogoServer = async (fn) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(ONE_PX_PNG);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/logo.png`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test("InvoicePdfService draws the tenant logo image when company.logoUrl resolves to a real image", async () => {
  await withLogoServer(async (logoUrl) => {
    const withLogo = await InvoicePdfService.generatePdfBuffer({ ...baseInvoice, company: { name: "Maqvera Travel", logoUrl } });
    const withoutLogo = await InvoicePdfService.generatePdfBuffer({ ...baseInvoice, company: { name: "Maqvera Travel" } });

    assert.ok(Buffer.isBuffer(withLogo) && withLogo.length > 0);
    assert.ok(withLogo.length > withoutLogo.length, "embedding a real image must produce a larger PDF than one without it");
  });
});

test("InvoicePdfService still generates a valid PDF (never throws) when the logo URL is broken/unreachable", async () => {
  const buffer = await InvoicePdfService.generatePdfBuffer({ ...baseInvoice, company: { name: "Maqvera Travel", logoUrl: "http://127.0.0.1:1/unreachable-logo.png" } });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
});

after(async () => {
  await closeBrowser();
});
