import ReceiptModel from "../models/ReceiptModel.js";
import PaymentModel from "../models/PaymentModel.js";
import CustomerModel from "../models/CustomerModel.js";
import VendorModel from "../models/VendorModel.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import ReceiptPdfService from "./ReceiptPdfService.js";
import ReceiptQrService from "./ReceiptQrService.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { getDeliveryAdapter } from "./delivery/index.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import { resolveTenantBranding } from "../utils/tenantBranding.js";

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/receiptService.test.js).
// ---------------------------------------------------------------------------

/** "Payment Verified" (Validation Rules) — equivalent to the payment having reached a funds-confirmed status (see utils/financeConfig.js doc comment). */
export const isReceiptEligiblePayment = (paymentStatus, eligibleStatuses) => eligibleStatuses.includes(paymentStatus);

/** Explicit override wins; otherwise falls back to the payment's own (optional) party. */
export const resolveReceiptParty = (payment, override = {}) => {
  if (override.partyType && override.partyId) return { partyType: override.partyType, partyId: override.partyId };
  if (payment.partyType && payment.partyId) return { partyType: payment.partyType, partyId: payment.partyId };
  return { partyType: null, partyId: null };
};

/** Which contact field a delivery method should use, given a loaded Customer/Vendor document. */
export const resolveContactForMethod = (method, partyDoc) => {
  if (!partyDoc) return null;
  if (method === "Email") return partyDoc.email || partyDoc.contactEmail || null;
  if (method === "WhatsApp" || method === "SMS") return partyDoc.phone || partyDoc.contactPhone || null;
  return null;
};

/** A receipt only advances to "Delivered" once at least one channel genuinely confirms Sent — never assumed. */
export const resolveStatusAfterDelivery = (deliveryHistory) => {
  if (deliveryHistory.some((entry) => entry.status === "Sent")) return "Delivered";
  if (deliveryHistory.length > 0) return "Issued";
  return "Generated";
};

const TERMINAL_STATUSES = new Set(["Cancelled", "Voided"]);

