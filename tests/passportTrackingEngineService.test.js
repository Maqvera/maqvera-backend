import test from "node:test";
import assert from "node:assert/strict";
import PassportTrackingEngineService from "../services/PassportTrackingEngineService.js";
import { PASSPORT_STATUSES, PASSPORT_DOMAIN_EVENTS } from "../utils/visaConstants.js";

// Mock VisaCaseModel.findOne helper
const createMockPassport = () => ({
  _id: "507f1f77bcf86cd799439011",
  tenantId: "tenant_abc",
  branchId: "branch_khi",
  visaCaseId: "507f1f77bcf86cd799439099",
  passportNumber: "A12345678",
  nationality: "Pakistani",
  currentStatus: PASSPORT_STATUSES.RECEIVED,
  currentHolder: "Front Desk",
  currentLocation: "Branch Office Vault",
  trackingEvents: [],
  save: async function() { return this; }
});

test("PassportTrackingEngineService updates custody on transfer", async () => {
  const passport = createMockPassport();
  PassportTrackingEngineService.getPassportById = async () => passport;

  const result = await PassportTrackingEngineService.transferCustody(
    { passportId: passport._id, fromHolder: "Front Desk", toHolder: "Operations Supervisor", handoverTime: new Date() },
    "tenant_abc",
    "user_123"
  );

  assert.equal(result.currentHolder, "Operations Supervisor");
  assert.equal(result.trackingEvents.length, 1);
  assert.equal(result.trackingEvents[0].eventType, PASSPORT_DOMAIN_EVENTS.PASSPORT_TRANSFERRED);
});

test("PassportTrackingEngineService handles embassy dispatch with tracking number generation", async () => {
  const passport = createMockPassport();
  PassportTrackingEngineService.getPassportById = async () => passport;

  const result = await PassportTrackingEngineService.dispatchToEmbassy(
    { passportId: passport._id, courierCompany: "TCS Express", trackingNumber: "TCS-998877", expectedDelivery: new Date() },
    "tenant_abc",
    "user_123"
  );

  assert.equal(result.currentStatus, PASSPORT_STATUSES.DISPATCHED);
  assert.equal(result.courierCompany, "TCS Express");
  assert.ok(result.dispatchInfo.dispatchNumber.startsWith("DISP-"));
});

test("PassportTrackingEngineService requires identity verification on traveler collection", async () => {
  const passport = createMockPassport();
  PassportTrackingEngineService.getPassportById = async () => passport;

  await assert.rejects(
    async () => {
      await PassportTrackingEngineService.collectPassport(
        { passportId: passport._id, collectedBy: "Traveler", identityVerified: false },
        "tenant_abc",
        "user_123"
      );
    },
    { message: "Identity verification is mandatory for passport handover." }
  );

  const collected = await PassportTrackingEngineService.collectPassport(
    { passportId: passport._id, collectedBy: "Muhammad Ali", identityVerified: true, remarks: "ID checked" },
    "tenant_abc",
    "user_123"
  );

  assert.equal(collected.currentStatus, PASSPORT_STATUSES.COLLECTED);
  assert.ok(collected.collectionInfo.receiptNumber.startsWith("RCP-"));
});
