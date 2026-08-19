import test from "node:test";
import assert from "node:assert/strict";
import BookingVoiceParserService from "../services/BookingVoiceParserService.js";
import OpenAIAdapter from "../services/ai/OpenAIAdapter.js";
import AIModelRouterService from "../services/ai/AIModelRouterService.js";

// Voice-Based Booking Creation PRD B3.5 — mirrors
// tests/bookingDocumentParserService.test.js's mocking approach exactly
// (t.mock.method on the real classes, never a hand-rolled fake), extended
// to also mock transcribeAudio (mocked on the shared prototype, since
// BookingVoiceParserService holds one module-level OpenAIAdapter instance).

test("parseVoiceBooking (hotel) returns Completed with AI-extracted, correctly-typed fields", async (t) => {
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => ({ text: "guest John Doe, hotel Grand Palace, check in April 10th", detectedLanguage: "en" }));
  t.mock.method(AIModelRouterService, "route", async ({ tools }) => {
    assert.equal(tools[0].name, "extract_hotel_booking_fields", "must call with the hotel extraction tool for bookingType=hotel");
    return {
      toolCalls: [{
        name: "extract_hotel_booking_fields",
        arguments: {
          guestName: "John Doe", hotelName: "Grand Palace Hotel", roomType: "Deluxe Twin",
          checkIn: "2027-04-10", checkOut: "2027-04-13", pax: 2, ratePerNight: 150, total: 450,
          hotelConfirmationNumber: "HTL-998877"
        }
      }]
    };
  });

  const result = await BookingVoiceParserService.parseVoiceBooking(Buffer.from("dummy-audio"), "audio/webm", "test-tenant", "hotel");

  assert.equal(result.status, "Completed");
  assert.equal(result.transcript, "guest John Doe, hotel Grand Palace, check in April 10th");
  assert.equal(result.fields.guestName, "John Doe");
  assert.equal(result.fields.checkIn.toISOString().slice(0, 10), "2027-04-10");
  assert.equal(result.fields.pax, 2);
  assert.deepEqual(result.warnings, []);
});

test("parseVoiceBooking (car_rental) routes to the car rental tool and maps fields", async (t) => {
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => ({ text: "rent a car from Hertz, pickup tomorrow", detectedLanguage: "en" }));
  t.mock.method(AIModelRouterService, "route", async ({ tools }) => {
    assert.equal(tools[0].name, "extract_car_rental_booking_fields");
    return {
      toolCalls: [{
        name: "extract_car_rental_booking_fields",
        arguments: {
          rentalCompany: "Hertz", vehicleType: "SUV", pickupLocation: "Airport", dropoffLocation: "Airport",
          pickupDateTime: "2027-04-10T10:00:00Z", dropoffDateTime: "2027-04-12T10:00:00Z",
          confirmationNumber: "CR-123", ratePerDay: 80, totalPrice: 160
        }
      }]
    };
  });

  const result = await BookingVoiceParserService.parseVoiceBooking(Buffer.from("dummy-audio"), "audio/webm", "test-tenant", "car_rental");

  assert.equal(result.status, "Completed");
  assert.equal(result.fields.rentalCompany, "Hertz");
  assert.equal(result.fields.totalPrice, 160);
  assert.deepEqual(result.warnings, []);
});

test("parseVoiceBooking (flight_search) never returns offerId/pnr-shaped fields — search-prefill only", async (t) => {
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => ({ text: "flight from Karachi to Jeddah next Monday, 2 passengers", detectedLanguage: "en" }));
  t.mock.method(AIModelRouterService, "route", async ({ tools }) => {
    assert.equal(tools[0].name, "extract_flight_search_prefill");
    return {
      toolCalls: [{
        name: "extract_flight_search_prefill",
        arguments: { origin: "Karachi", destination: "Jeddah", departureDate: "2027-04-12", returnDate: null, passengerCount: 2, passengerNames: null, cabinClass: "Economy" }
      }]
    };
  });

  const result = await BookingVoiceParserService.parseVoiceBooking(Buffer.from("dummy-audio"), "audio/webm", "test-tenant", "flight_search");

  assert.equal(result.status, "Completed");
  assert.equal(result.fields.origin, "Karachi");
  assert.equal(result.fields.passengerCount, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(result.fields, "offerId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.fields, "pnr"), false);
});

test("parseVoiceBooking (generic_service) routes to the generic tool and maps fields", async (t) => {
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => ({ text: "add a visa service from ABC Visa Agency", detectedLanguage: "en" }));
  t.mock.method(AIModelRouterService, "route", async ({ tools }) => {
    assert.equal(tools[0].name, "extract_generic_service_fields");
    return {
      toolCalls: [{
        name: "extract_generic_service_fields",
        arguments: { serviceType: "visa", serviceName: "Visa Processing", supplierName: "ABC Visa Agency", costPrice: 50, sellingPrice: 80, quantity: 1, startDate: null, endDate: null, remarks: null }
      }]
    };
  });

  const result = await BookingVoiceParserService.parseVoiceBooking(Buffer.from("dummy-audio"), "audio/webm", "test-tenant", "generic_service");

  assert.equal(result.status, "Completed");
  assert.equal(result.fields.serviceType, "visa");
  assert.equal(result.fields.supplierName, "ABC Visa Agency");
});

test("parseVoiceBooking returns Skipped (never Failed/thrown) on silent/empty audio", async (t) => {
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => ({ text: "", detectedLanguage: null }));

  const result = await BookingVoiceParserService.parseVoiceBooking(Buffer.from("dummy-audio"), "audio/webm", "test-tenant", "hotel");

  assert.equal(result.status, "Skipped");
  assert.equal(result.fields, null);
});

test("parseVoiceBooking returns status Failed (never throws) when no AI provider is configured/reachable", async (t) => {
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => ({ text: "some transcript", detectedLanguage: "en" }));
  t.mock.method(AIModelRouterService, "route", async () => {
    const error = new Error("AI service is not available: no configured provider could be reached.");
    error.code = "AI_UNAVAILABLE";
    throw error;
  });

  const result = await BookingVoiceParserService.parseVoiceBooking(Buffer.from("dummy-audio"), "audio/webm", "test-tenant", "hotel");

  assert.equal(result.status, "Failed");
  assert.match(result.error, /AI service is not available/);
});

test("parseVoiceBooking returns status Failed (never throws) when transcription itself fails", async (t) => {
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => { throw new Error("OpenAI transcription failed: network error"); });

  const result = await BookingVoiceParserService.parseVoiceBooking(Buffer.from("dummy-audio"), "audio/webm", "test-tenant", "hotel");

  assert.equal(result.status, "Failed");
  assert.match(result.error, /transcription failed/);
});

test("parseVoiceBooking returns status Failed (never throws) for an unsupported bookingType", async (t) => {
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => ({ text: "some transcript", detectedLanguage: "en" }));

  const result = await BookingVoiceParserService.parseVoiceBooking(Buffer.from("dummy-audio"), "audio/webm", "test-tenant", "bogus_type");

  assert.equal(result.status, "Failed");
  assert.match(result.error, /Unsupported bookingType/);
});