class ReceiptService {
  static async _generateReceiptNumber(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "receiptNumber", year);
    return `${config.receiptNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  static async _loadParty(partyType, partyId, tenantId) {
    if (!partyType || !partyId) return null;
    if (partyType === "customer") return CustomerModel.findOne({ _id: partyId, tenantId }).lean();
    if (partyType === "vendor") return VendorModel.findOne({ _id: partyId, tenantId }).lean();
    return null;
  }

  static _partyDisplayName(partyDoc) {
    if (!partyDoc) return null;
    if (partyDoc.name) return partyDoc.name; // Vendor
    return `${partyDoc.firstName || ""} ${partyDoc.lastName || ""}`.trim() || partyDoc.companyName || null; // Customer
  }

  /** Attempts delivery across every requested method, returning deliveryHistory entries. Never throws — a channel failure is recorded, not fatal to receipt generation. */
  static async _attemptDeliveries({ deliveryMethods, partyDoc, subject, body, attachment, receiptNumber, verificationUrl, webhookUrl }) {
    const history = [];
    for (const method of deliveryMethods) {
      const adapter = getDeliveryAdapter(method);
      if (!adapter) {
        history.push({ method, status: "NotConfigured", failureReason: `No delivery adapter is implemented for "${method}" yet.`, providerResponse: null });
        continue;
      }
      const to = method === "Webhook" ? null : resolveContactForMethod(method, partyDoc);
      if (method !== "Webhook" && !to) {
        history.push({ method, status: "Failed", failureReason: `No contact information available for ${method} delivery.`, providerResponse: null });
        continue;
      }
      const result = await adapter.send({ to, subject, body, attachment, receiptNumber, verificationUrl, webhookUrl });
      history.push({ method, status: result.status, failureReason: result.failureReason, providerResponse: result.providerResponse });
    }
    return history;
  }

  /**
   * POST /api/v1/receipts
   * Validate Payment -> Validate Allocation -> Generate Receipt -> Assign
   * Receipt Number -> Generate QR Code -> Generate PDF -> (Attempt
   * Delivery) -> Timeline -> Audit -> Publish ReceiptGenerated.
   */
  static async createReceipt(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { paymentId, template = config.defaultReceiptTemplate, deliveryMethods = [], webhookUrl, partyType: partyOverrideType, partyId: partyOverrideId } = data;

    if (!paymentId) throw new Error("paymentId is required.");

    const payment = await PaymentModel.findOne({ _id: paymentId, tenantId }).lean();
    if (!payment) throw new Error("Payment not found.");
    if (!isReceiptEligiblePayment(payment.status, config.receiptEligiblePaymentStatuses)) {
      throw new Error(`Payment has not been verified yet (status "${payment.status}") — a receipt can only be generated for a captured/allocated/settled payment.`);
    }

    if (!config.receiptAllowMultiplePerPayment) {
      const existing = await ReceiptModel.findOne({ tenantId, paymentId, status: { $nin: [...TERMINAL_STATUSES] } }).lean();
      if (existing) throw new Error(`Receipt already exists for this payment (${existing.receiptNumber}). Use reissue instead, or enable RECEIPT_ALLOW_MULTIPLE_PER_PAYMENT.`);
    }

    const { partyType, partyId } = resolveReceiptParty(payment, { partyType: partyOverrideType, partyId: partyOverrideId });
    const partyDoc = await ReceiptService._loadParty(partyType, partyId, tenantId);
    const partyName = ReceiptService._partyDisplayName(partyDoc);

    const receiptNumber = await ReceiptService._generateReceiptNumber(tenantId);
    const token = ReceiptQrService.generateVerificationToken();
    const verificationUrl = ReceiptQrService.buildVerificationUrl(config.receiptVerificationBaseUrl, token);
    const qrPngBuffer = await ReceiptQrService.generateQrPngBuffer(verificationUrl);

    const allocationsSnapshot = (payment.allocations || []).map((a) => ({ targetType: a.targetType, targetId: a.targetId, amount: a.amount }));
    const company = await resolveTenantBranding(tenantId);

    const pdfBuffer = await ReceiptPdfService.generatePdfBuffer({
      receiptNumber, template, issueDate: new Date(), amount: payment.amount, currency: payment.currency,
      paymentNumber: payment.paymentNumber, partyName, allocations: allocationsSnapshot, qrPngBuffer, company
    });
    const storedPdf = await storeDocumentPdf({ tenantId, folder: "receipts", filename: `${receiptNumber}.pdf`, buffer: pdfBuffer });

    const deliveryHistory = await ReceiptService._attemptDeliveries({
      deliveryMethods, partyDoc,
      subject: `Receipt ${receiptNumber}`,
      body: `Your receipt ${receiptNumber} for ${payment.amount} ${payment.currency} is attached. Verify it at ${verificationUrl}`,
      attachment: { filename: `${receiptNumber}.pdf`, buffer: pdfBuffer, contentType: "application/pdf" },
      receiptNumber, verificationUrl, webhookUrl
    });

    const receipt = await ReceiptModel.create({
      tenantId,
      receiptNumber,
      paymentId: payment._id,
      paymentNumber: payment.paymentNumber,
      template,
      partyType,
      partyId,
      amount: payment.amount,
      currency: payment.currency,
      issueDate: new Date(),
      status: resolveStatusAfterDelivery(deliveryHistory),
      allocationsSnapshot,
      qrCode: { token, verificationUrl, generatedAt: new Date() },
      pdf: { url: storedPdf.url, storageKey: storedPdf.storageKey, storageProvider: storedPdf.storageProvider, generatedAt: new Date() },
      deliveryMethods,
      deliveryHistory,
      timeline: [{ event: "ReceiptGenerated", description: `Receipt ${receiptNumber} generated for payment ${payment.paymentNumber}.`, performedBy: userId || null }],
      createdBy: userId || null
    });

    await AuditLogModel.create({
      action: "finance.receipt.create",
      module: "Finance",
      resource: "Receipt",
      resourceId: receipt._id.toString(),
      userId: userId || null,
      tenantId,
      details: { receiptNumber, paymentId: paymentId.toString(), deliveryMethods }
    });

    publishEvent("ReceiptGenerated", { tenantId, receiptId: receipt._id.toString(), receiptNumber, paymentId: paymentId.toString(), performedBy: userId || null });
    if (deliveryHistory.length > 0) publishEvent("ReceiptIssued", { tenantId, receiptId: receipt._id.toString(), receiptNumber, performedBy: userId || null });
    if (receipt.status === "Delivered") publishEvent("ReceiptDelivered", { tenantId, receiptId: receipt._id.toString(), receiptNumber, performedBy: userId || null });

    return receipt.toJSON();
  }

  /**
   * GET /api/v1/receipts
   */
  static async listReceipts(query, tenantId) {
    const { receiptNumber, paymentId, customerId, status } = query;
    const filter = { tenantId };
    if (receiptNumber) filter.receiptNumber = receiptNumber;
    if (paymentId) filter.paymentId = paymentId;
    if (customerId) { filter.partyType = "customer"; filter.partyId = customerId; }
    if (status) filter.status = status;
    if (query.dateFrom || query.dateTo) {
      filter.issueDate = {};
      if (query.dateFrom) filter.issueDate.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.issueDate.$lte = new Date(query.dateTo);
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
    const skip = (page - 1) * pageSize;

    let sortSpec = { issueDate: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      const field = query.sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      ReceiptModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      ReceiptModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getReceiptById(receiptId, tenantId) {
    const receipt = await ReceiptModel.findOne({ _id: receiptId, tenantId }).lean();
    if (!receipt) throw new Error("Receipt not found.");

    const auditSummary = await AuditLogModel.find({ tenantId, resource: "Receipt", resourceId: receipt._id.toString() }).sort({ createdAt: -1 }).limit(20).lean();
    return { ...receipt, auditSummary };
  }

  /**
   * POST /api/v1/receipts/{receiptId}/reissue
   * Validate Permission -> Generate New Copy -> Link Original Receipt ->
   * Timeline -> Audit -> Publish ReceiptReissued. "Original receipt preserved."
   */
  static async reissue(receiptId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const original = await ReceiptModel.findOne({ _id: receiptId, tenantId });
    if (!original) throw new Error("Receipt not found.");
    if (TERMINAL_STATUSES.has(original.status)) {
      throw new Error(`Cannot reissue a receipt in status "${original.status}".`);
    }

    const partyDoc = await ReceiptService._loadParty(original.partyType, original.partyId, tenantId);
    const partyName = ReceiptService._partyDisplayName(partyDoc);

    const receiptNumber = await ReceiptService._generateReceiptNumber(tenantId);
    const token = ReceiptQrService.generateVerificationToken();
    const verificationUrl = ReceiptQrService.buildVerificationUrl(config.receiptVerificationBaseUrl, token);
    const qrPngBuffer = await ReceiptQrService.generateQrPngBuffer(verificationUrl);

    const company = await resolveTenantBranding(tenantId);
    const pdfBuffer = await ReceiptPdfService.generatePdfBuffer({
      receiptNumber, template: original.template, issueDate: new Date(), amount: original.amount, currency: original.currency,
      paymentNumber: original.paymentNumber, partyName, allocations: original.allocationsSnapshot, qrPngBuffer, company
    });
    const storedPdf = await storeDocumentPdf({ tenantId, folder: "receipts", filename: `${receiptNumber}.pdf`, buffer: pdfBuffer });

    const deliveryMethods = data?.deliveryMethods || [];
    const deliveryHistory = await ReceiptService._attemptDeliveries({
      deliveryMethods, partyDoc,
      subject: `Reissued Receipt ${receiptNumber}`,
      body: `A reissued copy of your receipt (originally ${original.receiptNumber}) is attached. Verify it at ${verificationUrl}`,
      attachment: { filename: `${receiptNumber}.pdf`, buffer: pdfBuffer, contentType: "application/pdf" },
      receiptNumber, verificationUrl, webhookUrl: data?.webhookUrl
    });

    const reissued = await ReceiptModel.create({
      tenantId,
      receiptNumber,
      paymentId: original.paymentId,
      paymentNumber: original.paymentNumber,
      template: original.template,
      partyType: original.partyType,
      partyId: original.partyId,
      amount: original.amount,
      currency: original.currency,
      issueDate: new Date(),
      status: resolveStatusAfterDelivery(deliveryHistory),
      allocationsSnapshot: original.allocationsSnapshot,
      qrCode: { token, verificationUrl, generatedAt: new Date() },
      pdf: { url: storedPdf.url, storageKey: storedPdf.storageKey, storageProvider: storedPdf.storageProvider, generatedAt: new Date() },
      deliveryMethods,
      deliveryHistory,
      reissueOf: original._id,
      timeline: [{ event: "ReceiptGenerated", description: `Reissued copy of ${original.receiptNumber}.`, performedBy: userId || null }],
      createdBy: userId || null
    });

    original.status = "Reissued";
    original.reissuedBy = reissued._id;
    original.timeline.push({ event: "ReceiptReissued", description: `Reissued as ${receiptNumber}.`, performedBy: userId || null });
    await original.save();

    await AuditLogModel.create({ action: "finance.receipt.reissue", module: "Finance", resource: "Receipt", resourceId: original._id.toString(), userId: userId || null, tenantId, details: { reissuedAs: receiptNumber } });
    publishEvent("ReceiptReissued", { tenantId, originalReceiptId: original._id.toString(), reissuedReceiptId: reissued._id.toString(), performedBy: userId || null });

    return { original: original.toJSON(), reissued: reissued.toJSON() };
  }

  /**
   * POST /api/v1/receipts/{receiptId}/cancel — gap-fill: "Receipt
   * Cancellation... Reason required. History preserved." No endpoint was
   * contracted to reach `Cancelled` / fire `ReceiptCancelled`.
   */
  static async cancel(receiptId, data, tenantId, userId) {
    const { reason } = data;
    if (!reason) throw new Error("A cancellation reason is required.");

    const receipt = await ReceiptModel.findOne({ _id: receiptId, tenantId });
    if (!receipt) throw new Error("Receipt not found.");
    if (TERMINAL_STATUSES.has(receipt.status)) {
      throw new Error(`Receipt is already in status "${receipt.status}".`);
    }

    receipt.status = "Cancelled";
    receipt.cancelledBy = userId || null;
    receipt.cancelledAt = new Date();
    receipt.cancellationReason = reason;
    receipt.timeline.push({ event: "ReceiptCancelled", description: reason, performedBy: userId || null });
    await receipt.save();

    await AuditLogModel.create({ action: "finance.receipt.cancel", module: "Finance", resource: "Receipt", resourceId: receipt._id.toString(), userId: userId || null, tenantId, details: { reason } });
    publishEvent("ReceiptCancelled", { tenantId, receiptId: receipt._id.toString(), reason, performedBy: userId || null });

    return receipt.toJSON();
  }

  /**
   * POST /api/v1/receipts/{receiptId}/redeliver — gap-fill: "Delivery
   * Channels... Supports delivery retry," with no endpoint to trigger one.
   * Every attempt (original + retries) is appended to deliveryHistory, never
   * overwritten.
   */
  static async redeliver(receiptId, data, tenantId, userId) {
    const { deliveryMethods } = data;
    if (!Array.isArray(deliveryMethods) || deliveryMethods.length === 0) throw new Error("deliveryMethods is required.");

    const receipt = await ReceiptModel.findOne({ _id: receiptId, tenantId });
    if (!receipt) throw new Error("Receipt not found.");
    if (TERMINAL_STATUSES.has(receipt.status)) {
      throw new Error(`Cannot redeliver a receipt in status "${receipt.status}".`);
    }

    const partyDoc = await ReceiptService._loadParty(receipt.partyType, receipt.partyId, tenantId);
    const newAttempts = await ReceiptService._attemptDeliveries({
      deliveryMethods, partyDoc,
      subject: `Receipt ${receipt.receiptNumber}`,
      body: `Your receipt ${receipt.receiptNumber} for ${receipt.amount} ${receipt.currency}. Verify it at ${receipt.qrCode.verificationUrl}`,
      attachment: null,
      receiptNumber: receipt.receiptNumber, verificationUrl: receipt.qrCode.verificationUrl, webhookUrl: data?.webhookUrl
    });

    receipt.deliveryHistory.push(...newAttempts);
    const nextStatus = resolveStatusAfterDelivery(receipt.deliveryHistory);
    if (nextStatus === "Delivered" || receipt.status === "Generated") receipt.status = nextStatus;
    receipt.timeline.push({ event: "ReceiptRedelivered", description: `Retried delivery via ${deliveryMethods.join(", ")}.`, performedBy: userId || null });
    await receipt.save();

    await AuditLogModel.create({ action: "finance.receipt.redeliver", module: "Finance", resource: "Receipt", resourceId: receipt._id.toString(), userId: userId || null, tenantId, details: { deliveryMethods } });
    if (newAttempts.some((a) => a.status === "Sent")) {
      publishEvent("ReceiptDelivered", { tenantId, receiptId: receipt._id.toString(), receiptNumber: receipt.receiptNumber, performedBy: userId || null });
    }

    return receipt.toJSON();
  }

  /**
   * Public — resolved by the unguessable QR token, not tenantId (the
   * caller is anonymous). See docs/05-api/07-finance-api.md Part 8 for why
   * this is deliberately public and why the response stays minimal.
   */
  static async verifyByToken(token) {
    const receipt = await ReceiptModel.findOne({ "qrCode.token": token });
    if (!receipt) return { valid: false };

    receipt.viewCount += 1;
    receipt.lastViewedAt = new Date();
    if (!receipt.firstViewedAt) receipt.firstViewedAt = receipt.lastViewedAt;
    if (receipt.status !== "Archived" && !TERMINAL_STATUSES.has(receipt.status)) receipt.status = "Viewed";
    await receipt.save();

    publishEvent("ReceiptViewed", { tenantId: receipt.tenantId, receiptId: receipt._id.toString(), receiptNumber: receipt.receiptNumber });

    return {
      valid: !receipt.cancelledAt,
      receiptNumber: receipt.receiptNumber,
      amount: receipt.amount,
      currency: receipt.currency,
      issueDate: receipt.issueDate,
      status: receipt.status,
      paymentVerified: true
    };
  }

  /** Public — same token-gated access as verifyByToken. Returns the stored PDF URL for the controller to redirect to. */
  static async getPdfUrlByToken(token) {
    const receipt = await ReceiptModel.findOne({ "qrCode.token": token });
    if (!receipt) throw new Error("Receipt not found.");

    receipt.downloadCount += 1;
    await receipt.save();

    publishEvent("ReceiptDownloaded", { tenantId: receipt.tenantId, receiptId: receipt._id.toString(), receiptNumber: receipt.receiptNumber });

    return receipt.pdf.url;
  }
}

export default ReceiptService;
