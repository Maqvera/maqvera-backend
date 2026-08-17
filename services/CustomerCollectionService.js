import crypto from "crypto";
import CustomerCollectionModel from "../models/CustomerCollectionModel.js";
import CollectionReminderModel from "../models/CollectionReminderModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import PaymentIntentModel from "../models/PaymentIntentModel.js";
import PaymentModel from "../models/PaymentModel.js";
import SubscriptionModel from "../models/SubscriptionModel.js";
import WalletTransactionModel from "../models/WalletTransactionModel.js";
import CustomerCreditModel from "../models/CustomerCreditModel.js";
import CustomerCreditProfileModel from "../models/CustomerCreditProfileModel.js";
import CustomerModel from "../models/CustomerModel.js";
import AccountsReceivableService from "./AccountsReceivableService.js";
import PaymentService, { deriveFraudStatus } from "./PaymentService.js";
import PaymentIntentService, { isIntentConsumable, isIntentExpired } from "./PaymentIntentService.js";
import CustomerCreditService from "./CustomerCreditService.js";
import ReceiptQrService from "./ReceiptQrService.js";
import ReceiptService, { resolveContactForMethod } from "./ReceiptService.js";
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
 *
 * "Balloon Payment" (Part 18 Part 4) — when `balloonAmount` is given, the
 * LAST installment is fixed at exactly that amount (deliberately larger
 * than an even split) and every installment before it evenly splits the
 * remainder (`totalAmount - balloonAmount`), same remainder-on-last-line
 * discipline applied within that leading portion. Not compatible with
 * `frequency: "Custom"` — a caller supplying their own schedule already
 * has full control over the last line's size.
 */
export const computeInstallmentSchedule = ({ totalAmount, installmentCount, startDate, frequency, customSchedule, balloonAmount = 0 }) => {
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
  const roundedBalloon = roundCurrency(balloonAmount);
  if (roundedBalloon > 0 && roundedBalloon >= totalAmount) throw new Error("balloonAmount must be less than the total amount being scheduled.");
  const leadingTotal = roundCurrency(totalAmount - roundedBalloon);
  const leadingCount = roundedBalloon > 0 ? Math.max(count - 1, 1) : count;
  const base = roundCurrency(leadingTotal / leadingCount);

  const schedule = [];
  let dueDate = new Date(startDate);
  let runningTotal = 0;
  for (let i = 1; i <= leadingCount; i += 1) {
    const isLastLeading = i === leadingCount;
    const amount = isLastLeading ? roundCurrency(leadingTotal - runningTotal) : base;
    runningTotal = roundCurrency(runningTotal + amount);
    schedule.push({ installmentNumber: i, dueDate: new Date(dueDate), amount, paidAmount: 0, status: "Pending", paymentId: null, paidAt: null });
    dueDate = addIntervalToDate(dueDate, frequency);
  }
  if (roundedBalloon > 0) {
    schedule.push({ installmentNumber: leadingCount + 1, dueDate: new Date(dueDate), amount: roundedBalloon, paidAmount: 0, status: "Pending", paymentId: null, paidAt: null });
  }
  return schedule;
};

/**
 * "Payment Allocation Engine... Oldest Invoice First, Due Date Priority,
 * Highest Amount First, Manual Allocation." Pure ordering only — the
 * actual per-receivable application still goes entirely through the real,
 * pre-existing `AccountsReceivableService.allocatePayment`. `Manual`
 * returns the array unchanged (the caller's own `invoiceIds` order is
 * already applied by the caller before this runs).
 */
export const sortReceivablesByStrategy = (receivables, strategy) => {
  const sorted = [...(receivables || [])];
  if (strategy === "HighestAmountFirst") return sorted.sort((a, b) => b.outstandingBalance - a.outstandingBalance);
  if (strategy === "Manual") return sorted;
  return sorted.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate)); // OldestDueDate — also the real default.
};

/**
 * "Partial Allocation." Greedily consumes `unallocatedAmount` across the
 * already-ordered `receivables`, one at a time, never exceeding either the
 * payment's own remaining balance or a single receivable's own outstanding
 * balance. Pure — returns the plan only; nothing is applied here.
 */
export const buildAllocationPlan = (unallocatedAmount, receivables) => {
  let remaining = roundCurrency(unallocatedAmount);
  const plan = [];
  for (const receivable of receivables || []) {
    if (remaining <= 0) break;
    const amount = roundCurrency(Math.min(remaining, receivable.outstandingBalance));
    if (amount <= 0) continue;
    plan.push({ receivableId: receivable._id, invoiceNumber: receivable.invoiceNumber, amount });
    remaining = roundCurrency(remaining - amount);
  }
  return { plan, remainingUnallocated: remaining };
};

/**
 * "Customer Credit Risk Scoring." A real, deterministic 0-100 heuristic
 * (higher = riskier) over fields this codebase actually stores — same
 * "documented formula, no fabricated ML" discipline as
 * `ExpenseService.computeFraudRiskScore` (Part 35) and
 * `CollectionCampaignService.computeCollectionPriority` (Part 18 Part 4).
 * "Industry Risk" is dropped — no `industry` field exists on
 * `CustomerModel` (see `financeConfig.js`'s own doc comment).
 */
