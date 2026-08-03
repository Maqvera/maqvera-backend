import EnterpriseVerificationModel from "../models/EnterpriseVerificationModel.js";
import EnterpriseDocumentModel from "../models/EnterpriseDocumentModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import CustomerModel from "../models/CustomerModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";

class DocumentVerificationService {
  /**
   * Start Multi-Stage Document Verification Pipeline
   */
  static async startVerification(documentId, tenantId, branchId, userId) {
    const documentFilter = { _id: documentId, tenantId, isSoftDeleted: { $ne: true } };
    if (branchId) documentFilter.branchId = branchId;
    const doc = await EnterpriseDocumentModel.findOne(documentFilter);
    if (!doc) {
      throw new Error("Document not found.");
    }

    const visaCase = await VisaCaseModel.findOne({ _id: doc.referenceId, tenantId });
    if (!visaCase) {
      throw new Error("Associated Visa Case not found.");
    }

    let verification = await EnterpriseVerificationModel.findOne({
      tenantId,
      documentId: doc._id,
      versionNumber: doc.currentVersion,
      isSoftDeleted: { $ne: true }
    });

    if (!verification) {
      verification = new EnterpriseVerificationModel({
        tenantId,
        branchId: branchId || doc.branchId || "main",
        documentId: doc._id,
        referenceId: doc.referenceId,
        versionNumber: doc.currentVersion
      });
    }

    const latestVersion = doc.versions.find((version) => version.versionNumber === doc.currentVersion);
    if (!latestVersion) throw new Error("Latest document version is missing.");
    if (latestVersion.virusScanStatus !== "clean") throw new Error("Document cannot enter verification until virus scanning is clean.");
    verification.verificationStatus = "processing";

    // Stage 1: Virus Scan
    verification.virusScanResult = {
      status: latestVersion.virusScanStatus,
      engine: "Document storage scanner",
      scannedAt: new Date()
    };

    // Stage 2-5 are queued external processors. This service records their
    // artifacts; it never fabricates OCR or AI evidence for an officer.
    if (process.env.VERIFICATION_SIMULATION_MODE !== "true") {
      verification.ocrResult.status = "pending";
      verification.aiValidationResult.status = "pending";
      verification.businessRuleResult.status = "pending";
      verification.verificationStatus = "processing";
      await verification.save();
      await AuditLogModel.create({ tenantId, userId: userId || "system", action: "START_DOCUMENT_VERIFICATION", resource: "EnterpriseVerification", resourceId: verification._id.toString(), details: { documentId: doc._id, version: doc.currentVersion } }).catch(err => console.error("Audit error:", err));
      publishEvent("VerificationStarted", { verificationId: verification._id, documentId: doc._id, visaCaseId: visaCase._id, tenantId, branchId: doc.branchId });
      publishEvent("OCRQueued", { verificationId: verification._id, documentId: doc._id, tenantId });
      publishEvent("AIValidationQueued", { verificationId: verification._id, documentId: doc._id, tenantId });
      return verification;
    }

    // Simulation mode is explicitly opt-in for local development only.
    const travelerSnap = visaCase.travelerSnapshot || {};
    const passportNo = travelerSnap.passportNumber || "P" + Math.floor(10000000 + Math.random() * 90000000);
    const expDate = doc.expiryDate || travelerSnap.passportExpiry || new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000);
    const dob = travelerSnap.dateOfBirth || new Date("1992-05-15");

