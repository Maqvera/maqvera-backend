import test from "node:test";
import assert from "node:assert/strict";
import {
  extractGuestNameFromText,
  extractHotelNameFromText,
  extractRoomTypeFromText,
  extractCheckInFromText,
  extractCheckOutFromText,
  extractPaxFromText,
  extractRatePerNightFromText,
  extractTotalFromText,
  extractHotelConfirmationNumberFromText,
  validateHotelExtraction
} from "../services/BookingDocumentParserService.js";

const SAMPLE_DOC = `Grand Palace Hotel
Hotel CNF#: HTL-998877
Guest Name: John Doe
Room Type: Deluxe Twin
Check-in: 2027-04-10
Check-out: 2027-04-13
Pax: 2
Rate per Night: 150.00
Grand Total: 450.00`;

test("extractGuestNameFromText recognizes a labeled Guest Name", () => {
  assert.equal(extractGuestNameFromText(SAMPLE_DOC), "John Doe");
});

test("extractHotelNameFromText prefers a labeled Hotel Name, else the first line", () => {
  assert.equal(extractHotelNameFromText("Hotel Name: Marriott Downtown\nOther text"), "Marriott Downtown");
  assert.equal(extractHotelNameFromText(SAMPLE_DOC), "Grand Palace Hotel");
});

test("extractRoomTypeFromText recognizes a labeled Room Type", () => {
  assert.equal(extractRoomTypeFromText(SAMPLE_DOC), "Deluxe Twin");
});

test("extractCheckInFromText / extractCheckOutFromText recognize labeled ISO dates", () => {
  assert.equal(extractCheckInFromText(SAMPLE_DOC).toISOString().slice(0, 10), "2027-04-10");
  assert.equal(extractCheckOutFromText(SAMPLE_DOC).toISOString().slice(0, 10), "2027-04-13");
});

test("extractCheckInFromText recognizes slash dates and the Arrival label", () => {
  const date = extractCheckInFromText("Arrival: 04/10/2027");
  assert.equal(date.toISOString().slice(0, 10), "2027-04-10");
});

test("extractPaxFromText recognizes a labeled Pax/Guests/Occupancy count", () => {
  assert.equal(extractPaxFromText(SAMPLE_DOC), 2);
  assert.equal(extractPaxFromText("Occupancy: 4"), 4);
});

test("extractRatePerNightFromText recognizes a labeled Rate per Night", () => {
  assert.equal(extractRatePerNightFromText(SAMPLE_DOC), 150);
  assert.equal(extractRatePerNightFromText("Nightly Rate: $99.50"), 99.5);
});

test("extractTotalFromText prefers Grand Total over Subtotal", () => {
  assert.equal(extractTotalFromText(SAMPLE_DOC), 450);
  assert.equal(extractTotalFromText("Subtotal: 100.00\nTotal: 115.00"), 115);
});

test("extractHotelConfirmationNumberFromText recognizes the 'Hotel CNF#' label", () => {
  assert.equal(extractHotelConfirmationNumberFromText(SAMPLE_DOC), "HTL-998877");
});

test("all extractors return null on missing/empty input, never a fabricated value", () => {
  assert.equal(extractGuestNameFromText(""), null);
  assert.equal(extractHotelNameFromText(""), null);
  assert.equal(extractRoomTypeFromText(null), null);
  assert.equal(extractCheckInFromText(null), null);
  assert.equal(extractPaxFromText("no numbers here"), null);
  assert.equal(extractRatePerNightFromText("nothing"), null);
  assert.equal(extractTotalFromText(""), null);
  assert.equal(extractHotelConfirmationNumberFromText(""), null);
});

test("validateHotelExtraction flags checkOut not after checkIn", () => {
  const warnings = validateHotelExtraction({
    checkIn: new Date("2027-04-13"), checkOut: new Date("2027-04-10"), ratePerNight: null, total: null
  });
  assert.ok(warnings.some((w) => w.includes("checkOut is not after checkIn")));
});

test("validateHotelExtraction flags a total that doesn't match nights x rate per night", () => {
  const warnings = validateHotelExtraction({
    checkIn: new Date("2027-04-10"), checkOut: new Date("2027-04-13"), ratePerNight: 150, total: 999
  });
  assert.ok(warnings.some((w) => w.includes("does not match nights")));
});

test("validateHotelExtraction returns no warnings for consistent fields", () => {
  const warnings = validateHotelExtraction({
    checkIn: new Date("2027-04-10"), checkOut: new Date("2027-04-13"), ratePerNight: 150, total: 450
  });
  assert.deepEqual(warnings, []);
});

test("validateHotelExtraction never blocks on missing fields (returns no warnings, not an error)", () => {
  const warnings = validateHotelExtraction({ checkIn: null, checkOut: null, ratePerNight: null, total: null });
  assert.deepEqual(warnings, []);
});