export const computeCustomerRiskScore = ({ overdueCount, totalCollectionCount, maxDaysOverdue, outstandingBalance, creditLimit, disputeCount, failedPaymentCount, countryRiskTier }, config) => {
  let score = 0;
  const flags = [];

  // Late Payment Frequency (0-30).
  if (totalCollectionCount > 0) {
    const lateRatio = overdueCount / totalCollectionCount;
    if (lateRatio > 0) { score += Math.round(lateRatio * 30); flags.push("LatePaymentHistory"); }
  }
  // Invoice Aging (0-20) — the single worst overdue line on record.
  if (maxDaysOverdue > 90) { score += 20; flags.push("SeverelyAged90Plus"); }
  else if (maxDaysOverdue > 60) { score += 15; flags.push("Aged60Plus"); }
  else if (maxDaysOverdue > 30) { score += 10; flags.push("Aged30Plus"); }
  // Credit Limit Usage (0-20).
  if (creditLimit > 0) {
    const usageRatio = Math.min(1, outstandingBalance / creditLimit);
    if (usageRatio >= 0.9) { score += 20; flags.push("CreditLimitNearlyExhausted"); }
    else if (usageRatio >= 0.7) { score += 12; flags.push("CreditLimitHighUsage"); }
  }
  // Dispute History (0-15).
  if (disputeCount > 0) { score += Math.min(15, disputeCount * 5); flags.push("DisputeHistory"); }
  // Returned/Failed Payments (0-15).
  if (failedPaymentCount > 0) { score += Math.min(15, failedPaymentCount * 5); flags.push("ReturnedPaymentHistory"); }
  // Country Risk (0-10) — only when the tenant has actually configured a tier for this country; unconfigured = neutral.
  const countryWeights = { High: 10, Medium: 5, Low: 0 };
  if (countryRiskTier && countryWeights[countryRiskTier] !== undefined) { score += countryWeights[countryRiskTier]; flags.push(`CountryRisk${countryRiskTier}`); }

  score = Math.min(100, score);
  const bands = config.customerRiskScoreBands;
  const riskCategory = score >= bands.High ? "Critical" : score >= bands.Medium ? "High" : score >= bands.Low ? "Medium" : "Low";
  return { score, riskCategory, flags };
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
        // "DunningStarted" (Part 18 Part 5) — fires once, the first time
        // this customer's own dunning ladder reaches its first configured
        // stage (`config.collectionStages[0]`, "Reminder" by default) —
        // never re-fired on every subsequent stage of the same escalation.
        if (config.collectionStages[0] && payload.collectionStage === config.collectionStages[0].stage) {
          publishEvent("DunningStarted", { tenantId: payload.tenantId, customerId: payload.customerId, receivableId: payload.referenceId || null, collectionStage: payload.collectionStage, performedBy: "system" });
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
   * POST /api/v1/customer-payments — Finance Module Part 18 Part 2 (API
   * Contracts Refactoring). "Unlike the previous version, this endpoint
   * does not immediately collect money. It creates a secure payment
   * transaction [Payment Intent] that can later be completed using any
   * supported payment provider."
   *
   * Validate Customer -> [Validate Outstanding Invoices | Validate
   * Amount/Currency for a non-invoice source] -> Create Payment Intent ->
   * Generate Payment Reference -> Create Collection (Reserve Allocation)
   * -> Generate Payment Link (Optional) -> Publish CustomerPaymentRequested.
   * "Schedule Reminder" is real too, but not an immediate side effect here
   * — services/customerCollectionScheduler.js and the NotificationRequested
   * listener above are what actually send one, once it's genuinely due.
   *
   * Backward compatible: the original `{customerId, invoiceIds,
   * paymentDueDate}` shape is untouched and still produces the exact same
   * AR-backed line items it always has — it is simply now also paired with
   * a Payment Intent. A caller using the new `collectionSource`-driven
   * shape skips AR lookup entirely and trusts the given amount/currency
   * directly, per this Part's own "Customer Payment is NOT Invoice"
   * principle. "Validate Merchant"/"Subscription Active" from the spec are
   * not real checks — see PaymentIntentService.createIntent's own doc
   * comment for why. "Validate Company"/"Validate Branch" are dropped
   * entirely — no such isolation dimension exists in this codebase (see
   * the standing master instructions §3).
   */
  static async createCollectionRequest(data, tenantId, userId, correlationId = null) {
    const config = getFinanceConfig();
    const {
      customerId, invoiceIds = null, paymentDueDate = null, preferredMethod = null, generatePaymentLink: wantsLink = false,
      merchantId = null, storeId = null, subscriptionId = null,
      collectionSource = null, sourceDocumentId = null, currency = null, amount = null,
      paymentMethod = null, paymentProvider = null, paymentDate = null, returnUrl = null, cancelUrl = null, metadata = null
    } = data;

    if (!customerId) throw new Error("customerId is required.");
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");
    const customerName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.companyName || "Customer";

    const isInvoiceRequest = Array.isArray(invoiceIds) && invoiceIds.length > 0 && (!collectionSource || collectionSource === "Sales Invoice");

    let lineItems, totalAmount, resolvedCurrency, resolvedSource, resolvedSourceDocumentId, resolvedDueDate;

    if (isInvoiceRequest) {
      if (!paymentDueDate) throw new Error("paymentDueDate is required.");

      const receivables = await AccountsReceivableModel.find({ _id: { $in: invoiceIds }, tenantId, customerId }).lean();
      if (receivables.length !== invoiceIds.length) throw new Error("One or more invoices were not found for this customer.");

      const BLOCKED_STATUSES = new Set(["Paid", "Settled", "Written Off", "Cancelled"]);
      const currencies = new Set(receivables.map((r) => r.currency));
      if (currencies.size > 1) throw new Error("All invoices in one collection request must share the same currency.");

      lineItems = receivables.map((r) => {
        if (BLOCKED_STATUSES.has(r.status)) throw new Error(`Receivable ${r.invoiceNumber} is not eligible for collection (status: "${r.status}").`);
        if (r.outstandingBalance <= 0) throw new Error(`Receivable ${r.invoiceNumber} has no outstanding balance.`);
        return { receivableId: r._id, invoiceNumber: r.invoiceNumber, amount: r.outstandingBalance, collectedAmount: 0 };
      });

      totalAmount = roundCurrency(lineItems.reduce((sum, l) => sum + l.amount, 0));
      resolvedCurrency = receivables[0].currency;
      resolvedSource = "Sales Invoice";
      resolvedSourceDocumentId = null;
      resolvedDueDate = new Date(paymentDueDate);
    } else {
      // Generic collection source — "Collections can originate from Sales
      // Invoice, Subscription Invoice, Membership Renewal, Marketplace
      // Order, POS Sale, Project Billing, Training Fee, Visa Fee, Rental
      // Invoice, Deposit, Wallet Recharge, Manual Receivable, Custom
      // Source." No Accounts Receivable lookup — the caller's own
      // amount/currency is the source of truth, since no AR record backs
      // these sources.
      const source = collectionSource || config.defaultCollectionSource;
      if (!config.collectionSources.includes(source)) throw new Error(`Invalid collectionSource "${source}".`);
      if (!amount || amount <= 0) throw new Error("amount is required and must be greater than zero.");
      if (!currency) throw new Error("currency is required.");
      // Case-insensitive — see the matching Joi schema's own doc comment
      // (middleware/validateRequest.js customerCollectionSchemas) for why.
      if (!config.supportedCurrencies.some((c) => c.toLowerCase() === String(currency).toLowerCase())) throw new Error(`Currency "${currency}" is not supported.`);

      totalAmount = roundCurrency(amount);
      resolvedCurrency = currency;
      resolvedSource = source;
      resolvedSourceDocumentId = sourceDocumentId;
      resolvedDueDate = paymentDueDate ? new Date(paymentDueDate) : new Date(paymentDate || Date.now());
      lineItems = [{
        receivableId: null,
        invoiceNumber: sourceDocumentId || `${source.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${Date.now()}`,
        amount: totalAmount,
        collectedAmount: 0
      }];
    }

    const method = paymentMethod || preferredMethod || null;

    // "Payment Intent" — the pre-money-movement record this endpoint now
    // creates before the collection/allocation-strategy record itself.
    const intent = await PaymentIntentService.createIntent({
      customerId, merchantId, storeId, subscriptionId,
      collectionSource: resolvedSource, sourceDocumentId: resolvedSourceDocumentId,
      currency: resolvedCurrency, amount: totalAmount,
      paymentMethod: method, paymentProvider, paymentDate,
      returnUrl, cancelUrl, metadata, correlationId
    }, tenantId, userId);

    const collectionNumber = await CustomerCollectionService._generateCode(tenantId, "customerCollectionNumber", config.customerCollectionNumberPrefix);

    const collection = new CustomerCollectionModel({
      tenantId, collectionNumber, customerId, customerName, merchantId, storeId, subscriptionId,
      collectionSource: resolvedSource, sourceDocumentId: resolvedSourceDocumentId, paymentIntentId: intent._id, correlationId,
      lineItems, totalAmount, currency: resolvedCurrency,
      paymentDueDate: resolvedDueDate, preferredMethod: method, status: config.defaultCustomerCollectionStatus,
      requestedBy: userId || null, requestedAt: new Date(),
      timeline: [{ event: "CustomerPaymentRequested", description: `Requested ${totalAmount} ${resolvedCurrency} from ${customerName} (${resolvedSource}, ${lineItems.length} line item(s)).`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });
    await collection.save();
    await PaymentIntentService.linkCollection(intent._id, collection._id, tenantId);

    await AuditLogModel.create({ action: "finance.customercollection.request", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { collectionNumber, totalAmount, lineItemCount: lineItems.length, collectionSource: resolvedSource, paymentIntentId: intent._id.toString() } });
    publishEvent("CustomerPaymentRequested", { tenantId, collectionId: collection._id.toString(), paymentIntentId: intent._id.toString(), customerId: customerId.toString(), merchantId, subscriptionId, collectionSource: resolvedSource, totalAmount, currency: resolvedCurrency, correlationId, performedBy: userId || null });

    const intentJson = intent.toJSON();
    if (wantsLink) {
      const linked = await CustomerCollectionService.generatePaymentLink(collection._id, tenantId, userId);
      return { ...linked, paymentIntentId: intent._id, paymentReference: intent.paymentReference, paymentIntent: intentJson };
    }
    return { ...collection.toJSON(), paymentIntentId: intent._id, paymentReference: intent.paymentReference, paymentIntent: intentJson };
  }

  /**
   * GET /api/v1/customer-payments — Part 18 Part 2. Adds merchantId/
   * subscriptionId/collectionSource/paymentProvider/dateFrom/dateTo
   * filters, friendly sort aliases, and optional cursor pagination
   * alongside the pre-existing offset pagination (opt-in via `cursor` —
   * omitting it keeps exact prior behavior). `tenant`/`company`/`branch`
   * from the spec are never accepted as query filters — tenant identity
   * only ever comes from `getAccessScope(req)` (the verified JWT); letting
   * a query param pick which tenant's data to view would be a real
   * cross-tenant data leak, and Company/Branch have no isolation dimension
   * in this codebase at all (standing master instructions §3).
   */
  static async listCollections(query, tenantId) {
    const config = getFinanceConfig();
    const { customerId, merchantId, subscriptionId, collectionSource, status, currency, paymentMethod, paymentProvider, dateFrom, dateTo } = query;
    const filter = { tenantId };
    if (customerId) filter.customerId = customerId;
    if (merchantId) filter.merchantId = merchantId;
    if (subscriptionId) filter.subscriptionId = subscriptionId;
    if (collectionSource) filter.collectionSource = collectionSource;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;
    if (paymentMethod) filter.preferredMethod = paymentMethod;
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }
    if (paymentProvider) {
      const intentIds = await PaymentIntentModel.find({ tenantId, paymentProvider }).distinct("_id");
      filter.paymentIntentId = { $in: intentIds };
    }

    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);

    // "Sorting... Newest, Oldest, Largest Amount, Smallest Amount, Status,
    // Customer, Merchant, Payment Date, Created Date, Updated Date, Custom
    // Sort." Friendly aliases map onto real fields; any other value is
    // passed straight through as a raw field name (the pre-existing
    // "Custom Sort" behavior, unchanged).
    const SORT_ALIASES = {
      newest: "-createdAt", oldest: "createdAt",
      "largest amount": "-totalAmount", "smallest amount": "totalAmount",
      status: "status", customer: "customerName", merchant: "merchantId",
      "payment date": "-paymentDueDate", "created date": "-createdAt", "updated date": "-updatedAt"
    };
    const rawSort = query.sort ? (SORT_ALIASES[query.sort.toLowerCase()] || query.sort) : "-paymentDueDate";
    const direction = rawSort.startsWith("-") ? -1 : 1;
    const sortField = rawSort.replace(/^-/, "");
    const sortSpec = { [sortField]: direction };

    let items; let pagination;
    if (query.cursor) {
      // Opaque cursor over (sortField, _id) — a genuine second pagination
      // mode, not offset pagination relabeled: no `skip()`, so performance
      // stays flat on deep pages.
      let decoded;
      try {
        decoded = JSON.parse(Buffer.from(query.cursor, "base64").toString("utf8"));
      } catch (error) {
        throw new Error("Invalid cursor.");
      }
      const cmp = direction === -1 ? "$lt" : "$gt";
      Object.assign(filter, {
        $or: [
          { [sortField]: { [cmp]: decoded.lastValue } },
          { [sortField]: decoded.lastValue, _id: { [cmp]: decoded.lastId } }
        ]
      });
      items = await CustomerCollectionModel.find(filter).sort({ ...sortSpec, _id: direction }).limit(pageSize).lean();
      let nextCursor = null;
      if (items.length === pageSize) {
        const last = items[items.length - 1];
        nextCursor = Buffer.from(JSON.stringify({ lastValue: last[sortField], lastId: last._id })).toString("base64");
      }
      pagination = { mode: "cursor", pageSize, nextCursor };
    } else {
      const page = Math.max(parseInt(query.page, 10) || 1, 1);
      const skip = (page - 1) * pageSize;
      let total;
      [items, total] = await Promise.all([
        CustomerCollectionModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
        CustomerCollectionModel.countDocuments(filter)
      ]);
      pagination = { mode: "offset", total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
    }

    const intentIds = items.map((c) => c.paymentIntentId).filter(Boolean);
    const intents = intentIds.length ? await PaymentIntentModel.find({ tenantId, _id: { $in: intentIds } }).lean() : [];
    const intentById = new Map(intents.map((i) => [i._id.toString(), i]));

    const enrichedItems = items.map((c) => {
      const intent = c.paymentIntentId ? intentById.get(c.paymentIntentId.toString()) : null;
      return {
        ...c,
        capturedAmount: roundCurrency(c.collectedAmount),
        allocatedAmount: roundCurrency(c.collectedAmount),
        remainingAmount: roundCurrency(c.totalAmount - c.collectedAmount),
        gateway: intent?.paymentProvider || null,
        gatewayTransactionId: intent?.gatewaySession?.sessionId || null,
        paymentIntentStatus: intent?.status || null
      };
    });

    return { items: enrichedItems, pagination };
  }

  static async getCollectionById(collectionId, tenantId) {
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId }).lean();
    if (!collection) throw new Error("Customer collection not found.");

    const [reminders, auditSummary, paymentIntent] = await Promise.all([
      CollectionReminderModel.find({ tenantId, collectionId: collection._id }).sort({ sentAt: -1 }).limit(20).lean(),
      AuditLogModel.find({ tenantId, resource: "CustomerCollection", resourceId: collection._id.toString() }).sort({ createdAt: -1 }).limit(20).lean(),
      collection.paymentIntentId ? PaymentIntentModel.findOne({ tenantId, _id: collection.paymentIntentId }).lean() : Promise.resolve(null)
    ]);

    return {
      ...collection,
      remainingAmount: roundCurrency(collection.totalAmount - collection.collectedAmount),
      reminders, auditSummary, paymentIntent
    };
  }

  /**
   * POST /api/v1/customer-payments/{collectionId}/collect — Part 18 Part 3
   * (Payment Collection, Allocation & Reconciliation). "This endpoint does
   * not directly update Accounts Receivable. Payment execution,
   * verification, allocation, settlement, and accounting are handled as
   * separate business stages." Validate Payment Intent -> Validate
   * Customer -> Validate Gateway/Payment Method -> [Fraud Detection ->
   * Risk Scoring already run inside PaymentService.createPayment] ->
   * Authorize -> Capture (mode-permitting) -> Verify -> Trigger Allocation
   * Engine -> Return. Never moves money itself — delegates entirely to
   * the already-real `PaymentService.createPayment`/`capturePayment`
   * (Part 7) and `AccountsReceivableService.allocatePayment` (Part 5),
   * the exact "Payment Engine executes, Collection Platform orchestrates"
   * mirror of Part 17's own executeVendorPayment on the AP side.
   *
   * "Validate Merchant"/"Company Match"/"Branch Match" from the spec are
   * dropped — no Merchant module and no Company/Branch isolation
   * dimension exist in this codebase (standing master instructions §3).
   */
  static async collectPayment(collectionId, data, tenantId, userId, correlationId = null) {
    const config = getFinanceConfig();
    const {
      amount = null, paymentMethod = null, installmentNumber = null,
      paymentProvider = null, captureMode = config.defaultCaptureMode,
      customerIp = null, deviceId = null, riskSessionId = null, savePaymentMethod = false
    } = data;

    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (["Collected", "Written Off", "Cancelled", "Closed"].includes(collection.status)) {
      throw new Error(`Cannot collect payment for a collection in status "${collection.status}".`);
    }
    if (collection.status === "Payment Authorized") {
      throw new Error("This collection has a payment awaiting capture — use POST .../capture instead of collecting again.");
    }
    if (!config.captureModes.includes(captureMode)) throw new Error(`Invalid captureMode "${captureMode}".`);

    // "Validate Payment Intent... Intent Exists, Intent Not Expired,
    // Intent Not Already Paid."
    let intent = null;
    if (collection.paymentIntentId) {
      intent = await PaymentIntentModel.findOne({ _id: collection.paymentIntentId, tenantId });
      if (!intent) throw new Error("Linked payment intent not found.");
      if (isIntentExpired(intent, collection.collectedAmount)) {
        await PaymentIntentService.markExpired(intent._id, tenantId);
        throw new Error("This payment intent has expired.");
      }
      if (!isIntentConsumable(intent.status) && intent.status !== "Captured") {
        throw new Error(`This payment intent cannot be collected against from status "${intent.status}".`);
      }
    }

    // "Validate Customer Active."
    const customer = await CustomerModel.findOne({ _id: collection.customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");
    if (["inactive", "archived"].includes(customer.status)) {
      throw new Error(`Customer is not active (status "${customer.status}").`);
    }

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    const maxCollectible = roundCurrency(collection.lineItems.reduce((sum, l) => sum + (l.amount - l.collectedAmount), 0));
    if (maxCollectible <= 0) throw new Error("This collection has no remaining balance to collect.");

    const requestedAmount = amount !== null && amount !== undefined ? roundCurrency(amount) : maxCollectible;
    if (requestedAmount <= 0) throw new Error("amount must be greater than zero.");
    if (requestedAmount > maxCollectible) throw new Error(`Requested amount ${requestedAmount} exceeds the collection's remaining balance (${maxCollectible}).`);

    const method = paymentMethod || collection.preferredMethod || (intent && intent.paymentMethod) || null;
    if (!method) throw new Error("paymentMethod is required (no preferredMethod is set on this collection).");

    // "Strong Customer Authentication" — no real 3DS/SCA provider exists in
    // this codebase (see PaymentIntentModel's own doc comment); recorded
    // honestly as authentication/fraud-signal context, never faked.
    const authenticationMetadata = (customerIp || deviceId || riskSessionId || savePaymentMethod)
      ? { customerIp, deviceId, riskSessionId, savePaymentMethod: !!savePaymentMethod } : null;

    const payment = await PaymentService.createPayment({
      paymentType: "Customer", partyType: "customer", partyId: collection.customerId, amount: requestedAmount,
      currency: collection.currency, paymentMethod: method, gateway: paymentProvider || undefined,
      reference: collection.collectionNumber, captureMode
    }, tenantId, userId);

    const riskScore = payment.fraudCheck?.riskScore ?? 0;
    const fraudStatus = deriveFraudStatus(riskScore, { reviewThreshold: config.fraudReviewScoreThreshold, flagThreshold: config.fraudFlagScoreThreshold });

    if (payment.status === "Failed") {
      collection.status = "Payment Failed";
      collection.updatedBy = userId || null;
      collection.timeline.push({ event: "CustomerPaymentFailed", description: payment.failureReason || "Gateway payment failed.", performedBy: userId || null });
      await collection.save();
      if (intent) await PaymentIntentService.markFailed(intent._id, tenantId, payment.failureReason);
      await AuditLogModel.create({ action: "finance.customercollection.collect", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { failed: true, reason: payment.failureReason || null, correlationId } });
      return {
        ...collection.toJSON(), paymentId: payment._id, paymentReference: payment.paymentNumber,
        gatewayStatus: payment.status, paymentStatus: payment.status, riskScore, fraudStatus,
        gatewayResponse: payment.gatewayDetails?.rawResponse || null
      };
    }

    if (payment.status === "Authorized") {
      // "Capture Modes... Manual Capture, Authorize Only, Partial Capture,
      // Delayed Capture" — stop here; a real, separate
      // POST .../capture completes it later.
      collection.status = "Payment Authorized";
      collection.authorizedPaymentId = payment._id;
      collection.updatedBy = userId || null;
      collection.timeline.push({ event: "PaymentAuthorized", description: `Authorized ${requestedAmount} ${collection.currency}, awaiting capture (captureMode: "${captureMode}").`, performedBy: userId || null });
      await collection.save();
      if (intent) await PaymentIntentService.markAuthorized(intent._id, payment._id, tenantId, authenticationMetadata);

      await AuditLogModel.create({ action: "finance.customercollection.authorize", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { paymentId: payment._id.toString(), requestedAmount, captureMode, correlationId } });
      return {
        ...collection.toJSON(), paymentId: payment._id, paymentReference: payment.paymentNumber,
        gatewayTransactionId: payment.gatewayDetails?.transactionId || null, authorizationCode: payment.gatewayDetails?.transactionId || null,
        captureReference: null, gatewayStatus: payment.status, paymentStatus: payment.status, capturedAmount: 0,
        currency: payment.currency, gatewayResponse: payment.gatewayDetails?.rawResponse || null, riskScore, fraudStatus
      };
    }

    // payment.status === "Captured" (Automatic capture mode, the default).
    return CustomerCollectionService._finalizeCapturedPayment(
      collection, payment, { requestedAmount, installmentNumber, riskScore, fraudStatus, intent, correlationId }, tenantId, userId
    );
  }

  /**
   * Shared by `collectPayment` (Automatic capture) and
   * `captureAuthorizedPayment` (Manual/Authorize Only/Delayed/Partial
   * Capture, once actually captured) — "Trigger Allocation Engine ->
   * Generate Receipt -> Publish PaymentAllocated/ReceiptGenerated." One
   * real implementation, not duplicated per capture path.
   */
  static async _finalizeCapturedPayment(collection, payment, { requestedAmount, installmentNumber = null, riskScore = 0, fraudStatus = "Clear", intent = null, correlationId = null }, tenantId, userId) {
    // Apply the collected amount across outstanding line items FIFO — the
    // real "Partial Payments"/"Multi-Invoice Allocation" split. AR-backed
    // lines (Sales Invoice) allocate through the real AR Payment Engine
    // handoff (AccountsReceivableService.allocatePayment), which posts its
    // own ledger journal and publishes its own `PaymentAllocated`; lines
    // with no `receivableId` (every other collectionSource from Part 2 —
    // "Customer Payment is NOT Invoice") have no receivable to allocate
    // against, so this consumes the Payment Engine's own unallocated
    // balance directly and publishes `PaymentAllocated` itself instead.
    publishEvent("PaymentAllocationStarted", { tenantId, collectionId: collection._id.toString(), paymentId: payment._id.toString(), amount: requestedAmount, currency: collection.currency, performedBy: userId || null });

    let remaining = requestedAmount;
    const allocationWarnings = [];
    for (const line of collection.lineItems) {
      if (remaining <= 0) break;
      const lineRemaining = roundCurrency(line.amount - line.collectedAmount);
      if (lineRemaining <= 0) continue;
      const take = roundCurrency(Math.min(lineRemaining, remaining));
      if (line.receivableId) {
        try {
          await AccountsReceivableService.allocatePayment(line.receivableId, { paymentId: payment._id, amount: take }, tenantId, userId);
          line.collectedAmount = roundCurrency(line.collectedAmount + take);
          remaining = roundCurrency(remaining - take);
        } catch (error) {
          allocationWarnings.push({ receivableId: line.receivableId, error: error.message });
        }
      } else {
        try {
          await PaymentService.consumeUnallocatedAmount(payment._id, tenantId, take, { targetType: "CustomerCollection", targetId: collection._id, allocatedBy: userId });
          line.collectedAmount = roundCurrency(line.collectedAmount + take);
          remaining = roundCurrency(remaining - take);
          publishEvent("PaymentAllocated", { tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), paymentId: payment._id.toString(), amount: take, collectionSource: collection.collectionSource, performedBy: userId || null });
        } catch (error) {
          allocationWarnings.push({ receivableId: null, error: error.message });
        }
      }
    }

    const appliedTotal = roundCurrency(requestedAmount - remaining);
    collection.collectedAmount = roundCurrency(collection.collectedAmount + appliedTotal);
    collection.payments.push({ paymentId: payment._id, amount: appliedTotal, collectedAt: new Date(), installmentNumber });
    collection.status = resolveCollectionStatusAfterPayment(collection.collectedAmount, collection.totalAmount);
    if (collection.status === "Collected") collection.collectedAt = new Date();
    collection.authorizedPaymentId = null;
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
    if (intent) await PaymentIntentService.markCaptured(intent._id, payment._id, tenantId);

    // "Receipt Generation... Generate Receipt Number -> Generate Receipt
    // PDF -> Email Customer -> Publish ReceiptGenerated -> Archive
    // Receipt." Real (Part 8's own ReceiptService), non-fatal — a
    // PDF/delivery hiccup must never roll back money that has already
    // genuinely moved and been allocated.
    let receipt = null;
    try {
      receipt = await ReceiptService.createReceipt({ paymentId: payment._id, deliveryMethods: ["Email"] }, tenantId, userId);
    } catch (error) {
      console.error("CustomerCollectionService: receipt generation failed:", error.message);
    }

    await AuditLogModel.create({ action: "finance.customercollection.collect", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { paymentId: payment._id.toString(), appliedTotal, allocationWarningCount: allocationWarnings.length, riskScore, correlationId } });
    publishEvent("CustomerPaymentCollected", { tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), paymentId: payment._id.toString(), amount: appliedTotal, currency: collection.currency, status: collection.status, correlationId, performedBy: userId || null });
    if (installmentPaidEvent !== null) {
      publishEvent("InstallmentPaid", { tenantId, collectionId: collection._id.toString(), installmentNumber: installmentPaidEvent, amount: appliedTotal, performedBy: userId || null });
    }

    return {
      ...collection.toJSON(),
      paymentId: payment._id, paymentReference: payment.paymentNumber,
      gatewayTransactionId: payment.gatewayDetails?.transactionId || null,
      authorizationCode: payment.gatewayDetails?.transactionId || null,
      captureReference: payment.gatewayDetails?.transactionId || null,
      gatewayStatus: payment.status, paymentStatus: payment.status,
      capturedAmount: appliedTotal, currency: payment.currency,
      gatewayResponse: payment.gatewayDetails?.rawResponse || null,
      riskScore, fraudStatus,
      receipt: receipt ? { receiptNumber: receipt.receiptNumber, pdfUrl: receipt.pdf?.url || null, status: receipt.status } : null
    };
  }

  /**
   * POST /api/v1/customer-payments/{collectionId}/capture — Part 18 Part
   * 3. Completes a payment a prior `collect` call left in "Authorized"
   * status under a Manual/Authorize Only/Delayed Capture mode. `amount`
   * optionally captures less than the full authorized amount ("Partial
   * Capture").
   */
  static async captureAuthorizedPayment(collectionId, data, tenantId, userId, correlationId = null) {
    const { amount = null, installmentNumber = null } = data || {};

    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (collection.status !== "Payment Authorized" || !collection.authorizedPaymentId) {
      throw new Error(`This collection has no payment awaiting capture (status "${collection.status}").`);
    }

    const payment = await PaymentService.capturePayment(collection.authorizedPaymentId, { amount }, tenantId, userId);

    const config = getFinanceConfig();
    const riskScore = payment.fraudCheck?.riskScore ?? 0;
    const fraudStatus = deriveFraudStatus(riskScore, { reviewThreshold: config.fraudReviewScoreThreshold, flagThreshold: config.fraudFlagScoreThreshold });

    if (payment.status === "Failed") {
      collection.status = "Payment Failed";
      collection.authorizedPaymentId = null;
      collection.updatedBy = userId || null;
      collection.timeline.push({ event: "CustomerPaymentFailed", description: payment.failureReason || "Gateway capture failed.", performedBy: userId || null });
      await collection.save();
      if (collection.paymentIntentId) await PaymentIntentService.markFailed(collection.paymentIntentId, tenantId, payment.failureReason);
      await AuditLogModel.create({ action: "finance.customercollection.capture", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { failed: true, reason: payment.failureReason || null, correlationId } });
      return { ...collection.toJSON(), paymentId: payment._id, gatewayStatus: payment.status, paymentStatus: payment.status, riskScore, fraudStatus };
    }

    const intent = collection.paymentIntentId ? await PaymentIntentModel.findOne({ _id: collection.paymentIntentId, tenantId }) : null;
    return CustomerCollectionService._finalizeCapturedPayment(
      collection, payment, { requestedAmount: payment.amount, installmentNumber, riskScore, fraudStatus, intent, correlationId }, tenantId, userId
    );
  }

  // ---- Installment Plans ----

  /**
   * POST /api/v1/customer-payments/{collectionId}/installments — "Weekly,
   * Monthly, Quarterly, Custom Schedule. Automatic reminder generation."
   * Schedules against the collection's own remaining balance (not
   * necessarily its full original total), so an installment plan can be
   * created after a partial payment already landed.
   *
   * "Down Payment + Installments" (Part 18 Part 4) — when `downPayment` is
   * given, it is collected immediately through the real
   * `collectPayment` flow (same fraud check/allocation/receipt/ledger
   * posting every other collection uses) BEFORE the schedule is built, so
   * the schedule only ever covers what's genuinely still owed. "Balloon
   * Payment" and "Grace Period" are real, config-backed values — see
   * `computeInstallmentSchedule`'s own doc comment and
   * `markOverdueInstallments` respectively.
   */
  static async createInstallmentPlan(collectionId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { installmentCount, frequency, startDate, customSchedule, downPayment = 0, balloonAmount = 0, gracePeriodDays = null, paymentMethod = null } = data;
    if (!config.installmentFrequencies.includes(frequency)) throw new Error(`Invalid frequency "${frequency}".`);

    let collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (["Collected", "Written Off", "Cancelled", "Closed"].includes(collection.status)) {
      throw new Error(`Cannot create an installment plan for a collection in status "${collection.status}".`);
    }
    if (collection.isInstallmentPlan) throw new Error("This collection already has an installment plan.");

    if (downPayment > 0) {
      const downPaymentResult = await CustomerCollectionService.collectPayment(collectionId, { amount: roundCurrency(downPayment), paymentMethod: paymentMethod || collection.preferredMethod }, tenantId, userId);
      if (downPaymentResult.paymentStatus === "Failed") throw new Error("Down payment collection failed — gateway payment was not authorized.");
      collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    }

    const remainingBalance = roundCurrency(collection.totalAmount - collection.collectedAmount);
    if (remainingBalance <= 0) throw new Error("This collection has no remaining balance to schedule.");
    if (frequency !== "Custom" && (!installmentCount || installmentCount < 1)) throw new Error("installmentCount is required and must be at least 1.");
    if (frequency !== "Custom" && !startDate) throw new Error("startDate is required.");

    const schedule = computeInstallmentSchedule({ totalAmount: remainingBalance, installmentCount, startDate, frequency, customSchedule, balloonAmount });

    collection.isInstallmentPlan = true;
    collection.installmentFrequency = frequency;
    collection.downPaymentAmount = roundCurrency(downPayment);
    collection.balloonAmount = roundCurrency(balloonAmount);
    collection.installmentGracePeriodDays = gracePeriodDays !== null ? parseInt(gracePeriodDays, 10) : config.installmentDefaultGracePeriodDays;
    collection.installments = schedule;
    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "InstallmentCreated", description: `Installment plan created: ${schedule.length} ${frequency} installment(s) totaling ${remainingBalance} ${collection.currency}${downPayment > 0 ? ` (after ${roundCurrency(downPayment)} down payment)` : ""}${balloonAmount > 0 ? ` (balloon ${roundCurrency(balloonAmount)})` : ""}.`, performedBy: userId || null });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.create_installment_plan", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { frequency, count: schedule.length, remainingBalance, downPayment: roundCurrency(downPayment), balloonAmount: roundCurrency(balloonAmount) } });
    publishEvent("InstallmentCreated", { tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), frequency, count: schedule.length, totalAmount: remainingBalance, performedBy: userId || null });

    return collection.toJSON();
  }

  /**
   * POST /api/v1/customer-payments/{collectionId}/installments/{installmentNumber}/reschedule
   * — moves a single not-yet-paid installment's due date. Real, targeted:
   * only that one line moves, every other installment's own due date is
   * untouched.
   */
  static async rescheduleInstallment(collectionId, installmentNumber, data, tenantId, userId) {
    const { newDueDate, reason = null } = data;
    if (!newDueDate) throw new Error("newDueDate is required.");

    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    const installment = collection.installments.find((i) => i.installmentNumber === installmentNumber);
    if (!installment) throw new Error(`Installment ${installmentNumber} not found.`);
    if (["Paid", "Cancelled"].includes(installment.status)) throw new Error(`Cannot reschedule an installment in status "${installment.status}".`);

    const oldDueDate = installment.dueDate;
    installment.dueDate = new Date(newDueDate);
    installment.status = "Rescheduled";
    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "InstallmentRescheduled", description: `Installment ${installmentNumber} moved from ${oldDueDate.toISOString().slice(0, 10)} to ${installment.dueDate.toISOString().slice(0, 10)}${reason ? `: ${reason}` : ""}.`, performedBy: userId || null });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.reschedule_installment", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { installmentNumber, oldDueDate, newDueDate: installment.dueDate, reason } });
    publishEvent("InstallmentRescheduled", { tenantId, collectionId: collection._id.toString(), installmentNumber, newDueDate: installment.dueDate, performedBy: userId || null });

    return collection.toJSON();
  }

  /**
   * POST /api/v1/customer-payments/{collectionId}/installments/cancel —
   * "Installment Cancellation." Cancels every still-outstanding
   * installment line (already-paid ones are untouched, permanent history)
   * — the collection itself keeps whatever remaining balance those
   * cancelled installments represented, still collectible as a lump sum
   * through the ordinary `collect` endpoint.
   */
  static async cancelInstallmentPlan(collectionId, data, tenantId, userId) {
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (!collection.isInstallmentPlan) throw new Error("This collection has no installment plan.");

    let cancelledCount = 0;
    for (const installment of collection.installments) {
      if (!["Paid", "Cancelled"].includes(installment.status)) {
        installment.status = "Cancelled";
        cancelledCount += 1;
      }
    }

    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "InstallmentPlanCancelled", description: `${cancelledCount} outstanding installment(s) cancelled${data?.reason ? `: ${data.reason}` : ""}.`, performedBy: userId || null });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.cancel_installment_plan", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { cancelledCount, reason: data?.reason || null } });
    publishEvent("InstallmentPlanCancelled", { tenantId, collectionId: collection._id.toString(), cancelledCount, performedBy: userId || null });

    return collection.toJSON();
  }

  /**
   * POST /api/v1/customer-payments/{collectionId}/installments/settle-early
   * — "Early Settlement." Collects the entire remaining balance right now
   * in one call, optionally discounted by
   * `installmentEarlySettlementDiscountPercent` (0 by default — a real
   * opt-in business decision, never assumed) — through the exact same
   * real `collectPayment` flow, not a parallel money-movement path.
   */
  static async settleInstallmentPlanEarly(collectionId, tenantId, userId) {
    const config = getFinanceConfig();
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (!collection.isInstallmentPlan) throw new Error("This collection has no installment plan.");

    const remainingBalance = roundCurrency(collection.totalAmount - collection.collectedAmount);
    if (remainingBalance <= 0) throw new Error("This collection has no remaining balance to settle.");

    const discountPercent = config.installmentEarlySettlementDiscountPercent;
    const discountAmount = discountPercent > 0 ? roundCurrency(remainingBalance * (discountPercent / 100)) : 0;
    const settlementAmount = roundCurrency(remainingBalance - discountAmount);

    // The discount is real forgiven revenue, not silently vanished money —
    // shrink every still-outstanding line item's own `amount` (never
    // `collectedAmount`) proportionally so the collection's own totals
    // stay internally consistent once the reduced settlement lands.
    if (discountAmount > 0) {
      let remainingDiscount = discountAmount;
      const outstandingLines = collection.lineItems.filter((l) => roundCurrency(l.amount - l.collectedAmount) > 0);
      outstandingLines.forEach((line, index) => {
        const lineOutstanding = roundCurrency(line.amount - line.collectedAmount);
        const isLast = index === outstandingLines.length - 1;
        const lineDiscount = isLast ? remainingDiscount : roundCurrency(discountAmount * (lineOutstanding / remainingBalance));
        remainingDiscount = roundCurrency(remainingDiscount - lineDiscount);
        line.amount = roundCurrency(line.amount - lineDiscount);
      });
      collection.totalAmount = roundCurrency(collection.totalAmount - discountAmount);
      collection.timeline.push({ event: "EarlySettlementDiscountApplied", description: `${discountAmount} ${collection.currency} (${discountPercent}%) early settlement discount applied.`, performedBy: userId || null });
      await collection.save();
    }

    const result = await CustomerCollectionService.collectPayment(collectionId, { amount: settlementAmount, paymentMethod: collection.preferredMethod }, tenantId, userId);

    await AuditLogModel.create({ action: "finance.customercollection.settle_early", module: "Finance", resource: "CustomerCollection", resourceId: collectionId.toString(), userId: userId || null, tenantId, details: { remainingBalance, discountAmount, settlementAmount } });
    publishEvent("InstallmentPlanSettledEarly", { tenantId, collectionId: collectionId.toString(), discountAmount, settlementAmount, performedBy: userId || null });

    return result;
  }

  /**
   * "Grace Period" — mirrors `markOverdueCollections`'s own real cron
   * pass, but per-installment: an installment only becomes Overdue once
   * `dueDate + installmentGracePeriodDays` has actually passed, not the
   * instant its due date arrives.
   */
  static async markOverdueInstallments() {
    const now = new Date();
    const plans = await CustomerCollectionModel.find({ isInstallmentPlan: true, status: { $nin: ["Collected", "Written Off", "Cancelled", "Closed"] }, "installments.status": "Pending" });

    let overdueCount = 0;
    for (const collection of plans) {
      let changed = false;
      for (const installment of collection.installments) {
        if (installment.status !== "Pending") continue;
        const graceDays = collection.installmentGracePeriodDays || 0;
        const overdueAfter = new Date(new Date(installment.dueDate).getTime() + graceDays * 86400000);
        if (overdueAfter < now) {
          installment.status = "Overdue";
          changed = true;
          overdueCount += 1;
        }
      }
      if (changed) {
        collection.timeline.push({ event: "InstallmentOverdue", description: "One or more installments passed their grace period without payment.", performedBy: "system" });
        await collection.save();
        publishEvent("InstallmentOverdue", { tenantId: collection.tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString() });
      }
    }
    return overdueCount;
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
    publishEvent("PaymentDisputed", { tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), reason, performedBy: userId || null });

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
    publishEvent("PaymentCancelled", { tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), reason: data?.reason || null, performedBy: userId || null });

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
   * Effectiveness, Cash Flow Forecast" (Part 18) plus Part 18 Part 4's own
   * "Gateway Success Rate, Failed Payment Rate, Subscription Renewal
   * Rate, Membership Renewal Rate, Deposit Utilization, Wallet Usage."
   * Every metric but the forecast is a real aggregation against this
   * Part's own real models (PaymentModel, SubscriptionModel,
   * CustomerCreditModel, WalletTransactionModel) — nothing fabricated;
   * the forecast is a real AI advisory call via AIModelRouterService,
   * mirroring Cash Management's Cash Forecasting (Part 15) and Vendor
   * Payment's suggestPaymentTiming (Part 17) exactly. "Collection
   * Efficiency"/"Customer Payment Behaviour" from the spec have no single
   * well-defined real formula distinct from the metrics already above —
   * not guessed at, same discipline as every other Part's own honestly
   * excluded metrics.
   */
  static async getCollectionAnalytics(tenantId) {
    const config = getFinanceConfig();
    const [
      totals, overdueTotals, everOverdueCount, collectedFromOverdueCount, reminderStats, remindedThenCollected,
      paymentAttempts, failedPayments, subscriptionTotals, membershipTotals, depositTotals, walletTotals
    ] = await Promise.all([
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
      CustomerCollectionModel.countDocuments({ tenantId, status: { $in: ["Collected", "Closed"] }, timeline: { $elemMatch: { event: "ReminderSent" } } }),
      PaymentModel.countDocuments({ tenantId, paymentType: "Customer" }),
      PaymentModel.countDocuments({ tenantId, paymentType: "Customer", status: "Failed" }),
      SubscriptionModel.aggregate([
        { $match: { tenantId, planType: "Subscription", status: { $ne: "Trial" } } },
        { $group: { _id: null, total: { $sum: 1 }, renewed: { $sum: { $cond: [{ $in: ["SubscriptionRenewed", "$timeline.event"] }, 1, 0] } } } }
      ]),
      SubscriptionModel.aggregate([
        { $match: { tenantId, planType: "Membership", status: { $ne: "Trial" } } },
        { $group: { _id: null, total: { $sum: 1 }, renewed: { $sum: { $cond: [{ $in: ["SubscriptionRenewed", "$timeline.event"] }, 1, 0] } } } }
      ]),
      CustomerCreditModel.aggregate([
        { $match: { tenantId, source: { $in: config.customerDepositSourceTypes } } },
        { $group: { _id: null, granted: { $sum: "$amount" }, remaining: { $sum: "$remainingAmount" } } }
      ]),
      WalletTransactionModel.aggregate([
        { $match: { tenantId } },
        { $group: { _id: "$type", total: { $sum: "$amount" } } }
      ])
    ]);

    const t = totals[0] || { totalAmount: 0, collectedAmount: 0, count: 0, avgDaysToCollect: null };
    const collectionRate = t.totalAmount > 0 ? roundCurrency((t.collectedAmount / t.totalAmount) * 100) : 0;
    const recoveryRate = everOverdueCount > 0 ? roundCurrency((collectedFromOverdueCount / everOverdueCount) * 100) : 0;
    const reminderEffectiveness = reminderStats > 0 ? roundCurrency((remindedThenCollected / reminderStats) * 100) : 0;

    const failedPaymentRate = paymentAttempts > 0 ? roundCurrency((failedPayments / paymentAttempts) * 100) : 0;
    const gatewaySuccessRate = paymentAttempts > 0 ? roundCurrency(100 - failedPaymentRate) : 0;

    const sub = subscriptionTotals[0] || { total: 0, renewed: 0 };
    const mem = membershipTotals[0] || { total: 0, renewed: 0 };
    const subscriptionRenewalRate = sub.total > 0 ? roundCurrency((sub.renewed / sub.total) * 100) : 0;
    const membershipRenewalRate = mem.total > 0 ? roundCurrency((mem.renewed / mem.total) * 100) : 0;

    const dep = depositTotals[0] || { granted: 0, remaining: 0 };
    const depositUtilization = dep.granted > 0 ? roundCurrency(((dep.granted - dep.remaining) / dep.granted) * 100) : 0;

    const walletByType = Object.fromEntries(walletTotals.map((w) => [w._id, roundCurrency(w.total)]));
    const walletTopUps = walletByType.TopUp || 0;
    const walletSpent = walletByType.Purchase || 0;
    const walletUsageRate = walletTopUps > 0 ? roundCurrency((walletSpent / walletTopUps) * 100) : 0;

    return {
      collectionRate,
      averageDaysToCollect: t.avgDaysToCollect !== null && t.avgDaysToCollect !== undefined ? Math.round(t.avgDaysToCollect * 10) / 10 : null,
      overdueAmount: roundCurrency(overdueTotals[0]?.overdueAmount || 0),
      recoveryRate,
      reminderEffectiveness,
      totalCollections: t.count,
      totalCollectedAmount: roundCurrency(t.collectedAmount),
      gatewaySuccessRate,
      failedPaymentRate,
      subscriptionRenewalRate,
      membershipRenewalRate,
      depositUtilization,
      walletUsage: { totalToppedUp: walletTopUps, totalSpent: walletSpent, usageRate: walletUsageRate },
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

  /**
   * POST /api/v1/customer-payments/{paymentId}/allocate — "Payment
   * Allocation Engine." Orchestration only: resolves WHICH open, same-
   * currency receivables to allocate a captured Payment's own
   * `unallocatedAmount` against (either the caller's explicit `invoiceIds`
   * order, or a real selectable strategy), then applies each line through
   * the existing, real `AccountsReceivableService.allocatePayment` —
   * unchanged, not duplicated, so FX gain/loss, overpayment-to-credit,
   * ledger posting, and the real `PaymentAllocated` event all keep working
   * exactly as they already do for the inline allocation `/collect`
   * performs. "Customer Credit Utilization" is real but is a DIFFERENT,
   * already-existing mechanism (`CustomerCreditService.consumeAvailableCredits`,
   * applied automatically at receivable creation) — not reimplemented as a
   * strategy of this endpoint, which is specifically about allocating a
   * captured payment's own remaining balance.
   */
  static async allocatePaymentAcrossInvoices(paymentId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { allocationStrategy = config.defaultPaymentAllocationStrategy, invoiceIds = null } = data;
    if (!config.paymentAllocationStrategies.includes(allocationStrategy)) throw new Error(`Invalid allocationStrategy "${allocationStrategy}".`);

    const payment = await PaymentService.getPaymentById(paymentId, tenantId);
    if (!(payment.unallocatedAmount > 0)) throw new Error("Payment has no unallocated balance to allocate.");
    if (payment.partyType !== "customer" || !payment.partyId) throw new Error("Payment is not associated with a customer — nothing to allocate against.");

    let receivables;
    if (Array.isArray(invoiceIds) && invoiceIds.length > 0) {
      const found = await AccountsReceivableModel.find({ _id: { $in: invoiceIds }, tenantId, customerId: payment.partyId, currency: payment.currency, outstandingBalance: { $gt: 0 } }).lean();
      const byId = new Map(found.map((r) => [r._id.toString(), r]));
      receivables = invoiceIds.map((id) => byId.get(id.toString())).filter(Boolean); // Manual — caller's own order preserved.
    } else {
      receivables = await AccountsReceivableModel.find({ tenantId, customerId: payment.partyId, currency: payment.currency, outstandingBalance: { $gt: 0 } }).lean();
      receivables = sortReceivablesByStrategy(receivables, allocationStrategy);
    }

    const { plan, remainingUnallocated } = buildAllocationPlan(payment.unallocatedAmount, receivables);
    if (plan.length === 0) throw new Error("No eligible open invoices found to allocate this payment against.");

    const allocations = [];
    for (const line of plan) {
      const { receivable } = await AccountsReceivableService.allocatePayment(line.receivableId, { paymentId, amount: line.amount }, tenantId, userId);
      const lastAllocation = receivable.allocations[receivable.allocations.length - 1];
      allocations.push({
        allocationId: lastAllocation?._id || null, paymentId, invoiceId: line.receivableId, invoiceNumber: line.invoiceNumber,
        allocatedAmount: line.amount, remainingBalance: receivable.outstandingBalance,
        allocationStatus: receivable.status, allocatedAt: lastAllocation?.allocatedAt || new Date()
      });
    }

    await AuditLogModel.create({ action: "finance.customercollection.allocate_payment", module: "Finance", resource: "Payment", resourceId: paymentId.toString(), userId: userId || null, tenantId, details: { allocationStrategy, lineCount: allocations.length, remainingUnallocated } });

    return { paymentId, allocationStrategy, allocations, remainingUnallocated };
  }

  /**
   * "Customer Credit Risk Scoring." Gathers real inputs this codebase
   * actually has — payment/collection history, invoice aging, credit
   * limit usage (`CustomerCreditProfileModel`/`getCreditUsed`), dispute
   * history (currently-Disputed collections — a real, honestly-scoped
   * proxy, not a full historical audit-log scan), failed payments, and
   * country (when a tenant has configured `customerRiskCountryTiers` for
   * it) — then scores via the pure `computeCustomerRiskScore`.
   */
  static async getCustomerRiskScore(customerId, tenantId) {
    const config = getFinanceConfig();
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");

    const [collections, openReceivables, creditProfile, disputeCount, failedPaymentCount, outstandingBalance] = await Promise.all([
      CustomerCollectionModel.find({ tenantId, customerId }).select("status").lean(),
      AccountsReceivableModel.find({ tenantId, customerId, outstandingBalance: { $gt: 0 } }).select("dueDate").lean(),
      CustomerCreditProfileModel.findOne({ tenantId, customerId }).lean(),
      CustomerCollectionModel.countDocuments({ tenantId, customerId, status: "Disputed" }),
      PaymentModel.countDocuments({ tenantId, partyType: "customer", partyId: customerId, status: "Failed" }),
      AccountsReceivableService.getCreditUsed(customerId, tenantId)
    ]);

    const totalCollectionCount = collections.length;
    const overdueCount = collections.filter((c) => c.status === "Overdue").length;
    const now = new Date();
    const maxDaysOverdue = openReceivables.reduce((max, r) => Math.max(max, Math.floor((now - new Date(r.dueDate)) / 86400000)), 0);
    const countryRiskTier = config.customerRiskCountryTiers[customer.address?.country] || null;

    const result = computeCustomerRiskScore({
      overdueCount, totalCollectionCount, maxDaysOverdue, outstandingBalance,
      creditLimit: creditProfile?.creditLimit || 0, disputeCount, failedPaymentCount, countryRiskTier
    }, config);

    // "Recommended Follow-up"/"Suggested Payment Terms" — real, deterministic
    // (not fabricated), derived directly from the same real riskCategory band.
    const followUpByCategory = { Low: "Standard reminder cadence", Medium: "Proactive reminder + phone follow-up", High: "Escalate to collection prioritization + shortened terms", Critical: "Immediate management escalation; consider requiring prepayment" };
    const termsByCategory = { Low: "Standard", Medium: "Standard, monitor closely", High: "Shortened terms / partial prepayment", Critical: "Prepayment or Cash on Delivery" };

    return {
      customerId, customerScore: result.score, riskCategory: result.riskCategory,
      collectionPriority: result.riskCategory === "Critical" || result.riskCategory === "High" ? "High" : "Normal",
      recommendedFollowUp: followUpByCategory[result.riskCategory], suggestedPaymentTerms: termsByCategory[result.riskCategory],
      // "Confidence Score" — real, deterministic (not fabricated): a
      // function of how much actual history exists to score from. A
      // customer with zero collections/receivables on record has a low-
      // confidence "Low" score by construction (nothing to base it on),
      // never presented with the same confidence as one with real history.
      confidenceScore: Math.min(100, totalCollectionCount * 10 + openReceivables.length * 5),
      factors: result.flags, calculatedAt: new Date()
    };
  }

  // ---- File 6 Part 5: Attachments ----

  /**
   * POST /api/v1/customer-payments/{collectionId}/attachments — same real
   * checksum + storeDocumentPdf pattern as ExpenseService.uploadReceipt
   * (Part 44), scoped to a Customer Collection rather than an Expense (no
   * OCR/fraud-scoring here — there's no claimed amount to reconcile a
   * collection attachment against).
   */
  static async uploadAttachment(collectionId, file, tenantId, userId) {
    const config = getFinanceConfig();
    if (!file?.buffer?.length) throw new Error("A file is required.");
    if (file.buffer.length > config.customerCollectionAttachmentMaxFileSizeBytes) {
      throw new Error(`Attachment exceeds the maximum allowed size of ${config.customerCollectionAttachmentMaxFileSizeBytes} bytes.`);
    }

    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");

    const checksum = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const stored = await storeDocumentPdf({ tenantId, folder: "customer-collection-attachments", filename: `${collection.collectionNumber}-${Date.now()}-${(file.originalname || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_")}`, buffer: file.buffer });

    const attachment = {
      filename: file.originalname || "attachment", url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider,
      mimeType: file.mimetype, fileSize: file.buffer.length, checksum, uploadedBy: userId || null, uploadedAt: new Date()
    };
    collection.attachments.push(attachment);
    // Mongoose assigns the real subdocument `_id` on the CAST array
    // element, not the plain object literal — see ExpenseService.
    // uploadReceipt's own doc comment for the verified reasoning.
    const saved = collection.attachments[collection.attachments.length - 1];
    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "AttachmentUploaded", description: `Attachment "${attachment.filename}" uploaded.`, performedBy: userId || null });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.upload_attachment", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { filename: attachment.filename } });
    publishEvent("CollectionAttachmentUploaded", { tenantId, collectionId: collection._id.toString(), attachmentId: saved._id.toString(), filename: attachment.filename, performedBy: userId || null });

    return saved.toJSON ? saved.toJSON() : saved;
  }

  static async listAttachments(collectionId, tenantId) {
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId }).select("attachments").lean();
    if (!collection) throw new Error("Customer collection not found.");
    return collection.attachments || [];
  }

  // ---- Comments ----

  /** POST /api/v1/customer-payments/{collectionId}/comments — free-text staff notes, distinct from the system-observed `timeline`. */
  static async addComment(collectionId, data, tenantId, userId) {
    const text = (data?.text || "").trim();
    if (!text) throw new Error("text is required.");

    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");

    collection.comments.push({ text, createdBy: userId || null, createdAt: new Date() });
    const saved = collection.comments[collection.comments.length - 1];
    collection.updatedBy = userId || null;
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.add_comment", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("CollectionCommentAdded", { tenantId, collectionId: collection._id.toString(), commentId: saved._id.toString(), performedBy: userId || null });

    return saved.toJSON ? saved.toJSON() : saved;
  }

  static async listComments(collectionId, tenantId) {
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId }).select("comments").lean();
    if (!collection) throw new Error("Customer collection not found.");
    return collection.comments || [];
  }

  // ---- Manual Timeline Entry ----

  /**
   * POST /api/v1/customer-payments/{collectionId}/timeline — a manual log
   * line onto the same `timeline` array every lifecycle transition already
   * writes to (e.g. "Called customer, promised payment Friday"). `event`
   * defaults to "Note" — a caller can label the entry but can't spoof a
   * system lifecycle event name for a transition that didn't happen.
   */
  static async addTimelineEntry(collectionId, data, tenantId, userId) {
    const description = (data?.description || "").trim();
    if (!description) throw new Error("description is required.");
    const event = (data?.event || "Note").trim() || "Note";

    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");

    collection.timeline.push({ event, description, performedBy: userId || null });
    collection.updatedBy = userId || null;
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.add_timeline_entry", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { event } });

    return collection.timeline[collection.timeline.length - 1];
  }

  // ---- Payment Link Regeneration ----

  /**
   * POST /api/v1/customer-payments/{collectionId}/payment-link/regenerate
   * — "Payment links are idempotent." A regenerate call within
   * `paymentLinkRegenerateMinIntervalSeconds` of the last one, while the
   * existing link is still valid, returns that same link unchanged rather
   * than minting a new token/QR — a retried click shouldn't invalidate a
   * URL the customer already has open. Otherwise supersedes the old link
   * (publishing the real `PaymentLinkExpired` event for it when it hadn't
   * already expired on its own) and reuses `generatePaymentLink`'s own
   * token/QR logic — no second implementation.
   */
  static async regeneratePaymentLink(collectionId, tenantId, userId) {
    const config = getFinanceConfig();
    const existing = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId }).select("paymentLink customerId totalAmount collectedAmount").lean();
    if (!existing) throw new Error("Customer collection not found.");

    const previous = existing.paymentLink;
    const previousStillValid = !!(previous?.token && (!previous.expiresAt || new Date(previous.expiresAt) > new Date()));
    if (previousStillValid && previous.generatedAt) {
      const secondsSinceLastGenerated = (Date.now() - new Date(previous.generatedAt).getTime()) / 1000;
      if (secondsSinceLastGenerated < config.paymentLinkRegenerateMinIntervalSeconds) {
        return { ...existing, remainingAmount: roundCurrency(existing.totalAmount - existing.collectedAmount) };
      }
    }

    const updated = await CustomerCollectionService.generatePaymentLink(collectionId, tenantId, userId);
    if (previousStillValid) {
      publishEvent("PaymentLinkExpired", { tenantId, collectionId: collectionId.toString(), customerId: existing.customerId.toString(), superseded: true, performedBy: userId || null });
    }
    return updated;
  }

  // ---- Advance Allocation ----

  /**
   * POST /api/v1/customer-payments/{collectionId}/allocate-advance —
   * applies the customer's available `CustomerCreditModel` balance (Part
   * 18 Part 4 continuation) against this collection's own outstanding
   * lineItems, currency-matched. Real balance lookup
   * (`CustomerCreditService.getAvailableCredit`, now currency-scoped) and
   * real FIFO consumption (`consumeAvailableCredits`) — never a synthetic
   * "advance" concept invented on top.
   */
  static async allocateAdvance(collectionId, tenantId, userId) {
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (["Written Off", "Cancelled", "Closed"].includes(collection.status)) {
      throw new Error(`Cannot allocate an advance to a collection in status "${collection.status}".`);
    }

    const outstandingLines = collection.lineItems
      .map((line, index) => ({ _id: index, invoiceNumber: line.invoiceNumber, outstandingBalance: roundCurrency(line.amount - line.collectedAmount) }))
      .filter((line) => line.outstandingBalance > 0);
    if (outstandingLines.length === 0) throw new Error("Collection has no outstanding balance to allocate an advance against.");

    const availableCredit = await CustomerCreditService.getAvailableCredit(collection.customerId, tenantId, collection.currency);
    if (availableCredit <= 0) throw new Error(`Customer has no available credit balance in ${collection.currency} to allocate.`);

    const totalOutstanding = roundCurrency(outstandingLines.reduce((sum, l) => sum + l.outstandingBalance, 0));
    const { plan, remainingUnallocated } = buildAllocationPlan(Math.min(availableCredit, totalOutstanding), outstandingLines);
    const amountToConsume = roundCurrency(Math.min(availableCredit, totalOutstanding) - remainingUnallocated);
    if (amountToConsume <= 0) throw new Error("Nothing to allocate.");

    const { consumedAmount, consumedCreditIds } = await CustomerCreditService.consumeAvailableCredits(collection.customerId, tenantId, collection.currency, amountToConsume);
    if (consumedAmount <= 0) throw new Error(`Customer has no available credit balance in ${collection.currency} to allocate.`);

    for (const line of plan) {
      collection.lineItems[line.receivableId].collectedAmount = roundCurrency(collection.lineItems[line.receivableId].collectedAmount + line.amount);
    }
    collection.collectedAmount = roundCurrency(collection.collectedAmount + consumedAmount);
    collection.status = resolveCollectionStatusAfterPayment(collection.collectedAmount, collection.totalAmount);
    if (collection.status === "Collected") collection.collectedAt = new Date();
    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "AdvanceAllocated", description: `${roundCurrency(consumedAmount)} ${collection.currency} allocated from available customer credit.`, performedBy: userId || null });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.allocate_advance", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { consumedAmount, consumedCreditIds: consumedCreditIds.map((id) => id.toString()) } });
    publishEvent("AdvanceAllocated", { tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), amount: consumedAmount, currency: collection.currency, performedBy: userId || null });

    return collection.toJSON();
  }

  // ---- Reopen ----

  /**
   * POST /api/v1/customer-payments/{collectionId}/reopen — undoes a
   * Closed/Written Off/Cancelled collection back to the status its own
   * real `collectedAmount` implies (`resolveCollectionStatusAfterPayment`)
   * rather than a second, disconnected status field. Clears the
   * `writeOff` flag when reopening from Written Off, but never reverses
   * that write-off's own AR ledger posting — no reversal primitive exists
   * on `AccountsReceivableService.writeOff`, and "Collection history is
   * immutable" (AI Coding Rule): a journal entry already posted stays on
   * the books; reopening only resumes collection activity going forward.
   */
  static async reopenCollection(collectionId, data, tenantId, userId) {
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId });
    if (!collection) throw new Error("Customer collection not found.");
    if (!["Closed", "Written Off", "Cancelled"].includes(collection.status)) {
      throw new Error(`Cannot reopen a collection in status "${collection.status}".`);
    }

    collection.status = collection.collectedAmount > 0
      ? resolveCollectionStatusAfterPayment(collection.collectedAmount, collection.totalAmount)
      : "Requested";
    if (collection.writeOff?.isWrittenOff) collection.writeOff = { isWrittenOff: false, reason: null, approvedBy: null, approvedAt: null };
    collection.cancellationReason = null;
    collection.cancelledBy = null;
    collection.cancelledAt = null;
    collection.closedBy = null;
    collection.closedAt = null;
    collection.reopenedBy = userId || null;
    collection.reopenedAt = new Date();
    collection.reopenReason = data?.reason || null;
    collection.updatedBy = userId || null;
    collection.timeline.push({ event: "CollectionReopened", description: data?.reason || "Collection reopened.", performedBy: userId || null });
    await collection.save();

    await AuditLogModel.create({ action: "finance.customercollection.reopen", module: "Finance", resource: "CustomerCollection", resourceId: collection._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("CollectionReopened", { tenantId, collectionId: collection._id.toString(), customerId: collection.customerId.toString(), newStatus: collection.status, performedBy: userId || null });

    return collection.toJSON();
  }

  // ---- Audit & History ----

  /** GET /api/v1/customer-payments/{collectionId}/audit — paginated AuditLogModel entries scoped to this collection (the same resource/resourceId every mutating method above already logs under). */
  static async getAuditTrail(collectionId, tenantId, query = {}) {
    const config = getFinanceConfig();
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId }).select("_id").lean();
    if (!collection) throw new Error("Customer collection not found.");

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const filter = { tenantId, resource: "CustomerCollection", resourceId: collection._id.toString() };

    const [items, total] = await Promise.all([
      AuditLogModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      AuditLogModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * GET /api/v1/customer-payments/{collectionId}/history — a single
   * chronological merge of everything real that happened on this
   * collection: lifecycle timeline entries, real payment captures,
   * reminders sent, and staff comments. Distinct from `getCollectionById`'s
   * own lighter bundle (last 20 reminders/audit rows alongside the live
   * document, for a detail-page read) — this is the dedicated, fully
   * chronological feed the spec's own GET .../history contract asks for.
   */
  static async getCollectionHistory(collectionId, tenantId) {
    const collection = await CustomerCollectionModel.findOne({ _id: collectionId, tenantId }).lean();
    if (!collection) throw new Error("Customer collection not found.");

    const reminders = await CollectionReminderModel.find({ tenantId, collectionId: collection._id }).sort({ sentAt: -1 }).lean();

    const entries = [
      ...collection.timeline.map((t) => ({ type: "Timeline", event: t.event, description: t.description, performedBy: t.performedBy, at: t.performedAt })),
      ...collection.payments.map((p) => ({ type: "Payment", event: "PaymentCaptured", description: `${roundCurrency(p.amount)} ${collection.currency} captured.`, performedBy: null, at: p.collectedAt })),
      ...collection.comments.map((c) => ({ type: "Comment", event: "CommentAdded", description: c.text, performedBy: c.createdBy, at: c.createdAt })),
      ...reminders.map((r) => ({ type: "Reminder", event: "ReminderSent", description: `Reminder via ${r.channel}: ${r.status}.`, performedBy: null, at: r.sentAt }))
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    return { collectionId: collection._id, collectionNumber: collection.collectionNumber, entries };
  }
}

export default CustomerCollectionService;
