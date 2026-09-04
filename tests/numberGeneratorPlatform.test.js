import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Identity & Global Resource ID Platform (Improvement 5) —
// proves the real Number Generator end to end against a real database:
// scheme resolution (company-specific overrides the tenant default),
// atomic sequencing, Global Resource ID composition using Improvement 4's
// own Legal Entity/Company codes, the Reserved -> Registered lifecycle,
// gap-aware rollback (only when a scheme explicitly opts in), and
// duplicate-scheme/unconfigured-resourceType rejection.
let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}
const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

test("NumberGeneratorService: scheme resolution, Global Resource ID, register/rollback lifecycle", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const NumberingSchemeModel = (await import("../models/NumberingSchemeModel.js")).default;
  const ResourceSequenceModel = (await import("../models/ResourceSequenceModel.js")).default;
  const GeneratedNumberModel = (await import("../models/GeneratedNumberModel.js")).default;
  const OrganisationModel = (await import("../models/OrganisationModel.js")).default;
  const LegalEntityModel = (await import("../models/LegalEntityModel.js")).default;
  const CompanyModel = (await import("../models/CompanyModel.js")).default;
  const OrganisationService = (await import("../services/OrganisationService.js")).default;
  const NumberGeneratorService = (await import("../services/NumberGeneratorService.js")).default;

  const suffix = `num-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await NumberingSchemeModel.deleteMany({ tenantId });
    await ResourceSequenceModel.deleteMany({ tenantId });
    await GeneratedNumberModel.deleteMany({ tenantId });
    await OrganisationModel.deleteMany({ tenantId });
    await LegalEntityModel.deleteMany({ tenantId });
    await CompanyModel.deleteMany({ tenantId });
  });

  // Real Organisation hierarchy backing the Global Resource ID's legal-entity segment.
  const organisation = await OrganisationService.createOrganisation(tenantId, { name: "Test Org" }, "tester");
  const legalEntity = await OrganisationService.createLegalEntity(tenantId, { organisationId: organisation._id, name: "Test LLC", registrationNumber: "REG-1", taxNumber: "TAX-1" }, "tester");
  const company = await OrganisationService.createCompany(tenantId, { legalEntityId: legalEntity._id, name: "Test Co" }, "tester");

  // No scheme configured yet -> honest rejection, never a fabricated fallback format.
  await assert.rejects(
    () => NumberGeneratorService.generateNumber(tenantId, { resourceType: "Invoice" }, "tester"),
    /No numbering scheme configured/
  );

  const defaultScheme = await NumberGeneratorService.createScheme(tenantId, { resourceType: "Invoice", prefix: "INV", includeYear: true, sequenceLength: 6, isDefault: true }, "tester");
  assert.equal(defaultScheme.isDefault, true);

  // Duplicate (tenantId, resourceType, companyId, branchId) rejected.
  await assert.rejects(
    () => NumberGeneratorService.createScheme(tenantId, { resourceType: "Invoice", prefix: "INV2" }, "tester"),
    /already exists/
  );

  const year = new Date().getUTCFullYear();

  const tenantSegment = tenantId.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);

  const first = await NumberGeneratorService.generateNumber(tenantId, { resourceType: "Invoice" }, "tester");
  assert.equal(first.documentNumber, `INV-${year}-000001`);
  assert.equal(first.globalResourceId, `${tenantSegment}-INV-${year}-000001`, "no companyId/legalEntityId given -> globalResourceId is just tenantSegment + documentNumber, no legal entity segment");

  const second = await NumberGeneratorService.generateNumber(tenantId, { resourceType: "Invoice" }, "tester");
  assert.equal(second.documentNumber, `INV-${year}-000002`, "sequence increments atomically per call");

  // Company-specific scheme overrides the tenant default for that company.
  const companyScheme = await NumberGeneratorService.createScheme(tenantId, { resourceType: "Invoice", companyId: company._id, prefix: "SALES", includeYear: false, sequenceLength: 4 }, "tester");
  const companyNumbered = await NumberGeneratorService.generateNumber(tenantId, { resourceType: "Invoice", companyId: company._id }, "tester");
  assert.equal(companyNumbered.documentNumber, "SALES-0001", "company-specific scheme resolved instead of the tenant default");
  assert.ok(companyNumbered.globalResourceId.includes(legalEntity.legalEntityCode), "legalEntityId auto-resolved from companyId");
  assert.equal(companyNumbered.legalEntityId.toString(), legalEntity._id.toString());

  // A second company-scoped generate must still increment independently of the tenant-default counter.
  const companyNumbered2 = await NumberGeneratorService.generateNumber(tenantId, { resourceType: "Invoice", companyId: company._id }, "tester");
  assert.equal(companyNumbered2.documentNumber, "SALES-0002");

  // Register / idempotent re-register / conflict.
  const fakeUuid = new mongoose.Types.ObjectId().toString();
  const registered = await NumberGeneratorService.registerResource(tenantId, first._id, fakeUuid, "tester");
  assert.equal(registered.status, "Registered");
  const reRegistered = await NumberGeneratorService.registerResource(tenantId, first._id, fakeUuid, "tester");
  assert.equal(reRegistered.status, "Registered", "re-registering the same uuid is idempotent");
  await assert.rejects(
    () => NumberGeneratorService.registerResource(tenantId, first._id, new mongoose.Types.ObjectId().toString(), "tester"),
    /already registered to a different resource/
  );

  // Gap-aware rollback only when the scheme explicitly opts in.
  await assert.rejects(
    () => NumberGeneratorService.rollbackSequence(tenantId, second._id, "test", "tester"),
    /allows gaps/,
    "default scheme (allowGaps: true) must reject rollback — the number is just left as a gap"
  );

  const gaplessScheme = await NumberGeneratorService.createScheme(tenantId, { resourceType: "Expense", prefix: "EXP", includeYear: false, sequenceLength: 3, allowGaps: false, isDefault: true }, "tester");
  const reserved = await NumberGeneratorService.generateNumber(tenantId, { resourceType: "Expense" }, "tester");
  assert.equal(reserved.documentNumber, "EXP-001");
  assert.equal(reserved.status, "Reserved");

  const rolledBack = await NumberGeneratorService.rollbackSequence(tenantId, reserved._id, "Duplicate entry, voided before use.", "tester");
  assert.equal(rolledBack.status, "RolledBack");

  const reusedAfterRollback = await NumberGeneratorService.generateNumber(tenantId, { resourceType: "Expense" }, "tester");
  assert.equal(reusedAfterRollback.documentNumber, "EXP-001", "an unclaimed rolled-back sequence value is reclaimed by the next generate() call");

  // Explicit admin reset.
  const resetResult = await NumberGeneratorService.resetSequence(tenantId, gaplessScheme._id, "ALL", 100, "tester");
  assert.equal(resetResult.seq, 100);
  const afterReset = await NumberGeneratorService.generateNumber(tenantId, { resourceType: "Expense" }, "tester");
  assert.equal(afterReset.documentNumber, "EXP-101");

  const history = await NumberGeneratorService.listHistory(tenantId, { resourceType: "Invoice" });
  assert.ok(history.items.length >= 4);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
