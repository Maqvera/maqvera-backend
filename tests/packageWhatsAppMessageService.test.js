import test from "node:test";
import assert from "node:assert/strict";
import { buildWhatsAppMessage } from "../services/PackageWhatsAppMessageService.js";

test("buildWhatsAppMessage includes destination, dates, hotel, and a price line per room", () => {
  const message = buildWhatsAppMessage({
    packageName: "Dubai Family Holiday",
    destination: "Dubai",
    dateRange: "2027-01-01 - 2027-01-06",
    hotelNames: "Marriott Dubai",
    rooms: [
      { roomTypeName: "Double", finalPricePerPerson: 285000 },
      { roomTypeName: "Quad", finalPricePerPerson: 250000 }
    ],
    sellingCurrency: "PKR",
    includedComponents: ["Hotel", "Flight", "Transport"],
    contactPhone: "+92 300 1234567"
  });

  assert.match(message, /\*Dubai Family Holiday\*/);
  assert.match(message, /📍 Dubai/);
  assert.match(message, /📅 2027-01-01 - 2027-01-06/);
  assert.match(message, /🏨 Marriott Dubai/);
  assert.match(message, /✈️ Flights included/);
  assert.match(message, /🚐 Transport included/);
  assert.match(message, /Double: 285,000 PKR \/ person/);
  assert.match(message, /Quad: 250,000 PKR \/ person/);
  assert.match(message, /✓ Hotel/);
  assert.match(message, /✓ Flight/);
  assert.match(message, /✓ Transport/);
  assert.match(message, /📲 WhatsApp \+92 300 1234567 now to book\./);
});

test("buildWhatsAppMessage omits optional lines and falls back to a generic CTA when contactPhone is missing", () => {
  const message = buildWhatsAppMessage({ packageName: null, rooms: [{ roomTypeName: "Double", finalPricePerPerson: 100000 }], sellingCurrency: "PKR" });
  assert.match(message, /\*Travel Package\*/);
  assert.doesNotMatch(message, /📍/);
  assert.doesNotMatch(message, /✈️/);
  assert.doesNotMatch(message, /Includes/);
  assert.match(message, /📲 WhatsApp us now to book\./);
});
