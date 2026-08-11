import CustomerCollectionModel from "../models/CustomerCollectionModel.js";
import CollectionReminderModel from "../models/CollectionReminderModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import CustomerModel from "../models/CustomerModel.js";
import AccountsReceivableService from "./AccountsReceivableService.js";
import PaymentService from "./PaymentService.js";
import CustomerCreditService from "./CustomerCreditService.js";
import ReceiptQrService from "./ReceiptQrService.js";
import { resolveContactForMethod } from "./ReceiptService.js";
import { getDeliveryAdapter } from "./delivery/index.js";
import AIModelRouterService from "./ai/AIModelRouterService.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { subscribeEvent, publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/customerCollectionService.test.js).
// ---------------------------------------------------------------------------

export const isCollectionCancellable = (status) => ["Requested", "Partially Collected", "Overdue"].includes(status);
export const isCollectionDisputable = (status) => ["Requested", "Partially Collected", "Overdue"].includes(status);
export const isCollectionWriteOffable = (status) => !["Collected", "Written Off", "Cancelled", "Closed"].includes(status);
export const isCollectionClosable = (status) => ["Collected", "Written Off"].includes(status);

/** "Partial Payments" — a collection that has taken in the full amount is Collected; anything less that has taken in at least something is Partially Collected. */
export const resolveCollectionStatusAfterPayment = (collectedAmount, totalAmount) => (roundCurrency(collectedAmount) >= roundCurrency(totalAmount) ? "Collected" : "Partially Collected");

/** "Installment Plans... Weekly, Monthly, Quarterly, Custom Schedule." Rolls a due date forward by one period of `frequency`. */
export const addIntervalToDate = (date, frequency) => {
  const d = new Date(date);
  if (frequency === "Weekly") { d.setUTCDate(d.getUTCDate() + 7); return d; }
  if (frequency === "Quarterly") { d.setUTCMonth(d.getUTCMonth() + 3); return d; }
  d.setUTCMonth(d.getUTCMonth() + 1); // Monthly is the default cadence for any non-Weekly/Quarterly/Custom value.
  return d;
};

/**
 * Splits `totalAmount` into `installmentCount` real, roundable lines — the
 * remainder from integer-cent division lands entirely on the LAST
 * installment (same "remainder on the last line" discipline used
 * everywhere else money gets split in this codebase) so the sum of parts
 * always exactly equals the whole. "Custom Schedule" bypasses the even
 * split entirely — the caller supplies its own {dueDate, amount} lines,
 * validated to sum to totalAmount here rather than trusted blindly.
 */