    verification.ocrResult = {
      status: "completed",
      extractedFields: {
        passportNumber: passportNo,
        holderName: travelerSnap.fullName || `${travelerSnap.firstName || "John"} ${travelerSnap.lastName || "Doe"}`,
        nationality: travelerSnap.nationality || visaCase.destinationCountry || "Pakistani",
        dateOfBirth: dob,
        gender: travelerSnap.gender || "Male",
        issueDate: new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000),
        expiryDate: expDate,
        mrz: `P<PAK${passportNo}<<<<<<<<<<<<<<<9205154M3208182<<<<<<<<<<<<<<04`,
        documentNumber: passportNo
      },
      rawText: `PASSPORT REPUBLIC OF PAKISTAN - TYPE P - COUNTRY PAK - SURNAME: ${travelerSnap.lastName || "DOE"} - GIVEN NAMES: ${travelerSnap.firstName || "JOHN"} - PASSPORT NO: ${passportNo}`,
      completedAt: new Date()
    };

    // Update OCR data on document entity
    doc.ocrData = {
      status: "completed",
      extractedText: verification.ocrResult.rawText,
      parsedFields: verification.ocrResult.extractedFields,
      processedAt: new Date()
    };

    // Stage 3: AI Validation Engine
    verification.aiValidationResult = {
      status: "completed",
      confidenceScore: 94,
      isBlurry: false,
      isCropped: false,
      tamperingDetected: false,
      faceDetected: true,
      signatureDetected: true,
      notes: "High quality scan. All security features present.",
      evaluatedAt: new Date()
    };

    doc.aiValidation = {
      status: "passed",
      confidenceScore: 94,
      notes: "AI validation passed cleanly with 94% confidence.",
      evaluatedAt: new Date()
    };

    // Stage 4: Duplicate Detection Engine
    const duplicateMatch = await EnterpriseVerificationModel.findOne({
      tenantId,
      documentId: { $ne: doc._id },
      "ocrResult.extractedFields.passportNumber": passportNo,
      isSoftDeleted: { $ne: true }
    });

    if (duplicateMatch) {
      verification.duplicateDetectionResult = {
        status: "duplicate_suspected",
        duplicateScore: 85,
        matchedDocumentIds: [duplicateMatch.documentId],
        matchedCaseNumbers: [visaCase.caseNumber],
        analyzedAt: new Date()
      };
      verification.duplicateScore = 85;
    } else {
      verification.duplicateDetectionResult = {
        status: "clean",
        duplicateScore: 0,
        matchedDocumentIds: [],
        matchedCaseNumbers: [],
        analyzedAt: new Date()
      };
      verification.duplicateScore = 0;
    }

    // Stage 5: Business Rule Engine
    const now = new Date();
    const daysToExpiry = Math.ceil((new Date(expDate) - now) / (1000 * 60 * 60 * 24));
    const passportRule = (visaCase.requirementProfileSnapshot?.eligibilityRules || []).find((rule) => rule.ruleCode === "PASSPORT_VALIDITY");
    const minValidityMonths = passportRule?.minimumPassportValidityMonths || 0;
    const minValidityDays = minValidityMonths * 30;
    const passportValid = daysToExpiry >= minValidityDays;

    const rules = [
      {
        ruleCode: "PASSPORT_EXPIRY_CHECK",
        ruleName: `Passport Expiry >= ${minValidityMonths} Months`,
        status: passportValid ? "passed" : "failed",
        message: passportValid ? `Passport valid for ${Math.floor(daysToExpiry / 30)} months.` : `Passport expires in ${daysToExpiry} days (less than 6 months).`
      },
      {
        ruleCode: "TRAVELER_NAME_MATCH",
        ruleName: "Document Holder Matches Traveler Record",
        status: "passed",
        message: "Holder name matches traveler profile."
      }
    ];

    verification.businessRuleResult = {
      status: passportValid ? "passed" : "failed",
      rulesEvaluated: rules,
      minimumValidityPassed: passportValid,
      travelerMatchPassed: true,
      evaluatedAt: new Date()
    };

    // Calculate Cumulative Risk Score
    let riskScore = 10; // Base low risk
    if (!passportValid) riskScore += 40;
    if (verification.duplicateScore > 50) riskScore += 30;
    if (verification.aiValidationResult.tamperingDetected) riskScore += 50;
    riskScore = Math.min(riskScore, 100);

    let riskLevel = "Low";
    if (riskScore >= 75) riskLevel = "Critical";
    else if (riskScore >= 50) riskLevel = "High";
    else if (riskScore >= 25) riskLevel = "Medium";

    verification.riskScore = riskScore;
    verification.riskLevel = riskLevel;
    verification.verificationStatus = "manual_review";

    await verification.save();
    await doc.save();

    // Timeline & Audit
    visaCase.timeline.push({
      event: "VerificationStarted",
      description: `Multi-stage verification completed for ${doc.documentType} (Risk: ${riskLevel}, Score: ${riskScore}). Queued for manual officer review.`,
      performedBy: userId || "system",
      timestamp: new Date()
    });
    await visaCase.save();

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "START_DOCUMENT_VERIFICATION",
      resource: "EnterpriseVerification",
      resourceId: verification._id.toString(),
      details: { documentId: doc._id, riskScore, riskLevel, duplicateScore: verification.duplicateScore }
    }).catch(err => console.error("Audit error:", err));

    publishEvent("VerificationStarted", { verificationId: verification._id, documentId: doc._id, visaCaseId: visaCase._id, tenantId, branchId: doc.branchId });
    publishEvent("OCRCompleted", { verificationId: verification._id, documentId: doc._id, tenantId });
    publishEvent("AIValidationCompleted", { verificationId: verification._id, documentId: doc._id, tenantId });
    publishEvent("BusinessValidationCompleted", { verificationId: verification._id, documentId: doc._id, tenantId });

    return verification;
  }

  /**
   * Get verification details & independent stage results
   */
  static async getVerificationDetails(documentId, tenantId) {
    const doc = await EnterpriseDocumentModel.findOne({ _id: documentId, tenantId, isSoftDeleted: { $ne: true } });
    if (!doc) {
      throw new Error("Document not found.");
    }

    const verification = await EnterpriseVerificationModel.findOne({
      tenantId,
      documentId: doc._id,
      versionNumber: doc.currentVersion,
      isSoftDeleted: { $ne: true }
    });

    if (!verification) return {
      documentId: doc._id, documentType: doc.documentType, currentVersion: doc.currentVersion,
      verificationStatus: "pending", riskScore: 0, riskLevel: "Low", duplicateScore: 0,
      stageResults: null, history: [], createdAt: null, updatedAt: null
    };

    return {
      documentId: doc._id,
      documentType: doc.documentType,
      currentVersion: doc.currentVersion,
      verificationStatus: verification.verificationStatus,
      riskScore: verification.riskScore,
      riskLevel: verification.riskLevel,
      duplicateScore: verification.duplicateScore,
      stageResults: {
        virusScan: verification.virusScanResult,
        ocr: verification.ocrResult,
        aiValidation: verification.aiValidationResult,
        duplicateDetection: verification.duplicateDetectionResult,
        businessRules: verification.businessRuleResult,
        manualReview: verification.manualReviewResult,
        finalDecision: verification.finalDecision
      },
      history: verification.history || [],
      createdAt: verification.createdAt,
      updatedAt: verification.updatedAt
    };
  }

  /**
   * Manual Officer Review
   */
  static async submitManualReview(documentId, { decision, remarks }, tenantId, userId) {
    if (!decision) {
      throw new Error("Review decision is required.");
    }
    const allowedDecisions = new Set(["approved", "rejected", "needs better scan", "needs additional pages", "forgery suspected", "escalate"]);
    if (!allowedDecisions.has(String(decision).toLowerCase())) throw new Error("Invalid manual review decision.");

    const doc = await EnterpriseDocumentModel.findOne({ _id: documentId, tenantId, isSoftDeleted: { $ne: true } });
    if (!doc) {
      throw new Error("Document not found.");
    }

    const verification = await EnterpriseVerificationModel.findOne({
      tenantId,
      documentId: doc._id,
      versionNumber: doc.currentVersion,
      isSoftDeleted: { $ne: true }
    });

    if (!verification) {
      throw new Error("Verification record not found. Please start verification first.");
    }
    if (verification.verificationStatus !== "manual_review") {
      throw new Error("Manual review is only allowed after automated verification stages complete.");
    }

    const isApproved = decision.toLowerCase() === "approved";
    const isRejected = decision.toLowerCase().includes("reject") || decision.toLowerCase().includes("scan") || decision.toLowerCase().includes("forgery");

    verification.manualReviewResult = {
      status: "completed",
      decision,
      remarks: remarks || null,
      reviewedBy: userId || "system",
      reviewedByName: "Visa Officer",
      reviewedAt: new Date()
    };

    if (isApproved) {
      verification.finalDecision = {
        decision: "approved",
        isEmbassyReady: true,
        decidedBy: userId || "system",
        decidedAt: new Date()
      };
      verification.verificationStatus = "approved";
      doc.verificationStatus = "verified";
      doc.approvalStatus = "approved";
    } else {
      verification.finalDecision = {
        decision: "rejected",
        isEmbassyReady: false,
        decidedBy: userId || "system",
        decidedAt: new Date()
      };
      verification.verificationStatus = "rejected";
      doc.verificationStatus = "rejected";
      doc.approvalStatus = isRejected ? "reupload_required" : "rejected";
    }

    await verification.save();
    await doc.save();

    // Update Visa Case Aggregate
    const visaCase = await VisaCaseModel.findOne({ _id: doc.referenceId, tenantId });
    if (visaCase) {
      const reqIndex = visaCase.requiredDocuments.findIndex(r => r.documentType.toLowerCase() === doc.documentType.toLowerCase());
      if (reqIndex !== -1) {
        visaCase.requiredDocuments[reqIndex].verificationStatus = isApproved ? "verified" : "failed";
        visaCase.requiredDocuments[reqIndex].status = isApproved ? "verified" : "rejected";
        visaCase.requiredDocuments[reqIndex].verifiedBy = userId || "system";
        visaCase.requiredDocuments[reqIndex].verifiedAt = new Date();
        if (!isApproved) visaCase.requiredDocuments[reqIndex].rejectionReason = remarks || decision;
      }

      visaCase.timeline.push({
        event: isApproved ? "VerificationApproved" : "VerificationRejected",
        description: `Manual review for ${doc.documentType} completed by officer (${decision}). ${remarks || ""}`,
        performedBy: userId || "system",
        timestamp: new Date()
      });
      await visaCase.save();
    }

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "MANUAL_DOCUMENT_REVIEW",
      resource: "EnterpriseVerification",
      resourceId: verification._id.toString(),
      details: { documentId: doc._id, decision, remarks }
    }).catch(err => console.error("Audit error:", err));

    publishEvent("ManualReviewCompleted", { verificationId: verification._id, documentId: doc._id, decision, tenantId });
    publishEvent(isApproved ? "VerificationApproved" : "VerificationRejected", { verificationId: verification._id, documentId: doc._id, tenantId });

    return verification;
  }

  /**
   * Re-verify Document (Restarts pipeline for latest version)
   */
  static async reverifyDocument(documentId, tenantId, userId) {
    const doc = await EnterpriseDocumentModel.findOne({ _id: documentId, tenantId, isSoftDeleted: { $ne: true } });
    if (!doc) {
      throw new Error("Document not found.");
    }

    const existingVerification = await EnterpriseVerificationModel.findOne({
      tenantId,
      documentId: doc._id,
      versionNumber: doc.currentVersion,
      isSoftDeleted: { $ne: true }
    });

    if (existingVerification) {
      // Archive current attempt into history
      existingVerification.history.push({
        verificationStatus: existingVerification.verificationStatus,
        riskScore: existingVerification.riskScore,
        stageResults: {
          ocr: existingVerification.ocrResult,
          ai: existingVerification.aiValidationResult,
          duplicate: existingVerification.duplicateDetectionResult,
          business: existingVerification.businessRuleResult,
          manual: existingVerification.manualReviewResult,
          final: existingVerification.finalDecision
        },
        reverifiedAt: new Date(),
        reverifiedBy: userId || "system"
      });
      await existingVerification.save();
    }

    publishEvent("VerificationRestarted", { documentId: doc._id, tenantId });

    // Re-run pipeline
    return await this.startVerification(documentId, tenantId, doc.branchId, userId);
  }
}

export default DocumentVerificationService;
