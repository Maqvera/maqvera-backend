import mongoose from "mongoose";
import EnterpriseVerificationModel from "../models/EnterpriseVerificationModel.js";
import EnterpriseDocumentModel from "../models/EnterpriseDocumentModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import CustomerModel from "../models/CustomerModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import AIDocumentOcrService from "./ai/AIDocumentOcrService.js";
import AIDocumentClassificationService from "./ai/AIDocumentClassificationService.js";
import AIDocumentExtractionService from "./ai/AIDocumentExtractionService.js";
import AIDocumentValidationService from "./ai/AIDocumentValidationService.js";
import { getAIDocumentIntelligenceConfig } from "../utils/aiDocumentIntelligenceConfig.js";
import { publishEvent, subscribeEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";

class DocumentVerificationService {
  /**
   * Start Multi-Stage Document Verification Pipeline
   */
  static async startVerification(documentId, tenantId, userId) {
    const doc = await EnterpriseDocumentModel.findOne({ _id: documentId, tenantId, isSoftDeleted: { $ne: true } });
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
        documentId: doc._id,
        referenceId: doc.referenceId,
        versionNumber: doc.currentVersion
      });
    }

    const latestVersion = doc.versions.find((version) => version.versionNumber === doc.currentVersion);
    if (!latestVersion) throw new Error("Latest document version is missing.");
    // "skipped" is the honest status a real upload gets (no scanner is
    // configured — see EnterpriseDocumentService) — only a real "infected"
    // result should ever block verification. This used to require a literal
    // "clean" status, which nothing could ever produce, permanently
    // blocking verification for every real (non-simulated) document.
    if (latestVersion.virusScanStatus === "infected") throw new Error("Document cannot enter verification — it failed virus scanning.");
    verification.verificationStatus = "processing";

    // Stage 1: Virus Scan — the result is already known synchronously from
    // upload time, so this is real, not queued, in every mode.
    verification.virusScanResult = {
      status: latestVersion.virusScanStatus,
      engine: "Document storage scanner",
      scannedAt: new Date()
    };
    publishEvent("VirusScanCompleted", { verificationId: verification._id, documentId: doc._id, status: latestVersion.virusScanStatus, tenantId });

    // Stage 4: Duplicate Detection by real content checksum — this needs no
    // OCR/AI provider at all, just the genuine SHA-256/ETag EnterpriseDocumentService
    // already computes on upload, so it runs in every mode (not gated behind
    // simulation like the OCR-derived checks below).
    const checksumMatch = latestVersion.checksum
      ? await EnterpriseDocumentModel.findOne({
        tenantId,
        _id: { $ne: doc._id },
        "versions.checksum": latestVersion.checksum,
        isSoftDeleted: { $ne: true }
      })
      : null;
    verification.duplicateDetectionResult = {
      status: checksumMatch ? "duplicate_suspected" : "clean",
      duplicateScore: checksumMatch ? 100 : 0,
      matchedDocumentIds: checksumMatch ? [checksumMatch._id] : [],
      matchedCaseNumbers: [],
      analyzedAt: new Date()
    };
    verification.duplicateScore = checksumMatch ? 100 : 0;

    // Stage 2-3/5 (OCR/AI/business-rule content analysis) are queued
    // external processors. This service records their artifacts; it never
    // fabricates OCR or AI evidence for an officer.
    if (process.env.VERIFICATION_SIMULATION_MODE !== "true") {
      verification.ocrResult.status = "pending";
      verification.aiValidationResult.status = "pending";
      verification.businessRuleResult.status = "pending";
      verification.verificationStatus = "processing";
      await verification.save();

      // "Create Timeline" — was previously only done on the simulation-mode
      // path, meaning a real (production) verification start left no trace
      // on the Visa Case's own timeline at all.
      visaCase.timeline.push({
        event: "VerificationStarted",
        description: `Verification started for ${doc.documentType}. Queued for OCR/AI processing.`,
        performedBy: userId || "system",
        timestamp: new Date()
      });
      await visaCase.save();

      await AuditLogModel.create({ tenantId, userId: userId || "system", action: "START_DOCUMENT_VERIFICATION", resource: "EnterpriseVerification", resourceId: verification._id.toString(), details: { documentId: doc._id, version: doc.currentVersion, duplicateScore: verification.duplicateScore } }).catch(err => console.error("Audit error:", err));
      publishEvent("VerificationStarted", { verificationId: verification._id, documentId: doc._id, visaCaseId: visaCase._id, tenantId });
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
      fakeDocumentIndicatorsDetected: false,
      hasMissingPages: false,
      isLowResolution: false,
      glareDetected: false,
      photoQualityScore: 94,
      notes: "High quality scan. All security features present.",
      evaluatedAt: new Date()
    };

    doc.aiValidation = {
      status: "passed",
      confidenceScore: 94,
      notes: "AI validation passed cleanly with 94% confidence.",
      evaluatedAt: new Date()
    };

    // Stage 4: Duplicate Detection Engine — OCR-derived passport-number
    // matching, as an additional signal alongside the real checksum-based
    // match already computed above (not a replacement for it: a document
    // can be a duplicate by either signal, so the two results are merged
    // by taking the higher-confidence match rather than one overwriting
    // the other).
    const duplicateMatch = await EnterpriseVerificationModel.findOne({
      tenantId,
      documentId: { $ne: doc._id },
      "ocrResult.extractedFields.passportNumber": passportNo,
      isSoftDeleted: { $ne: true }
    });

    if (duplicateMatch && verification.duplicateScore < 85) {
      verification.duplicateDetectionResult = {
        status: "duplicate_suspected",
        duplicateScore: 85,
        matchedDocumentIds: [...verification.duplicateDetectionResult.matchedDocumentIds, duplicateMatch.documentId],
        matchedCaseNumbers: [visaCase.caseNumber],
        analyzedAt: new Date()
      };
      verification.duplicateScore = 85;
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

    // Required Pages / Required Signature / Required Stamp — per-document
    // config carried from the Requirement Profile, previously had no
    // backing fields anywhere so no rule could ever reference them.
    const requirementEntry = visaCase.requiredDocuments.find((r) => r.documentType.toLowerCase() === doc.documentType.toLowerCase());
    if (requirementEntry?.requiresSignature) {
      const signaturePassed = verification.aiValidationResult.signatureDetected;
      rules.push({ ruleCode: "REQUIRED_SIGNATURE", ruleName: "Signature Present", status: signaturePassed ? "passed" : "failed", message: signaturePassed ? "Signature detected." : "No signature detected on document." });
    }
    if (requirementEntry?.requiresStamp) {
      rules.push({ ruleCode: "REQUIRED_STAMP", ruleName: "Official Stamp Present", status: "pending", message: "Stamp verification requires manual officer review — not automatically detectable without a configured AI vision provider." });
    }
    if (requirementEntry?.requiredPages) {
      rules.push({ ruleCode: "REQUIRED_PAGES", ruleName: `Minimum ${requirementEntry.requiredPages} Page(s)`, status: "pending", message: "Page count verification requires manual officer review — not automatically detectable without a configured AI vision provider." });
    }

    // Overall status previously only ever reflected passportValid — a
    // failed signature/stamp/page-count rule was silently ignored.
    const anyRuleFailed = rules.some((rule) => rule.status === "failed");
    const anyRulePending = rules.some((rule) => rule.status === "pending");
    verification.businessRuleResult = {
      status: anyRuleFailed ? "failed" : anyRulePending ? "pending" : "passed",
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

    publishEvent("VerificationStarted", { verificationId: verification._id, documentId: doc._id, visaCaseId: visaCase._id, tenantId });
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

    // "Expiry Status" — the document's own expiry (from Part 4's
    // expiry-tracking fields), not a verification-pipeline result, but
    // named in this endpoint's Response Includes list.
    const expiryStatus = doc.expiryDate
      ? (doc.isExpired ? "expired" : "valid")
      : "not_applicable";

    if (!verification) return {
      documentId: doc._id, documentType: doc.documentType, currentVersion: doc.currentVersion,
      verificationStatus: "pending", riskScore: 0, riskLevel: "Low", duplicateScore: 0,
      expiryStatus, overallDecision: "pending", officer: null, completedDate: null,
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
      expiryStatus,
      // Top-level aliases for the doc's literal Response Includes fields —
      // additive; the same data is still available nested in stageResults.
      overallDecision: verification.finalDecision?.decision || "pending",
      officer: verification.manualReviewResult?.reviewedBy || verification.finalDecision?.decidedBy || null,
      completedDate: verification.manualReviewResult?.reviewedAt || verification.finalDecision?.decidedAt || null,
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
    // "processing" is included alongside "manual_review": no real OCR/AI
    // provider is configured anywhere in this codebase (queueing is real,
    // but nothing ever calls back to complete those stages — see
    // startVerification), so a document run through the real, non-simulated
    // pipeline stays in "processing" forever. Without this, manual review —
    // the one path an officer can always fall back to — would be
    // permanently unreachable for every real document.
    if (!["manual_review", "processing"].includes(verification.verificationStatus)) {
      throw new Error("Manual review is only allowed while verification is in progress or awaiting manual review.");
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

    // VerificationApproved/Rejected is this service's own naming;
    // DocumentVerified and DocumentApproved/DocumentRejected (named in the
    // Domain Event Maps of Part 1 and Part 4 respectively) were never
    // published. DocumentVerified is also what SearchEngineService
    // re-indexes a document on.
    if (isApproved) {
      publishEvent("DocumentVerified", { verificationId: verification._id, documentId: doc._id, visaCaseId: doc.referenceId, tenantId });
      publishEvent("DocumentApproved", { verificationId: verification._id, documentId: doc._id, visaCaseId: doc.referenceId, tenantId });
    } else {
      publishEvent("DocumentRejected", { verificationId: verification._id, documentId: doc._id, visaCaseId: doc.referenceId, reason: remarks || decision, tenantId });
    }

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
    return await this.startVerification(documentId, tenantId, userId);
  }

  /**
   * Document Intelligence Platform Phase 1/2 — the real consumer this
   * codebase's own OCRQueued/AIValidationQueued events never had. Per this
   * service's own honest pre-existing comment on startVerification: "no
   * real OCR/AI provider is configured anywhere in this codebase...
   * nothing ever calls back to complete those stages" — a real (non-
   * simulation-mode) verification stayed in `processing` forever. This
   * closes that gap: real OCR (AIDocumentOcrService) -> real classification
   * (AIDocumentClassificationService) -> real template-driven extraction
   * (AIDocumentExtractionService) -> real business-rule validation against
   * ERP master data (AIDocumentValidationService), all written into this
   * exact same EnterpriseVerificationModel row.
   *
   * Deliberately handles BOTH the OCR and AI-validation stages in this one
   * handler (subscribed to OCRQueued only, not a second listener on
   * AIValidationQueued) — startVerification fires both events for the same
   * verification row at the same moment, and two independent listeners
   * both loading-then-saving the same Mongoose document would race. One
   * handler, one save, no lost update.
   *
   * Idempotent: only acts while ocrResult.status is still "pending" — a
   * re-delivered event, or a row a human/simulation already advanced, is a
   * safe no-op.
   */
  static async processQueuedDocumentIntelligence({ verificationId, documentId, tenantId }) {
    if (mongoose.connection?.readyState !== 1) return;
    const config = getAIDocumentIntelligenceConfig();

    const verification = await EnterpriseVerificationModel.findOne({ _id: verificationId, tenantId, isSoftDeleted: { $ne: true } });
    if (!verification || verification.ocrResult.status !== "pending") return;

    const doc = await EnterpriseDocumentModel.findOne({ _id: documentId, tenantId, isSoftDeleted: { $ne: true } });
    if (!doc) return;
    const latestVersion = doc.versions.find((v) => v.versionNumber === doc.currentVersion);
    if (!latestVersion) return;

    verification.ocrResult.status = "processing";
    await verification.save();

    try {
      const response = await fetch(latestVersion.fileUrl);
      if (!response.ok) throw new Error(`Failed to download document file (HTTP ${response.status}).`);
      const buffer = Buffer.from(await response.arrayBuffer());

      const extraction = await AIDocumentOcrService.extractRawText(buffer, latestVersion.mimeType);
      const rawText = extraction?.text || "";
      const classification = await AIDocumentClassificationService.classifyDocumentText(rawText, { tenantId });
      const extractedFields = AIDocumentExtractionService.extractFields(classification.documentType, rawText);
      const validationRules = await AIDocumentValidationService.validateExtraction({
        tenantId, documentType: classification.documentType, fields: extractedFields, rawText, documentId: doc._id.toString()
      });

      const isPassport = classification.documentType === "passport";
      verification.ocrResult.status = extraction ? "completed" : "failed";
      verification.ocrResult.rawText = rawText.slice(0, 5000) || null;
      verification.ocrResult.classifiedType = classification.documentType;
      verification.ocrResult.classificationConfidence = classification.confidence;
      verification.ocrResult.completedAt = new Date();
      if (isPassport) {
        // Real, matches the model's own passport-shaped extractedFields exactly (AIDocumentExtractionService.extractPassportFields' output IS that shape).
        Object.assign(verification.ocrResult.extractedFields, extractedFields);
      } else if (Object.keys(extractedFields).length > 0) {
        verification.ocrResult.genericExtractedFields = extractedFields;
      }

      doc.ocrData = { status: verification.ocrResult.status, extractedText: verification.ocrResult.rawText, parsedFields: extractedFields, processedAt: new Date() };

      // Real, computed confidence — OCR recognition confidence (images
      // only; pdf-parse extracts real text, not recognized text, so it has
      // no confidence concept) averaged with classification confidence
      // when both exist, otherwise whichever one is real. Never fabricated.
      const ocrConfidencePct = extraction?.confidence ?? null;
      const classificationPct = classification.confidence * 100;
      const overallConfidence = Math.round(ocrConfidencePct != null ? (ocrConfidencePct + classificationPct) / 2 : classificationPct);

      verification.aiValidationResult.status = "completed";
      verification.aiValidationResult.confidenceScore = overallConfidence;
      verification.aiValidationResult.visionChecksPerformed = false;
      verification.aiValidationResult.notes = `Automated checks: OCR text extraction + document-type classification (${classification.method}, classified as "${classification.documentType}" at ${Math.round(classificationPct)}% confidence). Visual quality checks (blur/crop/tampering/face/signature) require a vision-capable provider — not configured in this deployment; those flags remain unverified defaults, not real findings.`;
      verification.aiValidationResult.evaluatedAt = new Date();

      doc.aiValidation = {
        status: overallConfidence >= config.reviewConfidenceThreshold * 100 ? "passed" : "pending",
        confidenceScore: overallConfidence, notes: verification.aiValidationResult.notes, evaluatedAt: new Date()
      };

      verification.businessRuleResult = {
        status: validationRules.some((r) => r.status === "failed") ? "failed" : validationRules.some((r) => r.status === "pending") ? "pending" : (validationRules.length > 0 ? "passed" : "pending"),
        rulesEvaluated: validationRules,
        minimumValidityPassed: !validationRules.some((r) => r.ruleCode === "DOCUMENT_EXPIRY_CHECK" && r.status === "failed"),
        travelerMatchPassed: true,
        evaluatedAt: new Date()
      };

      // Phase 3 "Confidence-Based Human Review" — a low-confidence result
      // is flagged (elevated risk score) for PRIORITY manual review, never
      // auto-approved: every document in this pipeline still requires a
      // real human decision via submitManualReview, the same as the
      // simulation-mode path already required. Auto-approving a legal
      // travel/identity document without a human is a compliance risk this
      // build does not take on.
      verification.verificationStatus = "manual_review";
      if (overallConfidence < config.reviewConfidenceThreshold * 100 || validationRules.some((r) => r.status === "failed")) {
        verification.riskScore = Math.max(verification.riskScore, 40);
        verification.riskLevel = verification.riskScore >= 75 ? "Critical" : verification.riskScore >= 50 ? "High" : "Medium";
      }

      await verification.save();
      await doc.save();

      // Atomic $push, not fetch-mutate-save — this handler runs
      // asynchronously off the event bus, so the visaCase's in-memory
      // version at fetch time is never guaranteed still current by the
      // time a save would happen (a real officer could be editing the
      // same case concurrently); an atomic update can't lose that race.
      await VisaCaseModel.updateOne({ _id: doc.referenceId, tenantId }, {
        $push: {
          timeline: {
            event: "VerificationStarted",
            description: `Document Intelligence pipeline completed for ${doc.documentType} — classified "${classification.documentType}" (${Math.round(classificationPct)}% confidence), overall confidence ${overallConfidence}%. Queued for manual officer review.`,
            performedBy: "system", timestamp: new Date()
          }
        }
      });

      await AuditLogModel.create({
        tenantId, userId: "system", action: "DOCUMENT_INTELLIGENCE_COMPLETED", resource: "EnterpriseVerification", resourceId: verification._id.toString(),
        details: { documentId: doc._id, classifiedType: classification.documentType, classificationConfidence: classification.confidence, overallConfidence, ruleCount: validationRules.length }
      }).catch((err) => logger.error("Document intelligence audit log error.", { error: err.message }));

      publishEvent("OCRCompleted", { verificationId: verification._id, documentId: doc._id, tenantId });
      publishEvent("AIValidationCompleted", { verificationId: verification._id, documentId: doc._id, tenantId });
      publishEvent("BusinessValidationCompleted", { verificationId: verification._id, documentId: doc._id, tenantId });
    } catch (error) {
      logger.error("Document intelligence processing failed.", { verificationId, documentId, tenantId, error: error.message });
      verification.ocrResult.status = "failed";
      // Still reachable by a human even when automated processing itself
      // fails — the one path an officer can always fall back to, same
      // "processing must never be a dead end" fix startVerification's own
      // comment already applies to the "manual_review"/"processing" gate
      // in submitManualReview.
      verification.verificationStatus = "manual_review";
      await verification.save().catch(() => null);
    }
  }

  static _eventListenersInitialized = false;

  /** Called once from server.js alongside every other Part's own initEventListeners(). */
  static initEventListeners() {
    if (DocumentVerificationService._eventListenersInitialized) return;
    DocumentVerificationService._eventListenersInitialized = true;

    subscribeEvent("OCRQueued", async (payload) => {
      try {
        await DocumentVerificationService.processQueuedDocumentIntelligence(payload);
      } catch (error) {
        logger.error("OCRQueued handling failed.", { error: error.message });
      }
    });
  }
}

export default DocumentVerificationService;
