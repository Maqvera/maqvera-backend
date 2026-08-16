import crypto from "crypto";
import FinancialGovernancePolicyModel from "../models/FinancialGovernancePolicyModel.js";
import SegregationOfDutiesRuleModel from "../models/SegregationOfDutiesRuleModel.js";
import GovernanceEvaluationModel from "../models/GovernanceEvaluationModel.js";
import GovernanceEvidenceModel from "../models/GovernanceEvidenceModel.js";
import FinancialFraudRuleModel from "../models/FinancialFraudRuleModel.js";
import PaymentModel from "../models/PaymentModel.js";
import AccountsPayableModel from "../models/AccountsPayableModel.js";
import { publishEvent } from "../utils/eventBus.js";

/**
 * Enterprise Financial Governance & Compliance Service — Part 19.
 * Centralized governance policies, Segregation of Duties (SoD), internal controls,
 * fraud detection, audit evidence packages, and governance executive dashboards.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
class FinancialGovernanceService {
  /**
   * Generates a unique sequential identifier for governance records
   */
  static generateId(prefix = "GOV") {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Endpoint: POST /api/v1/finance-governance/evaluate
   * Business Workflow: Validate Request -> Load Policies -> Evaluate SoD ->
   * Evaluate Compliance -> Evaluate Risk -> Generate Decision -> Publish GovernanceEvaluated -> Return Result
   */
  static async evaluateGovernance({
    tenantId,
    transactionId,
    operation = "VendorPayment",
    amount = 0,
    creatorId = null,
    approverId = null,
    payload = {},
    userId = null
  }) {
    if (!tenantId || !transactionId || !operation) {
      throw new Error("Missing required evaluation parameters (tenantId, transactionId, operation).");
    }

    // 1. Load Active Policies (sorted by priority ASC)
    const policies = await FinancialGovernancePolicyModel.find({
      tenantId,
      status: "Active"
    }).sort({ priority: 1 }).lean();

    const evaluatedPolicies = [];
    let requiresDualAuthorization = false;
    let thresholdExceeded = false;

    for (const pol of policies) {
      const rules = pol.rules || {};
      let passed = true;
      let reason = "Policy requirements satisfied.";

      // Check threshold amount controls
      if (rules.thresholdAmount !== null && rules.thresholdAmount !== undefined) {
        if (amount >= rules.thresholdAmount) {
          thresholdExceeded = true;
          if (rules.requiresDualAuthorization) {
            requiresDualAuthorization = true;
            reason = `Transaction amount ($${amount}) exceeds threshold ($${rules.thresholdAmount}). Dual authorization required.`;
          }
        }
      }

      evaluatedPolicies.push({
        policyId: pol.policyId,
        name: pol.name,
        passed,
        reason
      });
    }

    // 2. Evaluate Segregation of Duties (SoD)
    const sodRules = await SegregationOfDutiesRuleModel.find({
      tenantId,
      status: "Active"
    }).lean();

    const sodViolations = [];
    if (creatorId && approverId && creatorId === approverId) {
      // Automatic SoD violation if same user creates and approves
      sodViolations.push({
        ruleId: "SOD-AUTO-01",
        ruleName: "Self-Approval Incompatibility",
        firstAction: `Create_${operation}`,
        secondAction: `Approve_${operation}`,
        user1: creatorId,
        user2: approverId
      });
    }

    for (const sod of sodRules) {
      if (sod.firstAction === operation || sod.secondAction === operation) {
        if (creatorId && approverId && creatorId === approverId) {
          sodViolations.push({
            ruleId: sod.ruleId,
            ruleName: sod.ruleName,
            firstAction: sod.firstAction,
            secondAction: sod.secondAction,
            user1: creatorId,
            user2: approverId
          });
        }
      }
    }

    // 3. Evaluate Fraud Detection Rules
    const fraudRules = await FinancialFraudRuleModel.find({
      tenantId,
      status: "Active"
    }).lean();

    const fraudFlags = [];
    let riskScore = 0;

    // Check duplicate payment
    if (amount > 0 && operation === "VendorPayment") {
      const recentDuplicates = await PaymentModel.countDocuments({
        tenantId,
        amount,
        createdAt: { $gte: new Date(Date.now() - 7 * 86400000) }
      });
      if (recentDuplicates > 1) {
        fraudFlags.push({
          checkName: "Duplicate Payment Detection",
          severity: "High",
          details: `Identified ${recentDuplicates} payment(s) of identical amount ($${amount}) within 7 days.`
        });
        riskScore += 40;
      }
    }

    // High risk transaction amount
    if (amount >= 250000) {
      fraudFlags.push({
        checkName: "High Value Transaction Threshold",
        severity: "Medium",
        details: `Transaction amount ($${amount}) is classified as enterprise high value.`
      });
      riskScore += 25;
    }

    if (sodViolations.length > 0) {
      riskScore += 50;
    }

    riskScore = Math.min(100, riskScore);

    // 4. Generate Final Governance Decision
    let decision = "Approved";
    if (sodViolations.length > 0) {
      decision = "Rejected";
    } else if (fraudFlags.some(f => f.severity === "Critical")) {
      decision = "Rejected";
    } else if (riskScore >= 75 || fraudFlags.some(f => f.severity === "High")) {
      decision = "FlaggedForReview";
    } else if (requiresDualAuthorization || (amount >= 100000 && !approverId)) {
      decision = "DualApprovalRequired";
    }

    // 5. Generate Cryptographic Evidence Hash
    const evidenceData = {
      tenantId,
      transactionId,
      operation,
      amount,
      creatorId,
      approverId,
      decision,
      riskScore,
      sodViolations,
      fraudFlags,
      timestamp: new Date().toISOString()
    };

    const evidenceHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(evidenceData))
      .digest("hex");

    // 6. Save Governance Evaluation Record
    const evaluation = new GovernanceEvaluationModel({
      tenantId,
      evaluationId: this.generateId("EVAL"),
      transactionId,
      operation,
      amount,
      creatorId,
      approverId,
      decision,
      riskScore,
      evaluatedPolicies,
      sodViolations,
      fraudFlags,
      evidenceHash,
      evaluatedAt: new Date(),
      evaluatedBy: userId
    });

    await evaluation.save();

    // 7. Save Evidence Repository Record
    const evidencePkg = new GovernanceEvidenceModel({
      tenantId,
      evidenceId: this.generateId("EVD"),
      evaluationId: evaluation.evaluationId,
      transactionId,
      operation,
      evidenceType: sodViolations.length > 0 ? "SoDVerification" : "AuditPackage",
      evidenceHash,
      snapshot: { ...evidenceData, payload },
      retentionYears: 7,
      legalHold: false,
      createdAt: new Date()
    });

    await evidencePkg.save();

    // 8. Publish Domain Events
    publishEvent("GovernanceEvaluated", {
      tenantId,
      evaluationId: evaluation.evaluationId,
      transactionId,
      operation,
      decision,
      riskScore,
      evidenceHash
    });

    if (sodViolations.length > 0) {
      publishEvent("PolicyViolationDetected", {
        tenantId,
        evaluationId: evaluation.evaluationId,
        transactionId,
        violationType: "SegregationOfDuties",
        sodViolations
      });
    }

    if (fraudFlags.length > 0) {
      publishEvent("FraudDetected", {
        tenantId,
        evaluationId: evaluation.evaluationId,
        transactionId,
        fraudFlags,
        riskScore
      });
    }

    if (decision === "Approved") {
      publishEvent("ComplianceValidated", {
        tenantId,
        evaluationId: evaluation.evaluationId,
        transactionId,
        evidenceHash
      });
      publishEvent("ApprovalGranted", {
        tenantId,
        transactionId,
        approverId
      });
    } else if (decision === "Rejected") {
      publishEvent("ApprovalRejected", {
        tenantId,
        transactionId,
        reason: sodViolations.length > 0 ? "SoD Violation" : "Fraud / Policy Violation"
      });
    }

    publishEvent("FinancialControlTriggered", {
      tenantId,
      transactionId,
      controlType: decision
    });

    publishEvent("GovernanceDashboardUpdated", {
      tenantId,
      timestamp: new Date()
    });

    return evaluation;
  }

  /**
   * GET /api/v1/finance-governance/policies
   */
  static async listPolicies({ tenantId, status, policyType, page = 1, limit = 20 }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (status) query.status = status;
    if (policyType) query.policyType = policyType;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      FinancialGovernancePolicyModel.find(query).sort({ priority: 1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      FinancialGovernancePolicyModel.countDocuments(query)
    ]);

    return { data, total, page: Number(page), limit: Number(limit) };
  }

  static async createPolicy({
    tenantId,
    name,
    policyType,
    priority = 1,
    effectiveDate,
    expirationDate,
    owner = "Chief Compliance Officer",
    description,
    rules = {},
    userId = null
  }) {
    if (!tenantId || !name || !policyType) {
      throw new Error("Missing required policy fields (tenantId, name, policyType).");
    }

    const policy = new FinancialGovernancePolicyModel({
      tenantId,
      policyId: this.generateId("POL"),
      name,
      policyType,
      priority,
      version: 1,
      status: "Active",
      effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
      expirationDate: expirationDate ? new Date(expirationDate) : null,
      owner,
      description,
      rules,
      createdBy: userId,
      updatedBy: userId
    });

    await policy.save();
    return policy;
  }

  /**
   * Segregation of Duties Rules
   */
  static async listSoDRules({ tenantId, status }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (status) query.status = status;

    return await SegregationOfDutiesRuleModel.find(query).sort({ riskLevel: -1 }).lean();
  }

  static async createSoDRule({
    tenantId,
    ruleName,
    firstAction,
    secondAction,
    riskLevel = "High",
    description = null,
    mitigationControl = null,
    userId = null
  }) {
    if (!tenantId || !ruleName || !firstAction || !secondAction) {
      throw new Error("Missing required SoD rule fields (tenantId, ruleName, firstAction, secondAction).");
    }

    const rule = new SegregationOfDutiesRuleModel({
      tenantId,
      ruleId: this.generateId("SOD"),
      ruleName,
      firstAction,
      secondAction,
      riskLevel,
      status: "Active",
      description,
      mitigationControl,
      createdBy: userId
    });

    await rule.save();
    return rule;
  }

  /**
   * Evidence Repository
   */
  static async listEvidencePackages({ tenantId, transactionId, operation, page = 1, limit = 20 }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (transactionId) query.transactionId = transactionId;
    if (operation) query.operation = operation;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      GovernanceEvidenceModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      GovernanceEvidenceModel.countDocuments(query)
    ]);

    return { data, total, page: Number(page), limit: Number(limit) };
  }

  static async getEvidenceById({ tenantId, evidenceId }) {
    if (!tenantId || !evidenceId) throw new Error("tenantId and evidenceId are required.");
    const evidence = await GovernanceEvidenceModel.findOne({ tenantId, evidenceId }).lean();
    if (!evidence) throw new Error(`Evidence ${evidenceId} not found.`);
    return evidence;
  }

  /**
   * Fraud Rules
   */
  static async listFraudRules({ tenantId, status }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (status) query.status = status;

    return await FinancialFraudRuleModel.find(query).sort({ riskSeverity: -1 }).lean();
  }

  static async createFraudRule({
    tenantId,
    ruleName,
    checkType,
    riskSeverity = "High",
    parameters = {},
    userId = null
  }) {
    if (!tenantId || !ruleName || !checkType) {
      throw new Error("Missing required fraud rule fields (tenantId, ruleName, checkType).");
    }

    const rule = new FinancialFraudRuleModel({
      tenantId,
      ruleId: this.generateId("FRD"),
      ruleName,
      checkType,
      riskSeverity,
      parameters,
      status: "Active",
      createdBy: userId
    });

    await rule.save();
    return rule;
  }

  /**
   * Governance Dashboard
   */
  static async getGovernanceDashboard({ tenantId }) {
    if (!tenantId) throw new Error("tenantId is required.");

    const totalPolicies = await FinancialGovernancePolicyModel.countDocuments({ tenantId, status: "Active" });
    const totalSoDRules = await SegregationOfDutiesRuleModel.countDocuments({ tenantId, status: "Active" });
    const totalEvaluations = await GovernanceEvaluationModel.countDocuments({ tenantId });
    const rejectedEvaluations = await GovernanceEvaluationModel.countDocuments({ tenantId, decision: "Rejected" });
    const flaggedEvaluations = await GovernanceEvaluationModel.countDocuments({ tenantId, decision: "FlaggedForReview" });
    const dualApprovalEvaluations = await GovernanceEvaluationModel.countDocuments({ tenantId, decision: "DualApprovalRequired" });
    const evidenceCount = await GovernanceEvidenceModel.countDocuments({ tenantId });

    const recentEvaluations = await GovernanceEvaluationModel.find({ tenantId })
      .sort({ evaluatedAt: -1 })
      .limit(10)
      .lean();

    return {
      complianceStatus: rejectedEvaluations === 0 ? "Compliant" : "ActionRequired",
      totalActivePolicies: totalPolicies,
      totalActiveSoDRules: totalSoDRules,
      totalEvaluations,
      rejectedCount: rejectedEvaluations,
      flaggedCount: flaggedEvaluations,
      dualApprovalCount: dualApprovalEvaluations,
      evidencePackagesCount: evidenceCount,
      recentEvaluations,
      lastUpdated: new Date()
    };
  }
}

export default FinancialGovernanceService;
