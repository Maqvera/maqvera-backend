import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import FinancePlatformOrchestrationService from "../services/FinancePlatformOrchestrationService.js";
import FinancialGovernancePolicyModel from "../models/FinancialGovernancePolicyModel.js";
import SegregationOfDutiesRuleModel from "../models/SegregationOfDutiesRuleModel.js";
import GovernanceEvaluationModel from "../models/GovernanceEvaluationModel.js";
import GovernanceEvidenceModel from "../models/GovernanceEvidenceModel.js";
import TreasuryCashPositionModel from "../models/TreasuryCashPositionModel.js";
import FinancePlatformSummaryModel from "../models/FinancePlatformSummaryModel.js";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/maqvera_test";

test("Enterprise Finance Platform Master Architecture (Part 20)", async (t) => {
  let dbConnected = false;
  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
    }
    dbConnected = mongoose.connection.readyState === 1;
  } catch (_e) {
    dbConnected = false;
  }

  const tenantId = "tenant_fpo_master_test";
  const user1 = "usr_master_01";
  const user2 = "usr_master_02";

  await t.test("1. Master Architecture Blueprint Metadata", () => {
    const blueprint = FinancePlatformOrchestrationService.getPlatformArchitectureBlueprint({ tenantId });
    assert.equal(blueprint.domainName, "Enterprise Finance Domain");
    assert.equal(blueprint.architectureType, "Event-Driven Micro-Platform Ecosystem");
    assert.ok(Array.isArray(blueprint.subPlatforms));
    assert.equal(blueprint.subPlatforms.length, 6);

    const subPlatformNames = blueprint.subPlatforms.map(s => s.name);
    assert.ok(subPlatformNames.includes("Financial Accounting"));
    assert.ok(subPlatformNames.includes("Financial Operations"));
    assert.ok(subPlatformNames.includes("Financial Planning"));
    assert.ok(subPlatformNames.includes("Treasury Management"));
    assert.ok(subPlatformNames.includes("Financial Intelligence"));
    assert.ok(subPlatformNames.includes("Governance & Compliance"));

    assert.ok(blueprint.internalEngines.includes("Governance Engine"));
    assert.ok(blueprint.internalEngines.includes("Treasury Engine"));
    assert.ok(blueprint.internalEngines.includes("Accounting Engine"));
  });

  await t.test("1b. Architecture blueprint honestly splits real vs. not-implemented shared services, never claiming Feature Flags/Localization/ABAC/field encryption/TLS as real", () => {
    const blueprint = FinancePlatformOrchestrationService.getPlatformArchitectureBlueprint({ tenantId });
    assert.ok(Array.isArray(blueprint.sharedServices.real));
    assert.ok(Array.isArray(blueprint.sharedServices.notImplemented));
    assert.ok(blueprint.sharedServices.notImplemented.some((s) => /Feature Flags/.test(s)));
    assert.ok(blueprint.sharedServices.notImplemented.some((s) => /Localization/.test(s)));
    assert.ok(blueprint.sharedServices.notImplemented.some((s) => /ABAC/.test(s)));
    assert.doesNotMatch(blueprint.securityModel, /AES-256/);
  });

  await t.test("1c. processFinancialRequest requires tenantId, transactionId, and operation before touching the database", async () => {
    await assert.rejects(
      async () => {
        await FinancePlatformOrchestrationService.processFinancialRequest({});
      },
      { message: "Missing required request fields (tenantId, transactionId, operation)." }
    );

    await assert.rejects(
      async () => {
        await FinancePlatformOrchestrationService.processFinancialRequest({ tenantId: "tenant-123" });
      },
      { message: "Missing required request fields (tenantId, transactionId, operation)." }
    );
  });

  if (!dbConnected) {
    console.log("MongoDB not running locally — skipping live DB orchestration tests.");
    return;
  }

  // Cleanup before tests
  await FinancialGovernancePolicyModel.deleteMany({ tenantId });
  await SegregationOfDutiesRuleModel.deleteMany({ tenantId });
  await GovernanceEvaluationModel.deleteMany({ tenantId });
  await GovernanceEvidenceModel.deleteMany({ tenantId });
  await TreasuryCashPositionModel.deleteMany({ tenantId });
  await FinancePlatformSummaryModel.deleteMany({ tenantId });

  await t.test("2. Process Financial Request Pipeline (End-to-End)", async () => {
    const result = await FinancePlatformOrchestrationService.processFinancialRequest({
      tenantId,
      transactionId: "TXN-FPO-10001",
      operation: "VendorPayment",
      amount: 75000,
      creatorId: user1,
      approverId: user2,
      payload: {},
      userId: user1
    });

    assert.equal(result.status, "SUCCESS");
    assert.ok(result.executionId);
    assert.ok(result.governance);
    assert.equal(result.governance.decision, "Approved");
    assert.ok(result.treasury);
    assert.ok(result.evidenceHash);
  });

  await t.test("3. Platform Health Status Overview", async () => {
    const health = await FinancePlatformOrchestrationService.getPlatformHealthStatus({ tenantId });
    assert.equal(health.status, "Operational");
    assert.equal(health.checks.database, "up");
    assert.ok(Array.isArray(health.subPlatforms));
    assert.equal(health.subPlatforms.length, 6);
    assert.ok(health.metrics);
  });

  // Final Cleanup
  await FinancialGovernancePolicyModel.deleteMany({ tenantId });
  await SegregationOfDutiesRuleModel.deleteMany({ tenantId });
  await GovernanceEvaluationModel.deleteMany({ tenantId });
  await GovernanceEvidenceModel.deleteMany({ tenantId });
  await TreasuryCashPositionModel.deleteMany({ tenantId });
  await FinancePlatformSummaryModel.deleteMany({ tenantId });
  await mongoose.disconnect();
});