export const computeInstallmentSchedule = ({ totalAmount, installmentCount, startDate, frequency, customSchedule }) => {
  if (frequency === "Custom") {
    if (!Array.isArray(customSchedule) || customSchedule.length === 0) {
      throw new Error("customSchedule is required (and must be non-empty) when frequency is Custom.");
    }
    const sum = roundCurrency(customSchedule.reduce((acc, line) => acc + Number(line.amount || 0), 0));
    if (sum !== roundCurrency(totalAmount)) {
      throw new Error(`customSchedule amounts must sum to exactly ${roundCurrency(totalAmount)} (got ${sum}).`);
    }
    return customSchedule.map((line, index) => ({
      installmentNumber: index + 1,
      dueDate: new Date(line.dueDate),
      amount: roundCurrency(line.amount),
      paidAmount: 0,
      status: "Pending",
      paymentId: null,
      paidAt: null
    }));
  }

  const count = Math.max(parseInt(installmentCount, 10) || 0, 1);
  const base = roundCurrency(totalAmount / count);
  const schedule = [];
  let dueDate = new Date(startDate);
  let runningTotal = 0;
  for (let i = 1; i <= count; i += 1) {
    const isLast = i === count;
    const amount = isLast ? roundCurrency(totalAmount - runningTotal) : base;
    runningTotal = roundCurrency(runningTotal + amount);
    schedule.push({ installmentNumber: i, dueDate: new Date(dueDate), amount, paidAmount: 0, status: "Pending", paymentId: null, paidAt: null });
    dueDate = addIntervalToDate(dueDate, frequency);
  }
  return schedule;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class CustomerCollectionService {
  /**
   * Consumes `NotificationRequested` — published by
   * services/receivableOverdueScheduler.js (Part 5) for every AR
   * collection-stage escalation since that scheduler shipped, with zero
   * listener anywhere ever consuming it (confirmed by grep across the
   * whole codebase before writing this). Real delivery now happens
   * through the already-real services/delivery/ adapters (Part 8), and
   * every attempt — Sent, Failed, or NotConfigured — is durably recorded
   * in CollectionReminderModel. No change to receivableOverdueScheduler.js
   * was needed or made.
   */
  static _eventListenersInitialized = false;
  static initEventListeners() {
    if (CustomerCollectionService._eventListenersInitialized) return;
    CustomerCollectionService._eventListenersInitialized = true;

    subscribeEvent("NotificationRequested", async (payload) => {
      if (payload?.event !== "ReceivableCollectionEscalated") return; // NotificationRequested is published from 21+ places for unrelated purposes — only handle AR's own dunning escalation here.
      if (!payload?.tenantId || !payload?.customerId) return;
      try {
        const config = getFinanceConfig();
        const customer = await CustomerModel.findOne({ _id: payload.customerId, tenantId: payload.tenantId }).lean();
        if (!customer) return;

        // "Phone Call"/"Management Escalation" (the two highest AR
        // collection stages) have no real adapter anywhere in this
        // codebase — falling back to Email keeps the dunning notice
        // genuinely delivered rather than silently dropped, and the
        // original requested channel is preserved on the log entry.
        const channel = ["Phone Call", "Management Escalation"].includes(payload.channel) ? "Email" : (payload.channel || "Email");
        const adapter = getDeliveryAdapter(channel);
        const to = resolveContactForMethod(channel, customer);

        let result;
        if (!adapter) result = { status: "NotConfigured", providerResponse: null, failureReason: `No delivery adapter is implemented for "${channel}" yet.` };
        else if (!to) result = { status: "Failed", providerResponse: null, failureReason: `No contact information available for ${channel} delivery.` };
        else {
          result = await adapter.send({
            to,
            subject: `Payment Reminder — ${payload.collectionStage || "Overdue"} (${payload.daysOverdue || 0} days overdue)`,
            body: `Your account has an overdue balance requiring attention. Collection stage: ${payload.collectionStage || "Reminder"}.`,
            receiptNumber: null,
            verificationUrl: null
          });
        }

        await CollectionReminderModel.create({
          tenantId: payload.tenantId, collectionId: null, receivableId: payload.referenceId || null, customerId: payload.customerId,
          channel, recipientAddress: to || null, status: result.status, providerResponse: result.providerResponse, failureReason: result.failureReason,
          triggeredBy: "Escalation", collectionStage: payload.collectionStage || null
        });

        if (result.status === "Sent") {
          publishEvent("ReminderSent", { tenantId: payload.tenantId, customerId: payload.customerId, receivableId: payload.referenceId || null, channel, collectionStage: payload.collectionStage || null, performedBy: "system" });
        }

        // "Late Fee" (Dunning Process) — 0 = disabled by default. Applies
        // at most once per collection (idempotent via lateFee.applied) the
        // first time the configured stage is reached; tracked on the
        // collection itself only (no ledger posting — no late-fee income
        // account was named anywhere in this Part's spec, same "deferred,
        // honestly documented" treatment as Vendor Payment's own excluded
        // Holiday Rules).
        if (config.lateFeePercent > 0 && payload.collectionStage === config.lateFeeStage && payload.referenceId) {
          const collection = await CustomerCollectionModel.findOne({
            tenantId: payload.tenantId, "lineItems.receivableId": payload.referenceId, "lateFee.applied": false,
            status: { $nin: ["Collected", "Written Off", "Cancelled", "Closed"] }
          });
          if (collection) {
            const feeAmount = roundCurrency((collection.totalAmount - collection.collectedAmount) * (config.lateFeePercent / 100));
            if (feeAmount > 0) {
              collection.totalAmount = roundCurrency(collection.totalAmount + feeAmount);
              collection.lateFee = { applied: true, amount: feeAmount, appliedAt: new Date() };
              collection.timeline.push({ event: "LateFeeApplied", description: `Late fee of ${feeAmount} ${collection.currency} applied at stage "${payload.collectionStage}".`, performedBy: "system" });
              await collection.save();
              await AuditLogModel.create({ action: "finance.customercollection.late_fee", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: null, tenantId: payload.tenantId, details: { feeAmount, stage: payload.collectionStage } });
            }
          }
        }
      } catch (error) {
        console.error("CustomerCollectionService.NotificationRequested handler failed:", error.message);
      }
    });
  }

  static async _generateCode(tenantId, scope, prefix) {
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, scope, year);
    return `${prefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  // ---- Collection Requests ----

  /**
   * POST /api/v1/customer-payments
   * Validate Customer -> Validate Outstanding Invoices -> Create Collection
   * Request -> Generate Payment Link (Optional) -> Publish
   * CustomerPaymentRequested. "Schedule Reminder" is real too, but not an
   * immediate side effect here — services/customerCollectionScheduler.js
   * and the NotificationRequested listener above are what actually send
   * one, once it's genuinely due.
   */
  static async createCollectionRequest(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { customerId, invoiceIds, paymentDueDate, preferredMethod = null, generatePaymentLink: wantsLink = false } = data;

    if (!customerId || !Array.isArray(invoiceIds) || invoiceIds.length === 0 || !paymentDueDate) {
      throw new Error("customerId, invoiceIds, and paymentDueDate are required.");
    }

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");
    const customerName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.companyName || "Customer";

    const receivables = await AccountsReceivableModel.find({ _id: { $in: invoiceIds }, tenantId, customerId }).lean();
    if (receivables.length !== invoiceIds.length) throw new Error("One or more invoices were not found for this customer.");

    const BLOCKED_STATUSES = new Set(["Paid", "Settled", "Written Off", "Cancelled"]);
    const currencies = new Set(receivables.map((r) => r.currency));
    if (currencies.size > 1) throw new Error("All invoices in one collection request must share the same currency.");

    const lineItems = receivables.map((r) => {
      if (BLOCKED_STATUSES.has(r.status)) throw new Error(`Receivable ${r.invoiceNumber} is not eligible for collection (status: "${r.status}").`);
      if (r.outstandingBalance <= 0) throw new Error(`Receivable ${r.invoiceNumber} has no outstanding balance.`);
      return { receivableId: r._id, invoiceNumber: r.invoiceNumber, amount: r.outstandingBalance, collectedAmount: 0 };
    });

    const totalAmount = roundCurrency(lineItems.reduce((sum, l) => sum + l.amount, 0));
    const collectionNumber = await CustomerCollectionService._generateCode(tenantId, "customerCollectionNumber", config.customerCollectionNumberPrefix);

    const collection = new CustomerCollectionModel({
      tenantId, collectionNumber, customerId, customerName, lineItems, totalAmount, currency: receivables[0].currency,
      paymentDueDate: new Date(paymentDueDate), preferredMethod, status: config.defaultCustomerCollectionStatus,
      requestedBy: userId || null, requestedAt: new Date(),
      timeline: [{ event: "CustomerPaymentRequested", description: `Requested ${totalAmount} ${receivables[0].currency} from ${customerName} across ${lineItems.length} invoice(s).`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.request", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { collectionNumber, totalAmount, invoiceCount: lineItems.length } });
    publishEvent("CustomerPaymentRequested", { tenantId, collectionId: collection._id.toString(), customerId: customerId.toString(), totalAmount, currency: collection.currency, performedBy: userId || null });

    if (wantsLink) return CustomerCollectionService.generatePaymentLink(collection._id, tenantId, userId);
    return collection.toJSON();
  }

  static async listCollections(query, tenantId) {
    const config = getFinanceConfig();
    const { customerId, status, currency } = query;
    const filter = { tenantId };
    if (customerId) filter.customerId = customerId;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { paymentDueDate: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      const field = query.sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      CustomerCollectionModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      CustomerCollectionModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getCollectionById(collectionId, tenantId) {
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId }).lean();
    if (!collection) throw new Error("Customer collection not found.");

    const [reminders, auditSummary] = await Promise.all([
      CollectionReminderModel.find({ tenantId, collectionId: collection._id }).sort({ sentAt: -1 }).limit(20).lean(),
      AuditLogModel.find({ tenantId, resource: "CustomerCollection", resourceId: collection._id.toString() }).sort({ createdAt: -1 }).limit(20).lean()
    ]);

    return { ...collection, reminders, auditSummary };
  }

  /**
   * POST /api/v1/customer-payments/{collectionId}/collect
   * Validate Collection -> Generate Payment Request -> Call Payment Engine
   * -> Receive Payment Result -> Update AR -> Audit -> Publish
   * CustomerPaymentCollected. Never moves money itself — delegates
   * entirely to the already-real `PaymentService.createPayment` (Part 7)
   * and `AccountsReceivableService.allocatePayment` (Part 5), the exact
   * "Payment Engine executes, Collection Platform orchestrates" mirror of
   * Part 17's own executeVendorPayment on the AP side. Receipt generation
   * is already automatic too — Part 8's own ReceiptService is designed to
   * be called against any Captured/Allocated payment; no new receipt code
   * was needed here.
   */
  static async collectPayment(collectionId, data, tenantId, userId) {
    const { amount = null, paymentMethod = null, installmentNumber = null } = data;

    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (["Collected", "Written Off", "Cancelled", "Closed"].includes(collection.status)) {
      throw new Error(`Cannot collect payment for a collection in status "${collection.status}".`);
    }

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    const maxCollectible = roundCurrency(collection.lineItems.reduce((sum, l) => sum + (l.amount - l.collectedAmount), 0));
    if (maxCollectible <= 0) throw new Error("This collection has no remaining balance to collect.");

    const requestedAmount = amount !== null && amount !== undefined ? roundCurrency(amount) : maxCollectible;
    if (requestedAmount <= 0) throw new Error("amount must be greater than zero.");
    if (requestedAmount > maxCollectible) throw new Error(`Requested amount ${requestedAmount} exceeds the collection's remaining balance (${maxCollectible}).`);

    const method = paymentMethod || collection.preferredMethod;
    if (!method) throw new Error("paymentMethod is required (no preferredMethod is set on this collection).");

    const payment = await PaymentService.createPayment({
      paymentType: "Customer", partyType: "customer", partyId: collection.customerId, amount: requestedAmount,
      currency: collection.currency, paymentMethod: method, reference: collection.collectionNumber
    }, tenantId, userId);

    if (payment.status === "Failed") {
      collection.status = "Payment Failed";
      collection.updatedBy = userId || null;
      collection.timeline.push({ event: "CustomerPaymentFailed", description: payment.failureReason || "Gateway payment failed.", performedBy: userId || null });
      await collection.save();
      await AuditLogModel.create({ action: "finance.customercollection.collect", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { failed: true, reason: payment.failureReason || null } });
      return collection.toJSON();
    }

    // Apply the collected amount across outstanding line items FIFO — the
    // real "Partial Payments" split. Each portion allocates through the
    // real AR Payment Engine handoff (AccountsReceivableService.allocatePayment),
    // never adjusting a receivable's balance directly.
    let remaining = requestedAmount;
    const allocationWarnings = [];
    for (const line of collection.lineItems) {
      if (remaining <= 0) break;
      const lineRemaining = roundCurrency(line.amount - line.collectedAmount);
      if (lineRemaining <= 0) continue;
      const take = roundCurrency(Math.min(lineRemaining, remaining));
      try {
        await AccountsReceivableService.allocatePayment(line.receivableId, { paymentId: payment._id, amount: take }, tenantId, userId);
        line.collectedAmount = roundCurrency(line.collectedAmount + take);
        remaining = roundCurrency(remaining - take);
      } catch (error) {
        allocationWarnings.push({ receivableId: line.receivableId, error: error.message });
      }
    }

    const appliedTotal = roundCurrency(requestedAmount - remaining);
    collection.collectedAmount = roundCurrency(collection.collectedAmount + appliedTotal);
    collection.payments.push({ paymentId: payment._id, amount: appliedTotal, collectedAt: new Date(), installmentNumber });
    collection.status = resolveCollectionStatusAfterPayment(collection.collectedAmount, collection.totalAmount);
    if (collection.status === "Collected") collection.collectedAt = new Date();
    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "CustomerPaymentCollected", description: `Collected ${appliedTotal} ${collection.currency}${allocationWarnings.length ? ` (${allocationWarnings.length} allocation warning(s))` : ""}.`, performedBy: userId || null });

    let installmentPaidEvent = null;
    if (installmentNumber !== null) {
      const installment = collection.installments.find((i) => i.installmentNumber === installmentNumber);
      if (installment) {
        installment.paidAmount = roundCurrency(installment.paidAmount + appliedTotal);
        installment.paymentId = payment._id;
        if (installment.paidAmount >= installment.amount) {
          installment.status = "Paid";
          installment.paidAt = new Date();
          installmentPaidEvent = installment.installmentNumber;
        }
      }
    }

    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.collect", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { paymentId: payment._id.toString(), appliedTotal, allocationWarningCount: allocationWarnings.length } });
    publishEvent("CustomerPaymentCollected", { tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), paymentId: payment._id.toString(), amount: appliedTotal, currency: collection.currency, status: collection.status, performedBy: userId || null });
    if (installmentPaidEvent !== null) {
      publishEvent("InstallmentPaid", { tenantId, collectionId: collection._id.toString(), installmentNumber: installmentPaidEvent, amount: appliedTotal, performedBy: userId || null });
    }

    return collection.toJSON();
  }

  // ---- Installment Plans ----

  /**
   * POST /api/v1/customer-payments/{collectionId}/installments — "Weekly,
   * Monthly, Quarterly, Custom Schedule. Automatic reminder generation."
   * Schedules against the collection's own remaining balance (not
   * necessarily its full original total), so an installment plan can be
   * created after a partial payment already landed.
   */
  static async createInstallmentPlan(collectionId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { installmentCount, frequency, startDate, customSchedule } = data;
    if (!config.installmentFrequencies.includes(frequency)) throw new Error(`Invalid frequency "${frequency}".`);

    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (["Collected", "Written Off", "Cancelled", "Closed"].includes(collection.status)) {
      throw new Error(`Cannot create an installment plan for a collection in status "${collection.status}".`);
    }
    if (collection.isInstallmentPlan) throw new Error("This collection already has an installment plan.");

    const remainingBalance = roundCurrency(collection.totalAmount - collection.collectedAmount);
    if (remainingBalance <= 0) throw new Error("This collection has no remaining balance to schedule.");
    if (frequency !== "Custom" && (!installmentCount || installmentCount < 1)) throw new Error("installmentCount is required and must be at least 1.");
    if (frequency !== "Custom" && !startDate) throw new Error("startDate is required.");

    const schedule = computeInstallmentSchedule({ totalAmount: remainingBalance, installmentCount, startDate, frequency, customSchedule });

    collection.isInstallmentPlan = true;
    collection.installmentFrequency = frequency;
    collection.installments = schedule;
    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "InstallmentCreated", description: `Installment plan created: ${schedule.length} ${frequency} installment(s) totaling ${remainingBalance} ${collection.currency}.`, performedBy: userId || null });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.create_installment_plan", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { frequency, count: schedule.length, remainingBalance } });
    publishEvent("InstallmentCreated", { tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), frequency, count: schedule.length, totalAmount: remainingBalance, performedBy: userId || null });

    return collection.toJSON();
  }

  // ---- Payment Links ----

  /**
   * POST /api/v1/customer-payments/{collectionId}/payment-link — "One-Time
   * Link, Expiring Link, QR Payment... Gateway independent." Reuses
   * ReceiptQrService's own real token (crypto.randomBytes) and QR (qrcode
   * package) generation directly (Part 8) rather than a parallel
   * implementation. The public route this token resolves against
   * (getCollectionByToken) is deliberately GET-only — see that method's
   * own doc comment for why no unauthenticated pay-via-token POST exists.
   */
  static async generatePaymentLink(collectionId, tenantId, userId) {
    const config = getFinanceConfig();
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (["Written Off", "Cancelled", "Closed"].includes(collection.status)) {
      throw new Error(`Cannot generate a payment link for a collection in status "${collection.status}".`);
    }

    const token = ReceiptQrService.generateVerificationToken();
    const url = `${config.receiptVerificationBaseUrl.replace(/\/$/, "")}/api/v1/customer-payments/pay/${token}`;
    const qrPngBuffer = await ReceiptQrService.generateQrPngBuffer(url);
    const stored = await storeDocumentPdf({ tenantId, folder: "payment-links", filename: `${collection.collectionNumber}-qr.png`, buffer: qrPngBuffer });
    const expiresAt = new Date(Date.now() + config.paymentLinkExpiryHours * 60 * 60 * 1000);

    collection.paymentLink = { token, url, qrCodeUrl: stored.url, generatedAt: new Date(), expiresAt, viewCount: 0 };
    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "PaymentLinkGenerated", description: `Payment link generated, expires ${expiresAt.toISOString()}.`, performedBy: userId || null });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.generate_link", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { expiresAt } });
    publishEvent("PaymentLinkGenerated", { tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), expiresAt, performedBy: userId || null });

    return collection.toJSON();
  }

  /**
   * Public — resolved by the unguessable payment-link token, mirroring
   * Part 8's ReceiptService.verifyByToken exactly: minimal, safe fields
   * only, no tenantId/internal ids leaked. Deliberately GET-only — this
   * codebase has no real customer-facing authentication/hosted-checkout
   * surface, so an unauthenticated POST-pay-via-token endpoint would be a
   * genuine "anyone with the link can move money" hole. Actually
   * collecting payment always goes through the authenticated
   * POST .../collect endpoint (staff-initiated or a real gateway
   * webhook, once one exists) — same "real vs. honestly deferred"
   * boundary as every other Part's excluded external-integration pieces.
   */
  static async getCollectionByToken(token) {
    const collection = await CustomerCollectionModel.findOne({ "paymentLink.token": token });
    if (!collection) throw new Error("Payment link not found.");
    if (collection.paymentLink.expiresAt && collection.paymentLink.expiresAt < new Date()) throw new Error("Payment link has expired.");

    collection.paymentLink.viewCount += 1;
    await collection.save();

    return {
      collectionNumber: collection.collectionNumber,
      customerName: collection.customerName,
      totalAmount: collection.totalAmount,
      collectedAmount: collection.collectedAmount,
      remainingBalance: roundCurrency(collection.totalAmount - collection.collectedAmount),
      currency: collection.currency,
      status: collection.status,
      paymentDueDate: collection.paymentDueDate,
      isInstallmentPlan: collection.isInstallmentPlan,
      installments: collection.installments.map((i) => ({ installmentNumber: i.installmentNumber, dueDate: i.dueDate, amount: i.amount, paidAmount: i.paidAmount, status: i.status }))
    };
  }

  // ---- Reminders ----

  /** POST /api/v1/customer-payments/{collectionId}/send-reminder — manual trigger, real delivery via the same services/delivery/ adapters the escalation listener uses. */
  static async sendReminder(collectionId, data, tenantId, userId) {
    const { channel } = data;
    const config = getFinanceConfig();
    if (!config.deliveryMethods.includes(channel)) throw new Error(`Invalid channel "${channel}".`);

    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");

    const customer = await CustomerModel.findOne({ _id: collection.customerId, tenantId }).lean();
    const adapter = getDeliveryAdapter(channel);
    const to = resolveContactForMethod(channel, customer);

    let result;
    if (!adapter) result = { status: "NotConfigured", providerResponse: null, failureReason: `No delivery adapter is implemented for "${channel}" yet.` };
    else if (!to) result = { status: "Failed", providerResponse: null, failureReason: `No contact information available for ${channel} delivery.` };
    else {
      const remaining = roundCurrency(collection.totalAmount - collection.collectedAmount);
      const linkLine = collection.paymentLink?.url ? ` Pay online: ${collection.paymentLink.url}` : "";
      result = await adapter.send({
        to, subject: `Payment Reminder — ${collection.collectionNumber}`,
        body: `You have an outstanding balance of ${remaining} ${collection.currency} (invoice collection ${collection.collectionNumber}), due ${collection.paymentDueDate.toISOString().slice(0, 10)}.${linkLine}`,
        receiptNumber: null, verificationUrl: collection.paymentLink?.url || null
      });
    }

    const reminder = await CollectionReminderModel.create({
      tenantId, collectionId: collection._id, customerId: collection.customerId, channel, recipientAddress: to || null,
      status: result.status, providerResponse: result.providerResponse, failureReason: result.failureReason, triggeredBy: "Manual"
    });

    collection.timeline.push({ event: "ReminderSent", description: `Reminder via ${channel}: ${result.status}.`, performedBy: userId || null });
    await collection.save();

    if (result.status === "Sent") {
      publishEvent("ReminderSent", { tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), channel, performedBy: userId || null });
    }

    return reminder.toJSON();
  }

  static async listCollectionReminders(collectionId, tenantId) {
    return CollectionReminderModel.find({ tenantId, collectionId }).sort({ sentAt: -1 }).lean();
  }

  // ---- Lifecycle: Dispute / Write-Off / Cancel / Close ----

  static async disputeCollection(collectionId, data, tenantId, userId) {
    const { reason } = data;
    if (!reason) throw new Error("reason is required.");

    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (!isCollectionDisputable(collection.status)) throw new Error(`Cannot dispute a collection in status "${collection.status}".`);

    collection.status = "Disputed";
    collection.disputeReason = reason;
    collection.disputedBy = userId || null;
    collection.disputedAt = new Date();
    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "CollectionDisputed", description: reason, performedBy: userId || null });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.dispute", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { reason } });

    return collection.toJSON();
  }

  /** Writes off every still-outstanding line item's underlying receivable via the real AR write-off (Part 5), never adjusting a balance directly here. */
  static async writeOffCollection(collectionId, data, tenantId, userId) {
    const { writeOffType = "BadDebt", reason = null } = data;

    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (!isCollectionWriteOffable(collection.status)) throw new Error(`Cannot write off a collection in status "${collection.status}".`);

    const warnings = [];
    for (const line of collection.lineItems) {
      if (roundCurrency(line.amount - line.collectedAmount) <= 0) continue;
      try {
        await AccountsReceivableService.writeOff(line.receivableId, { writeOffType, reason }, tenantId, userId);
      } catch (error) {
        warnings.push({ receivableId: line.receivableId, error: error.message });
      }
    }

    collection.writeOff = { isWrittenOff: true, reason, approvedBy: userId || null, approvedAt: new Date() };
    collection.status = "Written Off";
    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "CollectionWrittenOff", description: reason || `Written off (${writeOffType}).`, performedBy: userId || null });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.writeoff", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { writeOffType, reason, warningCount: warnings.length } });

    return { collection: collection.toJSON(), warnings };
  }

  static async cancelCollection(collectionId, data, tenantId, userId) {
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (!isCollectionCancellable(collection.status)) throw new Error(`Cannot cancel a collection in status "${collection.status}".`);

    collection.status = "Cancelled";
    collection.cancellationReason = data?.reason || null;
    collection.cancelledBy = userId || null;
    collection.cancelledAt = new Date();
    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "CollectionCancelled", description: data?.reason || "Collection cancelled.", performedBy: userId || null });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.cancel", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return collection.toJSON();
  }

  static async closeCollection(collectionId, tenantId, userId) {
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (!isCollectionClosable(collection.status)) throw new Error(`Cannot close a collection in status "${collection.status}".`);

    collection.status = "Closed";
    collection.closedBy = userId || null;
    collection.closedAt = new Date();
    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "CollectionClosed", description: "Collection closed.", performedBy: userId || null });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.close", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("CollectionClosed", { tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), performedBy: userId || null });

    return collection.toJSON();
  }

  // ---- Advance Customer Deposits ----

  /**
   * POST /api/v1/customer-payments/deposits — "Advance Customer
   * Deposits... Booking Deposit, Visa Deposit, Project Deposit,
   * Subscription Deposit — automatically allocated to future invoices."
   * Reuses `CustomerCreditService.createCredit` directly (Part 10) — the
   * exact same auto-linking `AccountsReceivableService.createReceivable`
   * already consumes via `consumeAvailableCredits`, mirroring Part 17's
   * own `createVendorAdvance`. No dedicated deposit event is named in this
   * Part's Domain Events list (unlike Part 17's own VendorAdvanceCreated),
   * so this reuses `CustomerPaymentCollected` with an `isDeposit` flag
   * rather than inventing a new event name.
   */
  static async createCustomerDeposit(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { customerId, amount, currency, sourceType, paymentMethod = "Bank Transfer" } = data;
    if (!customerId || !amount || !currency || !sourceType) throw new Error("customerId, amount, currency, and sourceType are required.");
    if (!config.customerDepositSourceTypes.includes(sourceType)) throw new Error(`Invalid sourceType "${sourceType}".`);

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    const payment = await PaymentService.createPayment({
      paymentType: "Customer", partyType: "customer", partyId: customerId, amount, currency, paymentMethod, reference: `DEPOSIT-${sourceType}`
    }, tenantId, userId);

    if (payment.status === "Failed") throw new Error(payment.failureReason || "Gateway payment failed while collecting the deposit.");

    const credit = await CustomerCreditService.createCredit({ customerId, amount, currency, source: sourceType, sourceReferenceId: payment._id }, tenantId, userId);

    await AuditLogModel.create({ action: "finance.customercollection.create_deposit", module: "Finance", resource: "CustomerCredit", resourceId: credit._id.toString(), userId: userId || null, tenantId, details: { customerId: customerId.toString(), amount: roundCurrency(amount), sourceType, paymentId: payment._id.toString() } });
    publishEvent("CustomerPaymentCollected", { tenantId, customerId: customerId.toString(), paymentId: payment._id.toString(), creditId: credit._id.toString(), amount: roundCurrency(amount), currency, isDeposit: true, sourceType, performedBy: userId || null });

    return { payment, credit };
  }

  // ---- Overdue Detection (services/customerCollectionScheduler.js) ----

  /**
   * Mirrors receivableOverdueScheduler.js's own markOverdueReceivables —
   * a collection has its own paymentDueDate (which may differ from the
   * underlying invoices' own due dates once negotiated), so it needs its
   * own overdue pass rather than assuming AR's overdue state implies this
   * collection is overdue too.
   */
  static async markOverdueCollections() {
    const now = new Date();
    const overdue = await CustomerCollectionModel.find({ status: { $in: ["Requested", "Partially Collected"] }, paymentDueDate: { $lt: now } });

    for (const collection of overdue) {
      collection.status = "Overdue";
      collection.timeline.push({ event: "CollectionOverdue", description: `Past due date ${collection.paymentDueDate.toISOString().split("T")[0]}.`, performedBy: "system" });
      await collection.save();

      await AuditLogModel.create({ action: "finance.customercollection.overdue", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: null, tenantId: collection.tenantId, details: { paymentDueDate: collection.paymentDueDate } });
      publishEvent("CollectionOverdue", { tenantId: collection.tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), collectionNumber: collection.collectionNumber, outstandingBalance: roundCurrency(collection.totalAmount - collection.collectedAmount) });
    }

    return overdue.length;
  }

  // ---- Collection Analytics ----

  /**
   * GET /api/v1/customer-payments/analytics — "Collection Rate, Average
   * Days to Collect, Overdue Amount, Recovery Rate, Reminder
   * Effectiveness, Cash Flow Forecast." Every metric but the forecast is a
   * real aggregation against CustomerCollectionModel/CollectionReminderModel;
   * the forecast is a real AI advisory call via AIModelRouterService,
   * mirroring Cash Management's Cash Forecasting (Part 15) and Vendor
   * Payment's suggestPaymentTiming (Part 17) exactly.
   */
  static async getCollectionAnalytics(tenantId) {
    const [totals, overdueTotals, everOverdueCount, collectedFromOverdueCount, reminderStats, remindedThenCollected] = await Promise.all([
      CustomerCollectionModel.aggregate([
        { $match: { tenantId } },
        { $group: { _id: null, totalAmount: { $sum: "$totalAmount" }, collectedAmount: { $sum: "$collectedAmount" }, count: { $sum: 1 }, avgDaysToCollect: { $avg: { $cond: [{ $ifNull: ["$collectedAt", false] }, { $divide: [{ $subtract: ["$collectedAt", "$requestedAt"] }, 1000 * 60 * 60 * 24] }, null] } } } }
      ]),
      CustomerCollectionModel.aggregate([
        { $match: { tenantId, status: "Overdue" } },
        { $group: { _id: null, overdueAmount: { $sum: { $subtract: ["$totalAmount", "$collectedAmount"] } } } }
      ]),
      CustomerCollectionModel.countDocuments({ tenantId, timeline: { $elemMatch: { event: "CollectionOverdue" } } }),
      CustomerCollectionModel.countDocuments({ tenantId, status: { $in: ["Collected", "Closed"] }, timeline: { $elemMatch: { event: "CollectionOverdue" } } }),
      CollectionReminderModel.countDocuments({ tenantId, status: "Sent" }),
      CustomerCollectionModel.countDocuments({ tenantId, status: { $in: ["Collected", "Closed"] }, timeline: { $elemMatch: { event: "ReminderSent" } } })
    ]);

    const t = totals[0] || { totalAmount: 0, collectedAmount: 0, count: 0, avgDaysToCollect: null };
    const collectionRate = t.totalAmount > 0 ? roundCurrency((t.collectedAmount / t.totalAmount) * 100) : 0;
    const recoveryRate = everOverdueCount > 0 ? roundCurrency((collectedFromOverdueCount / everOverdueCount) * 100) : 0;
    const reminderEffectiveness = reminderStats > 0 ? roundCurrency((remindedThenCollected / reminderStats) * 100) : 0;

    return {
      collectionRate,
      averageDaysToCollect: t.avgDaysToCollect !== null && t.avgDaysToCollect !== undefined ? Math.round(t.avgDaysToCollect * 10) / 10 : null,
      overdueAmount: roundCurrency(overdueTotals[0]?.overdueAmount || 0),
      recoveryRate,
      reminderEffectiveness,
      totalCollections: t.count,
      totalCollectedAmount: roundCurrency(t.collectedAmount),
      cashFlowForecast: await CustomerCollectionService._forecastCashFlow(tenantId)
    };
  }

  static async _forecastCashFlow(tenantId) {
    const open = await CustomerCollectionModel.find({ tenantId, status: { $in: ["Requested", "Partially Collected", "Overdue"] } })
      .select("collectionNumber totalAmount collectedAmount currency paymentDueDate status").sort({ paymentDueDate: 1 }).limit(100).lean();

    if (open.length === 0) return { aiAvailable: true, forecast: [], message: "No open collections to forecast." };

    const systemPrompt = "You are a cash flow forecasting assistant for an ERP's customer collections. Given a list of open collection requests (due dates, remaining amounts, current status), forecast expected cash inflow by week for the next 4 weeks. Respond with ONLY JSON: {\"forecast\":[{\"weekStarting\":\"YYYY-MM-DD\",\"expectedInflow\":number,\"currency\":\"...\",\"reasoning\":\"...\"}]}. Advisory only.";
    const userPrompt = `Open collections:\n${JSON.stringify(open.map((c) => ({ collectionNumber: c.collectionNumber, remaining: roundCurrency(c.totalAmount - c.collectedAmount), currency: c.currency, dueDate: c.paymentDueDate, status: c.status })))}`;

    try {
      const llmResult = await AIModelRouterService.route({ tenantId, category: "reasoning", messages: [{ role: "user", content: userPrompt }], tools: [], systemPrompt });
      const jsonText = (llmResult.content || "{}").replace(/^```json\s*|\s*```$/g, "").trim();
      const parsed = JSON.parse(jsonText);
      return { aiAvailable: true, forecast: Array.isArray(parsed.forecast) ? parsed.forecast : [], provider: llmResult.provider, model: llmResult.model };
    } catch (error) {
      return { aiAvailable: false, forecast: [], message: error.message };
    }
  }
}

export default CustomerCollectionService;
