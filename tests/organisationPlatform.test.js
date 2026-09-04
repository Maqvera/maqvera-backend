import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Organisation Structure Platform (Improvement 4) — proves the
// real hierarchy end to end against a real database:
//   Tenant -> Organisation -> Legal Entity -> Business Unit -> Company
//   -> Branch -> Department -> Team
// including the "Validate Entire Organisation Hierarchy" rule (a child
// created against a parent from a DIFFERENT tenant, or against a
// mismatched grandparent, must be rejected), the two named lifecycle
// events (LegalEntityActivated, BranchClosed), and that Branch stays
// purely descriptive (getAccessScope() never gains a branch dimension).
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

test("OrganisationService: full hierarchy create, parent-chain validation, LegalEntityActivated, BranchClosed", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const OrganisationModel = (await import("../models/OrganisationModel.js")).default;
  const LegalEntityModel = (await import("../models/LegalEntityModel.js")).default;
  const BusinessUnitModel = (await import("../models/BusinessUnitModel.js")).default;
  const CompanyModel = (await import("../models/CompanyModel.js")).default;
  const BranchModel = (await import("../models/BranchModel.js")).default;
  const DepartmentModel = (await import("../models/Departmentmodel.js")).default;
  const TeamModel = (await import("../models/TeamModel.js")).default;
  const OrganisationService = (await import("../services/OrganisationService.js")).default;

  const suffix = `org-${Date.now()}`;
  const tenantA = `test-${suffix}-a`;
  const tenantB = `test-${suffix}-b`;

  t.after(async () => {
    await OrganisationModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
    await LegalEntityModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
    await BusinessUnitModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
    await CompanyModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
    await BranchModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
    await DepartmentModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
    await TeamModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  });

  // "ABC Group" owns "ABC Builders LLC" (Legal Entity), which runs a
  // Construction Business Unit, which owns "ABC Builders Karachi"
  // (Company), which has a Karachi Head Office (Branch), a Finance
  // department, and an Accounts team.
  const organisation = await OrganisationService.createOrganisation(tenantA, { name: "ABC Group" }, "tester");
  assert.equal(organisation.status, "Active");

  const legalEntity = await OrganisationService.createLegalEntity(tenantA, { organisationId: organisation._id, name: "ABC Builders LLC" }, "tester");
  assert.equal(legalEntity.status, "Pending", "no registrationNumber/taxNumber supplied yet -> Pending");

  await assert.rejects(
    () => OrganisationService.createLegalEntity(tenantA, { organisationId: organisation._id }, "tester"),
    /name is required/
  );

  const activated = await OrganisationService.activateLegalEntity(tenantA, legalEntity._id, "tester").catch((e) => e);
  assert.ok(activated instanceof Error, "activation must be rejected without a registrationNumber/taxNumber on file");

  const legalEntityWithTax = await OrganisationService.createLegalEntity(tenantA, { organisationId: organisation._id, name: "ABC Cement Pvt Ltd", registrationNumber: "REG-1", taxNumber: "TAX-1" }, "tester");
  assert.equal(legalEntityWithTax.status, "Active", "real registrationNumber + taxNumber supplied at creation -> Active immediately, LegalEntityActivated fires");

  const businessUnit = await OrganisationService.createBusinessUnit(tenantA, { legalEntityId: legalEntityWithTax._id, name: "Construction" }, "tester");
  assert.equal(businessUnit.organisationId.toString(), organisation._id.toString(), "organisationId denormalized from the legal entity's own parent");

  const company = await OrganisationService.createCompany(tenantA, { legalEntityId: legalEntityWithTax._id, businessUnitId: businessUnit._id, name: "ABC Builders Karachi" }, "tester");
  assert.equal(company.legalEntityId.toString(), legalEntityWithTax._id.toString());

  const branch = await OrganisationService.createBranch(tenantA, { companyId: company._id, name: "Karachi Head Office" }, "tester");
  assert.equal(branch.status, "Active");

  const department = await OrganisationService.createDepartment(tenantA, { companyId: company._id, branchId: branch._id, name: "Finance" }, "tester");
  assert.equal(department.branchId.toString(), branch._id.toString());

  const team = await OrganisationService.createTeam(tenantA, { departmentId: department._id, name: "Accounts" }, "tester");
  assert.equal(team.status, "Active");

  // Cross-tenant parent rejection — the real "Validate Entire Organisation
  // Hierarchy" rule: a legal entity from tenant A can never be used to
  // create a business unit under tenant B's own request.
  await assert.rejects(
    () => OrganisationService.createBusinessUnit(tenantB, { legalEntityId: legalEntityWithTax._id, name: "Cross-tenant BU" }, "tester"),
    /Legal entity not found/
  );

  // Mismatched-chain rejection — a businessUnitId that is real but belongs
  // to a DIFFERENT legal entity than the one supplied must be rejected.
  const otherLegalEntity = await OrganisationService.createLegalEntity(tenantA, { organisationId: organisation._id, name: "ABC Steel LLC", registrationNumber: "REG-2", taxNumber: "TAX-2" }, "tester");
  await assert.rejects(
    () => OrganisationService.createCompany(tenantA, { legalEntityId: otherLegalEntity._id, businessUnitId: businessUnit._id, name: "Mismatched Company" }, "tester"),
    /does not belong to the given legalEntityId/
  );

  // Real BranchClosed lifecycle transition.
  const closed = await OrganisationService.closeBranch(tenantA, branch._id, "Office relocated.", "tester");
  assert.equal(closed.status, "Closed");
  assert.ok(closed.closedAt);

  // A closed Branch can no longer accept new departments — the real
  // "closed parent rejects new children" rule.
  await assert.rejects(
    () => OrganisationService.createDepartment(tenantA, { companyId: company._id, branchId: branch._id, name: "Dead Department" }, "tester"),
    /closed and cannot accept/
  );
});

test("getAccessScope stays tenant-only — Branch is never part of the access-isolation boundary", async () => {
  const { getAccessScope } = await import("../utils/accessScope.js");
  const scope = getAccessScope({ auth: { tenantId: "some-tenant", branchId: "some-branch" } });
  assert.deepEqual(scope, { tenantId: "some-tenant" }, "getAccessScope must ignore any branchId on req.auth and return tenantId only");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
