import InvoiceModel from "../models/InvoiceModel.js";
import CustomerModel from "../models/CustomerModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import ReceiptModel from "../models/ReceiptModel.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import InvoicePdfService from "./InvoicePdfService.js";
import { resolveTenantBranding, resolveTenantDocumentSettings } from "../utils/tenantBranding.js";
import TaxService from "./TaxService.js";
import PricingService from "./PricingService.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { subscribeEvent, publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import BookingServiceModel from "../models/BookingServiceModel.js";
import BookingTravelerModel from "../models/BookingTravelerModel.js";
import { effectiveNights } from "../utils/hotelServiceDetails.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/invoiceService.test.js).
// ---------------------------------------------------------------------------

/** Minimal, real tax-code -> rate lookup — see utils/financeConfig.js taxCodes doc comment for why this isn't the full future Tax Engine. */
export const resolveTaxRate = (taxCode, taxCodes) => {
  if (!taxCode) return 0;
  const match = taxCodes.find((t) => t.code === taxCode);
  if (!match) throw new Error(`Unknown taxCode "${taxCode}".`);
  return match.rate;
};

/** "Pricing Engine: Unit Price, Quantity, Discount, Tax... Grand Total." Computes and stamps one line item's totals. */
export const computeLineTotals = (item, taxCodes) => {
  const quantity = Number(item.quantity);
  const unitPrice = Number(item.unitPrice);
  if (!(quantity > 0)) throw new Error(`Line item "${item.description}": quantity must be greater than zero.`);
  if (!(unitPrice >= 0)) throw new Error(`Line item "${item.description}": unitPrice cannot be negative.`);

  const lineSubtotal = roundCurrency(quantity * unitPrice);

  let lineDiscountAmount = 0;
  if (item.discountType === "Percentage") {
    lineDiscountAmount = roundCurrency(lineSubtotal * (Number(item.discountValue) || 0) / 100);
  } else if (item.discountType === "Flat") {
    lineDiscountAmount = roundCurrency(Number(item.discountValue) || 0);
  }
  if (lineDiscountAmount > lineSubtotal) throw new Error(`Line item "${item.description}": discount cannot exceed the line subtotal.`);

  const taxableAmount = roundCurrency(lineSubtotal - lineDiscountAmount);
  const lineTaxAmount = roundCurrency(taxableAmount * resolveTaxRate(item.taxCode, taxCodes));
  const lineTotal = roundCurrency(taxableAmount + lineTaxAmount);

  return {
    description: item.description,
    quantity,
    unitPrice,
    taxCode: item.taxCode || null,
    discountType: item.discountType || null,
    discountValue: Number(item.discountValue) || 0,
    lineSubtotal,
    lineDiscountAmount,
    lineTaxAmount,
    lineTotal
  };
};

/** Sums computed line items into invoice-level totals. */
export const computeInvoiceTotals = (computedItems) => {
  const subtotal = roundCurrency(computedItems.reduce((sum, i) => sum + i.lineSubtotal, 0));
  const discountTotal = roundCurrency(computedItems.reduce((sum, i) => sum + i.lineDiscountAmount, 0));
  const taxTotal = roundCurrency(computedItems.reduce((sum, i) => sum + i.lineTaxAmount, 0));
  const grandTotal = roundCurrency(computedItems.reduce((sum, i) => sum + i.lineTotal, 0));
  return { subtotal, discountTotal, taxTotal, grandTotal };
};

const EDITABLE_STATUSES = new Set(["Draft"]);
const APPROVABLE_STATUSES = new Set(["Draft", "Pending Approval"]);
const CANCELLABLE_STATUSES = new Set(["Draft", "Pending Approval", "Approved"]);
const VOIDABLE_STATUSES = new Set(["Issued"]);
const CLOSEABLE_STATUSES = new Set(["Paid"]);

