import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import FinancialGovernanceService from "../services/FinancialGovernanceService.js";
import FinancialGovernancePolicyModel from "../models/FinancialGovernancePolicyModel.js";
import SegregationOfDutiesRuleModel from "../models/SegregationOfDutiesRuleModel.js";
import FinancialFraudRuleModel from "../models/FinancialFraudRuleModel.js";
import GovernanceEvaluationModel from "../models/GovernanceEvaluationModel.js";
import GovernanceEvidenceModel from "../models/GovernanceEvidenceModel.js";
import PaymentModel from "../models/PaymentModel.js";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/maqvera_test";

test("Financial Governance & Compliance Platform (Part 19)", async (t) => {
  let dbConnected = false;
  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
    }
    dbConnected = mongoose.connection.readyState === 1;
  } catch (_e) {
    dbConnected = false;
  }

  const tenantA = "tenant_gov_test_A";
  const tenantB = "tenant_gov_test_B";
  const user1 = "usr_creator_01";
  const user2 = "usr_approver_02";

  await t.test("1. Utility ID Generation & Hash Verification", () => {
    const id = FinancialGovernanceService.generateId("GOV");
    assert.match(id, /^GOV-[A-Z0-9]+-[A-Z0-9]+$/);
  });

  if (!dbConnected) {
    console.log("MongoDB not running locally — skipping live DB integration tests.");
    return;
  }

  // Cleanup before tests
  await FinancialGovernancePolicyModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  await SegregationOfDutiesRuleModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  await FinancialFraudRuleModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  await GovernanceEvaluationModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  await GovernanceEvidenceModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  await PaymentModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });

  await t.test("2. Create & List Governance Policies", async () => {
    const policy = await FinancialGovernanceService.createPolicy({
      tenantId: tenantA,
      name: "Enterprise Dual Authorization for Payments >= $100k",
      policyType: "InternalControl",
      priority: 1,
      owner: "Chief Compliance Officer",
      description: "Requires dual approval for vendor payments equal or over $100,000",
      rules: {
        thresholdAmount: 100000,
        requiresDualAuthorization: true
      },
      userId: user1
    });

    assert.ok(policy.policyId);
    assert.equal(policy.name, "Enterprise Dual Authorization for Payments >= $100k");
    assert.equal(policy.status, "Active");
    assert.equal(policy.rules.thresholdAmount, 100000);
    assert.equal(policy.rules.requiresDualAuthorization, true);

    const list = await FinancialGovernanceService.listPolicies({ tenantId: tenantA, status: "Active" });
    assert.ok(list.data.length >= 1);
    assert.equal(list.total, list.data.length);

    // Isolation check
    const listB = await FinancialGovernanceService.listPolicies({ tenantId: tenantB });
    assert.equal(listB.data.length, 0);
  });

  await t.test("3. Create & List SoD Rules", async () => {
    const rule = await FinancialGovernanceService.createSoDRule({
      tenantId: tenantA,
      ruleName: "Vendor Payment Creation vs Approval Separation",
      firstAction: "VendorPayment",
      secondAction: "Approve_VendorPayment",
      riskLevel: "Critical",
      description: "The employee creating a payment request cannot approve the same payment",
      mitigationControl: "System enforced dual authorization",
      userId: user1
    });

    assert.ok(rule.ruleId);
    assert.equal(rule.firstAction, "VendorPayment");
    assert.equal(rule.riskLevel, "Critical");

    const rules = await FinancialGovernanceService.listSoDRules({ tenantId: tenantA, status: "Active" });
    assert.ok(rules.length >= 1);
  });

  await t.test("4. Create & List Fraud Rules", async () => {
    const rule = await FinancialGovernanceService.createFraudRule({
      tenantId: tenantA,
      ruleName: "Duplicate Payment Detection 7-Day Window",
      checkType: "DuplicatePayment",
      riskSeverity: "High",
      parameters: { lookbackDays: 7 },
      userId: user1
    });

    assert.ok(rule.ruleId);
    assert.equal(rule.checkType, "DuplicatePayment");

    const rules = await FinancialGovernanceService.listFraudRules({ tenantId: tenantA });
    assert.ok(rules.length >= 1);
  });

  await t.test("5. Evaluate Governance Policy & Generate Evidence Package", async () => {
    // A) Approved Payment < $100k with different creator and approver
    const evalApproved = await FinancialGovernanceService.evaluateGovernance({
      tenantId: tenantA,
      transactionId: "TXN-10001",
      operation: "VendorPayment",
      amount: 45000,
      creatorId: user1,
      approverId: user2,
      userId: user1
    });

    assert.equal(evalApproved.decision, "Approved");
    assert.ok(evalApproved.riskScore < 50);
    assert.equal(evalApproved.sodViolations.length, 0);
    assert.equal(typeof evalApproved.evidenceHash, "string");
    assert.equal(evalApproved.evidenceHash.length, 64);

    // B) Dual Approval Required for Payment >= $100k without approver
    const evalDual = await FinancialGovernanceService.evaluateGovernance({
      tenantId: tenantA,
      transactionId: "TXN-10025",
      operation: "VendorPayment",
      amount: 250000,
      creatorId: user1,
      approverId: null,
      userId: user1
    });

    assert.equal(evalDual.decision, "DualApprovalRequired");
    assert.ok(evalDual.evidenceHash);

    // C) Rejected for SoD violation (creator == approver)
    const evalSod = await FinancialGovernanceService.evaluateGovernance({
      tenantId: tenantA,
      transactionId: "TXN-SOD-VIOLATION",
      operation: "VendorPayment",
      amount: 50000,
      creatorId: user1,
      approverId: user1,
      userId: user1
    });

    assert.equal(evalSod.decision, "Rejected");
    assert.ok(evalSod.sodViolations.length >= 1);

    // D) Fraud Flag for Duplicate Payment
    await PaymentModel.create({
      tenantId: tenantA,
      paymentId: "PAY-DUP-01",
      amount: 88000,
      status: "Completed",
      paymentMethod: "BankTransfer",
      createdAt: new Date()
    });
    await PaymentModel.create({
      tenantId: tenantA,
      paymentId: "PAY-DUP-02",
      amount: 88000,
      status: "Completed",
      paymentMethod: "BankTransfer",
      createdAt: new Date()
    });

    const evalDup = await FinancialGovernanceService.evaluateGovernance({
      tenantId: tenantA,
      transactionId: "TXN-DUP-TEST",
      operation: "VendorPayment",
      amount: 88000,
      creatorId: user1,
      approverId: user2,
      userId: user1
    });

    assert.ok(evalDup.fraudFlags.length >= 1);
    assert.equal(evalDup.fraudFlags[0].checkName, "Duplicate Payment Detection");
  });

  await t.test("6. Evidence Repository & Governance Dashboard", async () => {
    const evidenceList = await FinancialGovernanceService.listEvidencePackages({ tenantId: tenantA });
    assert.ok(evidenceList.data.length >= 1);

    const singleEvidence = await FinancialGovernanceService.getEvidenceById({
      tenantId: tenantA,
      evidenceId: evidenceList.data[0].evidenceId
    });
    assert.ok(singleEvidence.evidenceHash);
    assert.ok(singleEvidence.snapshot);

    const dashboard = await FinancialGovernanceService.getGovernanceDashboard({ tenantId: tenantA });
    assert.ok(dashboard.totalActivePolicies >= 1);
    assert.ok(dashboard.totalActiveSoDRules >= 1);
    assert.ok(dashboard.totalEvaluations >= 1);
    assert.ok(dashboard.rejectedCount >= 1);
    assert.ok(dashboard.evidencePackagesCount >= 1);
  });

  // Final Cleanup
  await FinancialGovernancePolicyModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  await SegregationOfDutiesRuleModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  await FinancialFraudRuleModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  await GovernanceEvaluationModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  await GovernanceEvidenceModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  await PaymentModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
});