export const isInvoiceEditable = (status) => EDITABLE_STATUSES.has(status);
export const isInvoiceApprovable = (status) => APPROVABLE_STATUSES.has(status);
export const isInvoiceIssuable = (status, approvalRequired) => (approvalRequired ? status === "Approved" : status === "Draft" || status === "Approved");
export const isInvoiceCancellable = (status) => CANCELLABLE_STATUSES.has(status);
export const isInvoiceVoidable = (status) => VOIDABLE_STATUSES.has(status);
export const isInvoiceCloseable = (status) => CLOSEABLE_STATUSES.has(status);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class InvoiceService {
  /**
   * Payment-status sync — Invoice's own status (Issued -> Partially Paid ->
   * Paid) and `arReceivableId` cache are kept current by listening to the
   * events AR (Part 5) already publishes for real, rather than duplicating
   * AR's balance logic here. `ReceivableOverdue` reuses AR's existing
   * scheduler (services/receivableOverdueScheduler.js) instead of a second,
   * redundant overdue scheduler.
   */
  static _eventListenersInitialized = false;
  static initEventListeners() {
    if (InvoiceService._eventListenersInitialized) return;
    InvoiceService._eventListenersInitialized = true;

    const syncFromReceivable = async (payload, resolveNextStatus) => {
      if (!payload?.tenantId || !payload?.receivableId) return;
      try {
        const receivable = await AccountsReceivableModel.findOne({ _id: payload.receivableId, tenantId: payload.tenantId }).lean();
        if (!receivable) return;
        const invoice = await InvoiceModel.findOne({ tenantId: payload.tenantId, invoiceNumber: receivable.invoiceNumber });
        if (!invoice) return;

        if (!invoice.arReceivableId) invoice.arReceivableId = receivable._id;
        const nextStatus = resolveNextStatus(invoice.status, receivable);
        if (nextStatus && nextStatus !== invoice.status) {
          invoice.status = nextStatus;
          invoice.timeline.push({ event: `Invoice${nextStatus.replace(/\s/g, "")}`, description: `Synced from receivable ${receivable.invoiceNumber} (${receivable.status}).`, performedBy: "system" });
        }
        await invoice.save();

        if (nextStatus === "Paid") publishEvent("InvoicePaid", { tenantId: invoice.tenantId, invoiceId: invoice._id.toString(), invoiceNumber: invoice.invoiceNumber });
      } catch (error) {
        console.error("InvoiceService payment-status sync failed:", error.message);
      }
    };

    subscribeEvent("PaymentAllocated", (payload) => syncFromReceivable(payload, (currentStatus, receivable) => {
      if (!["Issued", "Partially Paid"].includes(currentStatus)) return null;
      return receivable.outstandingBalance <= 0 ? "Paid" : "Partially Paid";
    }));

    subscribeEvent("ReceivablePaid", (payload) => syncFromReceivable(payload, (currentStatus) => (["Issued", "Partially Paid"].includes(currentStatus) ? "Paid" : null)));

    subscribeEvent("ReceivableOverdue", async (payload) => {
      if (!payload?.tenantId || !payload?.invoiceNumber) return;
      try {
        const invoice = await InvoiceModel.findOne({ tenantId: payload.tenantId, invoiceNumber: payload.invoiceNumber });
        if (!invoice || !["Issued", "Partially Paid"].includes(invoice.status)) return;
        invoice.timeline.push({ event: "InvoiceOverdue", description: `Overdue (outstanding ${payload.outstandingBalance}).`, performedBy: "system" });
        await invoice.save();
        publishEvent("InvoiceOverdue", { tenantId: invoice.tenantId, invoiceId: invoice._id.toString(), invoiceNumber: invoice.invoiceNumber, outstandingBalance: payload.outstandingBalance });
      } catch (error) {
        console.error("InvoiceService overdue sync failed:", error.message);
      }
    });
  }

  static async _generateInvoiceNumber(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "invoiceNumber", year);
    return `${config.invoiceNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  /**
   * Resolves the real, versioned, country-aware tax rate for every
   * distinct taxCode used across `rawItems`, via `TaxService.resolveRatesForCodes`
   * (Part 20) — the jurisdiction signal is the customer's own address
   * country/state (real data, not fabricated); a customer with no
   * address on file falls through to `TaxService`'s own static
   * `config.taxCodes` fallback for backward compatibility, same as
   * before this Part existed.
   */
  static async _resolveTaxCodes(rawItems, customer, tenantId) {
    const codes = rawItems.map((item) => item.taxCode).filter(Boolean);
    return TaxService.resolveRatesForCodes(codes, { country: customer?.address?.country || null, state: customer?.address?.state || null }, tenantId);
  }

  /**
   * "The ERP should never let individual modules calculate discounts
   * independently. Instead, every module should ask a centralized
   * Pricing & Discount Engine" (Part 21). A line supplying `productCode`
   * has its `unitPrice`/discount resolved through the real
   * `PricingService.resolveLinePrice` (Contract price > assigned/default
   * Price List > the line's own `unitPrice` as a last-resort fallback,
   * then real Volume/Promotion discount rules) — expressed back as a
   * plain `Flat` discountValue so the existing, unmodified
   * `computeLineTotals` needs no changes at all. A line with no
   * `productCode` passes through completely untouched — this only
   * activates when the caller opts in.
   */
  static async _resolveCatalogPricing(rawItems, customer, currency, tenantId) {
    const resolved = [];
    for (const item of rawItems) {
      if (!item.productCode) { resolved.push(item); continue; }
      const priced = await PricingService.resolveLinePrice({
        productCode: item.productCode, customerId: customer?._id || null, customerGroup: customer?.category || null,
        quantity: Number(item.quantity), currency, tenantId, fallbackUnitPrice: item.unitPrice ?? null
      });
      resolved.push({ ...item, unitPrice: priced.unitPrice, discountType: priced.totalDiscount > 0 ? "Flat" : (item.discountType || null), discountValue: priced.totalDiscount > 0 ? priced.totalDiscount : (item.discountValue || 0) });
    }
    return resolved;
  }

  // PRD A6 — populated only when this invoice was generated from a booking
  // (invoiceDoc.bookingId set, see PRD A4 / BookingController.GenerateBookingInvoice).
  // Read-only pull of the booking's own hotel service lines/guest — this
  // service already becomes booking-aware the moment a caller passes
  // bookingId in (same precedent as BookingFinanceLinkService reading
  // BookingHeaderModel directly rather than through the event bus, since
  // there's no async event carrying this data at PDF-render time).
  static async _resolveBookingDetailsForPdf(invoiceDoc) {
    if (!invoiceDoc.bookingId) return null;

    const [travelers, hotelServices] = await Promise.all([
      BookingTravelerModel.find({ bookingId: invoiceDoc.bookingId, tenantId: invoiceDoc.tenantId, status: "active" }).lean(),
      BookingServiceModel.find({ bookingId: invoiceDoc.bookingId, tenantId: invoiceDoc.tenantId, serviceType: "hotel", status: "active" }).lean()
    ]);

    const primaryTraveler = travelers.find((t) => t.isPrimary || t.isPrimaryTraveler) || travelers[0] || null;

    return {
      guestName: primaryTraveler ? `${primaryTraveler.firstName || ""} ${primaryTraveler.lastName || ""}`.trim() : null,
      paxCount: travelers.length,
      hotels: hotelServices.map((s) => {
        const d = s.details || {};
        return {
          hotelName: d.hotelName || s.serviceName,
          hotelConfirmationNumber: d.hotelConfirmationNumber || null,
          roomType: d.roomType || null,
          view: d.view || null,
          checkIn: d.checkIn || null,
          checkOut: d.checkOut || null,
          nights: effectiveNights(d),
          adultCount: d.adultCount || null,
          childCount: d.childCount || 0,
          infantCount: d.infantCount || 0,
          mealPlan: d.mealPlan || null
        };
      })
    };
  }

  static async _generatePdf(invoiceDoc, customerName) {
    const [company, bookingDetails, documentSettings] = await Promise.all([
      resolveTenantBranding(invoiceDoc.tenantId),
      InvoiceService._resolveBookingDetailsForPdf(invoiceDoc),
      resolveTenantDocumentSettings(invoiceDoc.tenantId)
    ]);
    const buffer = await InvoicePdfService.generatePdfBuffer({
      invoiceNumber: invoiceDoc.invoiceNumber, invoiceType: invoiceDoc.invoiceType, status: invoiceDoc.status,
      issueDate: invoiceDoc.issueDate, dueDate: invoiceDoc.dueDate, customerName, currency: invoiceDoc.currency,
      items: invoiceDoc.items, subtotal: invoiceDoc.subtotal, taxTotal: invoiceDoc.taxTotal,
      discountTotal: invoiceDoc.discountTotal, grandTotal: invoiceDoc.grandTotal, company, bookingDetails, documentSettings
    });
    const stored = await storeDocumentPdf({ tenantId: invoiceDoc.tenantId, folder: "invoices", filename: `${invoiceDoc.invoiceNumber}.pdf`, buffer });
    return { url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider, generatedAt: new Date() };
  }

  /**
   * POST /api/v1/invoices
   * Validate Customer -> Validate Items -> Calculate Pricing/Taxes/Discounts
   * -> Generate Invoice Number -> Generate PDF -> Timeline -> Audit.
   *
   * Deliberately does NOT fire `InvoiceCreated` / generate AR here — see
   * docs/05-api/07-finance-api.md Part 9: AR's existing (Part 5) listener
   * was built expecting `InvoiceCreated` to mean "a real, billed invoice
   * now exists," which this codebase treats as the Issue transition, not
   * raw Draft creation. `InvoiceCreated` fires from `issueInvoice` below.
   */
  static async createInvoice(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { customerId, invoiceType = config.defaultInvoiceType, currency, issueDate, dueDate, items: rawItems, notes = null, attachments = [], bookingId = null } = data;

    if (!customerId || !currency || !dueDate || !Array.isArray(rawItems) || rawItems.length === 0) {
      throw new Error("customerId, currency, dueDate, and at least one item are required.");
    }

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");

    const issueDateObj = issueDate ? new Date(issueDate) : new Date();
    const dueDateObj = new Date(dueDate);
    await FinancialPeriodService.assertPeriodOpen(tenantId, issueDateObj);

    const pricedItems = await InvoiceService._resolveCatalogPricing(rawItems, customer, currency, tenantId);
    const resolvedTaxCodes = await InvoiceService._resolveTaxCodes(pricedItems, customer, tenantId);
    const computedItems = pricedItems.map((item) => ({ ...computeLineTotals(item, resolvedTaxCodes), productCode: item.productCode || null }));
    const totals = computeInvoiceTotals(computedItems);
    const invoiceNumber = await InvoiceService._generateInvoiceNumber(tenantId);
    const customerName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.companyName || "Customer";

    const invoice = new InvoiceModel({
      tenantId,
      invoiceNumber,
      invoiceType,
      customerId,
      bookingId: bookingId || null,
      customerName,
      status: config.defaultInvoiceStatus,
      currency,
      issueDate: issueDateObj,
      dueDate: dueDateObj,
      items: computedItems,
      ...totals,
      notes,
      attachments,
      timeline: [{ event: "InvoiceDraftCreated", description: `Draft invoice ${invoiceNumber} created.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    invoice.pdf = await InvoiceService._generatePdf(invoice, customerName);
    await invoice.save();

    await AuditLogModel.create({ action: "finance.invoice.create", module: "Finance", resource: "Invoice", resourceId: invoice._id.toString(), userId: userId || null, tenantId, details: { invoiceNumber, grandTotal: totals.grandTotal } });

    return invoice.toJSON();
  }

  static async listInvoices(query, tenantId) {
    const config = getFinanceConfig();
    const { customerId, invoiceNumber, status, invoiceType, currency } = query;
    const filter = { tenantId };
    if (customerId) filter.customerId = customerId;
    if (invoiceNumber) filter.invoiceNumber = invoiceNumber;
    if (status) filter.status = status;
    if (invoiceType) filter.invoiceType = invoiceType;
    if (currency) filter.currency = currency;
    if (query.dateFrom || query.dateTo) {
      filter.issueDate = {};
      if (query.dateFrom) filter.issueDate.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.issueDate.$lte = new Date(query.dateTo);
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { issueDate: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      const field = query.sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      InvoiceModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      InvoiceModel.countDocuments(filter)
    ]);

    const decorated = await Promise.all(items.map((item) => InvoiceService._withLiveBalance(item)));
    return { items: decorated, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /** Live-joins the linked AR receivable (once one exists) rather than trusting a stored copy — see models/InvoiceModel.js doc comment. */
  static async _withLiveBalance(invoice) {
    const receivable = await AccountsReceivableModel.findOne({ tenantId: invoice.tenantId, invoiceNumber: invoice.invoiceNumber }).lean();
    return {
      ...invoice,
      outstandingBalance: receivable ? receivable.outstandingBalance : invoice.grandTotal,
      arReceivableStatus: receivable ? receivable.status : null
    };
  }

  static async getInvoiceById(invoiceId, tenantId) {
    const invoice = await InvoiceModel.findOne({ _id: invoiceId, tenantId }).lean();
    if (!invoice) throw new Error("Invoice not found.");

    const decorated = await InvoiceService._withLiveBalance(invoice);
    const receivable = await AccountsReceivableModel.findOne({ tenantId, invoiceNumber: invoice.invoiceNumber }).lean();

    let paymentHistory = [];
    let receiptHistory = [];
    if (receivable) {
      paymentHistory = receivable.allocations || [];
      const paymentIds = paymentHistory.map((a) => a.paymentId);
      if (paymentIds.length > 0) {
        receiptHistory = await ReceiptModel.find({ tenantId, paymentId: { $in: paymentIds } }).lean();
      }
    }

    const auditSummary = await AuditLogModel.find({ tenantId, resource: "Invoice", resourceId: invoice._id.toString() }).sort({ createdAt: -1 }).limit(20).lean();

    return { ...decorated, paymentHistory, receiptHistory, auditSummary };
  }

  /**
   * PATCH /api/v1/invoices/{invoiceId} — Draft only.
   * Editable Fields: Items, Due Date, Discounts, Notes, Attachments.
   * "Invoice Versioning... Historical versions preserved" — the pre-edit
   * state is snapshotted before any change is applied.
   */
  static async updateInvoice(invoiceId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const invoice = await InvoiceModel.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new Error("Invoice not found.");
    if (!isInvoiceEditable(invoice.status)) throw new Error(`Only Draft invoices can be edited; invoice is "${invoice.status}".`);

    const { items: rawItems, dueDate, notes, attachments } = data;
    const snapshot = invoice.toObject();

    const changedFields = {};
    if (dueDate !== undefined) changedFields.dueDate = new Date(dueDate);
    if (notes !== undefined) changedFields.notes = notes;
    if (attachments !== undefined) changedFields.attachments = attachments;

    if (rawItems !== undefined) {
      const customer = await CustomerModel.findOne({ _id: invoice.customerId, tenantId }).lean();
      const pricedItems = await InvoiceService._resolveCatalogPricing(rawItems, customer, invoice.currency, tenantId);
      const resolvedTaxCodes = await InvoiceService._resolveTaxCodes(pricedItems, customer, tenantId);
      const computedItems = pricedItems.map((item) => ({ ...computeLineTotals(item, resolvedTaxCodes), productCode: item.productCode || null }));
      const totals = computeInvoiceTotals(computedItems);
      changedFields.items = computedItems;
      Object.assign(changedFields, totals);
    }

    invoice.versionHistory.push({ version: invoice.version, snapshot, changedAt: new Date(), changedBy: userId || null, reason: data.reason || null });
    invoice.version += 1;
    Object.assign(invoice, changedFields);
    invoice.updatedBy = userId || null;
    invoice.timeline.push({ event: "InvoiceUpdated", description: `Invoice updated (v${invoice.version}).`, performedBy: userId || null });

    invoice.pdf = await InvoiceService._generatePdf(invoice, invoice.customerName);
    await invoice.save();

    await AuditLogModel.create({ action: "finance.invoice.update", module: "Finance", resource: "Invoice", resourceId: invoice._id.toString(), userId: userId || null, tenantId, details: { version: invoice.version, changedFields: Object.keys(changedFields) } });
    publishEvent("InvoiceUpdated", { tenantId, invoiceId: invoice._id.toString(), invoiceNumber: invoice.invoiceNumber, version: invoice.version, performedBy: userId || null });

    return invoice.toJSON();
  }

  static async approveInvoice(invoiceId, tenantId, userId) {
    const invoice = await InvoiceModel.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new Error("Invoice not found.");
    if (!isInvoiceApprovable(invoice.status)) throw new Error(`Invoice cannot be approved from status "${invoice.status}".`);

    invoice.status = "Approved";
    invoice.approvedBy = userId || null;
    invoice.approvedAt = new Date();
    invoice.timeline.push({ event: "InvoiceApproved", description: "Invoice approved.", performedBy: userId || null });
    await invoice.save();

    await AuditLogModel.create({ action: "finance.invoice.approve", module: "Finance", resource: "Invoice", resourceId: invoice._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("InvoiceApproved", { tenantId, invoiceId: invoice._id.toString(), invoiceNumber: invoice.invoiceNumber, performedBy: userId || null });

    return invoice.toJSON();
  }

  /**
   * POST /api/v1/invoices/{invoiceId}/issue — gap-fill (Approved -> Issued
   * has no other trigger given). This is where "Generate AR" and "Publish
   * InvoiceCreated" from the spec's own POST /invoices Business Workflow
   * actually happen — see createInvoice's doc comment for why.
   */
  static async issueInvoice(invoiceId, tenantId, userId) {
    const config = getFinanceConfig();
    const invoice = await InvoiceModel.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new Error("Invoice not found.");
    if (!isInvoiceIssuable(invoice.status, config.invoiceApprovalRequired)) {
      throw new Error(`Invoice cannot be issued from status "${invoice.status}".${config.invoiceApprovalRequired ? " It must be Approved first." : ""}`);
    }

    // Re-checked here, not just at draft creation — the period may have
    // closed since (same discipline as Journal's post-time re-check).
    await FinancialPeriodService.assertPeriodOpen(tenantId, invoice.issueDate);

    invoice.status = "Issued";
    invoice.issuedBy = userId || null;
    invoice.issuedAt = new Date();
    invoice.timeline.push({ event: "InvoiceIssued", description: "Invoice issued.", performedBy: userId || null });
    invoice.pdf = await InvoiceService._generatePdf(invoice, invoice.customerName);
    await invoice.save();

    await AuditLogModel.create({ action: "finance.invoice.issue", module: "Finance", resource: "Invoice", resourceId: invoice._id.toString(), userId: userId || null, tenantId, details: { invoiceNumber: invoice.invoiceNumber, grandTotal: invoice.grandTotal } });

    // The exact contract AccountsReceivableService.initEventListeners()
    // has been waiting on since Part 5.
    publishEvent("InvoiceCreated", {
      tenantId,
      customerId: invoice.customerId.toString(),
      invoiceId: invoice._id.toString(),
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.grandTotal,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      revenueAccountCode: config.defaultRevenueAccountCode,
      performedBy: userId || null
    });
    publishEvent("InvoiceIssued", { tenantId, invoiceId: invoice._id.toString(), invoiceNumber: invoice.invoiceNumber, performedBy: userId || null });

    return invoice.toJSON();
  }

  static async cancelInvoice(invoiceId, data, tenantId, userId) {
    const invoice = await InvoiceModel.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new Error("Invoice not found.");
    if (!isInvoiceCancellable(invoice.status)) throw new Error(`Invoice cannot be cancelled from status "${invoice.status}". Issued invoices must be voided instead.`);

    invoice.status = "Cancelled";
    invoice.cancelledBy = userId || null;
    invoice.cancelledAt = new Date();
    invoice.cancellationReason = data?.reason || null;
    invoice.timeline.push({ event: "InvoiceCancelled", description: data?.reason || "Invoice cancelled.", performedBy: userId || null });
    await invoice.save();

    await AuditLogModel.create({ action: "finance.invoice.cancel", module: "Finance", resource: "Invoice", resourceId: invoice._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("InvoiceCancelled", { tenantId, invoiceId: invoice._id.toString(), invoiceNumber: invoice.invoiceNumber, performedBy: userId || null });

    return invoice.toJSON();
  }

  /**
   * POST /api/v1/invoices/{invoiceId}/void — gap-fill: `InvoiceVoided` is a
   * named domain event with no endpoint. Only for an Issued invoice with no
   * payments applied yet — once money has moved, use AR's own reversal
   * mechanisms instead of erasing the invoice's billed status.
   */
  static async voidInvoice(invoiceId, data, tenantId, userId) {
    const invoice = await InvoiceModel.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new Error("Invoice not found.");
    if (!isInvoiceVoidable(invoice.status)) throw new Error(`Invoice cannot be voided from status "${invoice.status}".`);

    const receivable = await AccountsReceivableModel.findOne({ tenantId, invoiceNumber: invoice.invoiceNumber }).lean();
    if (receivable && receivable.paidAmount > 0) {
      throw new Error("Cannot void an invoice that already has payments applied — use the receivable's own write-off/reversal instead.");
    }

    invoice.status = "Voided";
    invoice.voidedBy = userId || null;
    invoice.voidedAt = new Date();
    invoice.timeline.push({ event: "InvoiceVoided", description: data?.reason || "Invoice voided.", performedBy: userId || null });
    await invoice.save();

    await AuditLogModel.create({ action: "finance.invoice.void", module: "Finance", resource: "Invoice", resourceId: invoice._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("InvoiceVoided", { tenantId, invoiceId: invoice._id.toString(), invoiceNumber: invoice.invoiceNumber, performedBy: userId || null });

    return invoice.toJSON();
  }

  static async closeInvoice(invoiceId, tenantId, userId) {
    const invoice = await InvoiceModel.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new Error("Invoice not found.");
    if (!isInvoiceCloseable(invoice.status)) throw new Error(`Invoice cannot be closed from status "${invoice.status}".`);

    invoice.status = "Closed";
    invoice.closedBy = userId || null;
    invoice.closedAt = new Date();
    invoice.timeline.push({ event: "InvoiceClosed", description: "Invoice closed.", performedBy: userId || null });
    await invoice.save();

    await AuditLogModel.create({ action: "finance.invoice.close", module: "Finance", resource: "Invoice", resourceId: invoice._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("InvoiceClosed", { tenantId, invoiceId: invoice._id.toString(), invoiceNumber: invoice.invoiceNumber, performedBy: userId || null });

    return invoice.toJSON();
  }
}

export default InvoiceService;
