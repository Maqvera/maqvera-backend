import VendorPaymentModel from "../models/VendorPaymentModel.js";
import PaymentBatchModel from "../models/PaymentBatchModel.js";
import VendorModel from "../models/VendorModel.js";
import AccountsPayableModel from "../models/AccountsPayableModel.js";
import BankAccountModel from "../models/BankAccountModel.js";
import DepartmentModel from "../models/Departmentmodel.js";
import AccountsPayableService, { isPayableEligibleForPayment } from "./AccountsPayableService.js";
import PaymentService from "./PaymentService.js";
import VendorCreditService from "./VendorCreditService.js";
import AIModelRouterService from "./ai/AIModelRouterService.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import CurrencyService from "./CurrencyService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import getPaymentFileGenerator from "./paymentFileGenerators/index.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/vendorPaymentService.test.js).
// ---------------------------------------------------------------------------

/** Real IBAN MOD-97-10 checksum — not just a format regex. */
export const isValidIban = (iban) => {
  const cleaned = (iban || "").replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(cleaned)) return false;
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => (c.charCodeAt(0) - 55).toString());
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = parseInt(remainder.toString() + numeric.slice(i, i + 7), 10) % 97;
  }
  return remainder === 1;
};

/** Real SWIFT/BIC format check — 6 letters (bank+country code) + 2 alphanumeric (location) + optional 3 alphanumeric (branch). */
export const isValidSwiftBic = (code) => /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test((code || "").toUpperCase());

export const isBusinessDay = (date) => {
  const day = new Date(date).getUTCDay();
  return day !== 0 && day !== 6;
};

/** "Payment Scheduling... Business Day" — rolls forward to the next weekday when skipWeekends is enabled. "Holiday Rules" is honestly not implemented (see docs). */
export const nextBusinessDay = (date, skipWeekends = true) => {
  const d = new Date(date);
  if (!skipWeekends) return d;
  while (!isBusinessDay(d)) d.setUTCDate(d.getUTCDate() + 1);
  return d;
};

/** "Dual Approval" — same design as Part 15's Cash Transfer dual authorization. */
export const requiresDualApproval = (amount, config) => config.vendorPaymentDualApprovalThreshold > 0 && amount >= config.vendorPaymentDualApprovalThreshold;
export const requiredApprovalCount = (requiresDual) => (requiresDual ? 2 : 1);
export const hasEnoughApprovals = (approvals, requiredCount) => new Set((approvals || []).map((a) => a.approvedBy)).size >= requiredCount;

/**
 * "Duplicate Payment Detection... before approval" (File 6 Part 2) — pure,
 * real, deterministic: a payable already covered by another active
 * (non-terminal) proposal is a genuine duplicate risk. `existingPayments`
 * is the set of this vendor's own non-Rejected/Cancelled/Failed proposals
 * (queried by the caller); this only does the actual overlap check.
 */
export const findDuplicatePayablePayments = (payableIds, existingPayments) => {
  const targetIds = new Set(payableIds.map((id) => id.toString()));
  return (existingPayments || []).filter((payment) => (payment.lineAllocations || []).some((line) => targetIds.has(line.payableId.toString())));
};

/**
 * "Fund Reservation... Bank Balance." Real but advisory at proposal time —
 * see `fundAvailabilityCheck`'s own schema doc comment for why this isn't
 * a true reservation/lock.
 */
export const checkFundAvailability = (availableBalance, totalAmount) => {
  const shortfall = roundCurrency(Math.max(0, totalAmount - (availableBalance || 0)));
  return { available: shortfall === 0, shortfall };
};

export const isVendorPaymentApprovable = (status) => status === "Proposed";
export const isVendorPaymentRejectable = (status) => status === "Proposed";
export const isVendorPaymentCancellable = (status) => ["Proposed", "Approved", "Scheduled", "On Hold"].includes(status);
export const isVendorPaymentHoldable = (status) => ["Approved", "Scheduled"].includes(status);
export const isVendorPaymentReleasable = (status) => status === "On Hold";
export const isVendorPaymentSchedulable = (status) => status === "Approved";
export const isVendorPaymentExecutable = (status) => status === "Scheduled";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class VendorPaymentService {
  static async _generateCode(tenantId, scope, prefix) {
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, scope, year);
    return `${prefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  // ---- Vendor Bank Accounts ----

  /**
   * POST /api/v1/vendors/{vendorId}/bank-accounts — "Vendor Bank
   * Accounts... Multiple Accounts, Primary Account, Country Rules, IBAN,
   * SWIFT/BIC. Validation configurable." IBAN/SWIFT are validated for real
   * (MOD-97-10 checksum, real format check) only when supplied — not every
   * country uses IBAN.
   */
  static async addVendorBankAccount(vendorId, data, tenantId, userId) {
    const { accountName, bankName, country, currency, iban = null, swiftBic = null, accountNumber = null, isPrimary = false } = data;
    if (!accountName || !bankName || !country || !currency) throw new Error("accountName, bankName, country, and currency are required.");
    if (!iban && !accountNumber) throw new Error("Either iban or accountNumber is required.");
    if (iban && !isValidIban(iban)) throw new Error("iban failed checksum validation.");
    if (swiftBic && !isValidSwiftBic(swiftBic)) throw new Error("swiftBic is not a valid format.");

    const vendor = await VendorModel.findOne({ _id: vendorId, tenantId });
    if (!vendor) throw new Error("Vendor not found.");

    if (isPrimary) vendor.bankAccounts.forEach((b) => { b.isPrimary = false; });
    vendor.bankAccounts.push({ accountName, bankName, country, currency, iban, swiftBic, accountNumber, isPrimary: isPrimary || vendor.bankAccounts.length === 0, addedBy: userId || null });
    vendor.updatedBy = userId || null;
    await vendor.save();

    await AuditLogModel.create({ action: "finance.vendorpayment.add_bank_account", module: "Finance", resource: "Vendor", resourceId: vendor._id.toString(), userId: userId || null, tenantId, details: { accountName, bankName, country } });

    return vendor.toJSON();
  }

  static async listVendorBankAccounts(vendorId, tenantId) {
    const vendor = await VendorModel.findOne({ _id: vendorId, tenantId }).lean();
    if (!vendor) throw new Error("Vendor not found.");
    return vendor.bankAccounts || [];
  }

  static async setPrimaryVendorBankAccount(vendorId, bankAccountRecordId, tenantId, userId) {
    const vendor = await VendorModel.findOne({ _id: vendorId, tenantId });
    if (!vendor) throw new Error("Vendor not found.");
    const target = vendor.bankAccounts.id(bankAccountRecordId);
    if (!target) throw new Error("Vendor bank account not found.");

    vendor.bankAccounts.forEach((b) => { b.isPrimary = b._id.equals(target._id); });
    vendor.updatedBy = userId || null;
    await vendor.save();

    await AuditLogModel.create({ action: "finance.vendorpayment.set_primary_bank_account", module: "Finance", resource: "Vendor", resourceId: vendor._id.toString(), userId: userId || null, tenantId, details: { bankAccountRecordId: bankAccountRecordId.toString() } });

    return vendor.toJSON();
  }

  // ---- Vendor Payment Proposals ----

  /**
   * POST /api/v1/vendor-payments
   * Validate Vendor -> Validate Outstanding Payables -> Validate Bank
   * Account -> Create Payment Proposal -> Approval Workflow -> Publish
   * VendorPaymentProposed. Auto-skips straight to "Approved" (still firing
   * both events) when approval isn't required and the amount doesn't
   * trigger dual authorization — same auto-skip convention used
   * identically by Refund/Bank Account/Debit Note this session.
   */
  static async createVendorPaymentProposal(data, tenantId, userId) {
    const config = getFinanceConfig();
    const {
      vendorId, invoiceIds, amounts = {}, paymentDate, bankAccountId, vendorBankAccountId = null, priority = null,
      paymentType = null, department = null, costCenter = null, projectId = null,
      source = config.defaultVendorPaymentSource
    } = data;

    if (!vendorId || !Array.isArray(invoiceIds) || invoiceIds.length === 0 || !paymentDate || !bankAccountId) {
      throw new Error("vendorId, invoiceIds, paymentDate, and bankAccountId are required.");
    }
    if (paymentType && !config.paymentMethods.includes(paymentType)) throw new Error(`Invalid paymentType "${paymentType}".`);
    if (source && !config.vendorPaymentSources.includes(source)) throw new Error(`Invalid source "${source}".`);

    const vendor = await VendorModel.findOne({ _id: vendorId, tenantId }).lean();
    if (!vendor) throw new Error("Vendor not found.");
    if (vendor.status !== "Active") throw new Error(`Vendor is not Active (status: "${vendor.status}").`);

    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId }).lean();
    if (!bankAccount) throw new Error("Bank account not found.");
    if (bankAccount.status !== "Active") throw new Error(`Bank account is not Active (status: "${bankAccount.status}").`);

    if (vendorBankAccountId) {
      const hasVendorAccount = (vendor.bankAccounts || []).some((b) => b._id.toString() === vendorBankAccountId.toString());
      if (!hasVendorAccount) throw new Error("vendorBankAccountId does not belong to this vendor.");
    }

    // "Department belongs to Company" — real, tenant-scoped lookup, same
    // discipline as the cross-tenant-reference bug fixed for Expense's own
    // employeeId in Part 34.
    if (department) {
      const departmentDoc = await DepartmentModel.findOne({ _id: department, tenantId }).lean();
      if (!departmentDoc) throw new Error("Department not found.");
    }

    // "Accounting Period Open" — a real, pre-existing gap: this method
    // never checked it at all before this Part (only `executeVendorPayment`
    // did, at execution time — too late to stop a proposal from being
    // created against a closed period).
    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date(paymentDate));

    const payables = await AccountsPayableModel.find({ _id: { $in: invoiceIds }, tenantId, vendorId }).lean();
    if (payables.length !== invoiceIds.length) throw new Error("One or more invoices were not found for this vendor.");

    const lineAllocations = payables.map((payable) => {
      if (!isPayableEligibleForPayment(payable.status)) throw new Error(`Payable ${payable.invoiceNumber} is not eligible for payment (status: "${payable.status}").`);
      if (payable.currency !== bankAccount.currency) throw new Error(`Currency mismatch: payable ${payable.invoiceNumber} is ${payable.currency}, bank account is ${bankAccount.currency}.`);
      const requestedAmount = amounts[payable._id.toString()];
      const amount = requestedAmount !== undefined ? roundCurrency(requestedAmount) : payable.outstandingBalance;
      if (amount <= 0 || amount > payable.outstandingBalance) throw new Error(`Invalid amount for payable ${payable.invoiceNumber}: must be > 0 and <= ${payable.outstandingBalance}.`);
      return { payableId: payable._id, invoiceNumber: payable.invoiceNumber, amount };
    });

    // "Duplicate Payment Detection... before approval" — real, blocking.
    const activeStatuses = config.vendorPaymentStatuses.filter((s) => !["Rejected", "Cancelled", "Failed"].includes(s));
    const existingActivePayments = await VendorPaymentModel.find({ tenantId, vendorId, status: { $in: activeStatuses } }).select("vendorPaymentNumber lineAllocations").lean();
    const duplicates = findDuplicatePayablePayments(invoiceIds, existingActivePayments);
    if (duplicates.length > 0) {
      throw new Error(`Duplicate payment: invoice(s) already covered by an active proposal (${duplicates.map((d) => d.vendorPaymentNumber).join(", ")}).`);
    }

    const totalAmount = roundCurrency(lineAllocations.reduce((sum, l) => sum + l.amount, 0));
    const needsDualApproval = requiresDualApproval(totalAmount, config);
    const approvalRequired = config.vendorPaymentApprovalRequired || needsDualApproval;

    // Real base-currency conversion — same pattern as ExpenseService's own
    // `_computeBaseCurrencyFields` (Part 34), best-effort (never blocks
    // creating a proposal when no rate is available yet).
    const baseCurrency = await CurrencyService.getBaseCurrency(tenantId);
    let baseCurrencyAmount = totalAmount;
    let exchangeRate = 1;
    // "Multi-Currency Accounting... Rate Version." (File 7 Part 4) — real
    // rate-provenance snapshot, from the same convert() call above,
    // previously discarded (same gap ExpenseModel's own fields just closed).
    let exchangeRateId = null; let exchangeRateVersion = null; let exchangeRateProvider = null; let exchangeRateType = null;
    if (bankAccount.currency.toUpperCase() !== baseCurrency.toUpperCase()) {
      try {
        const converted = await CurrencyService.convert(totalAmount, bankAccount.currency, baseCurrency, tenantId);
        baseCurrencyAmount = converted.convertedAmount;
        exchangeRate = converted.rate;
        exchangeRateId = converted.rateId; exchangeRateVersion = converted.rateVersion; exchangeRateProvider = converted.rateProvider; exchangeRateType = converted.rateType;
      } catch {
        baseCurrencyAmount = null;
        exchangeRate = null;
      }
    }

    // "Fund Reservation... Bank Balance" — real, advisory (see
    // fundAvailabilityCheck's own schema doc comment).
    const fundAvailabilityCheck = { ...checkFundAvailability(bankAccount.balances?.available, totalAmount), checkedAt: new Date() };

    const financialPeriod = await FinancialPeriodService.findPeriodForDate(tenantId, new Date(paymentDate)).catch(() => null);

    const vendorPaymentNumber = await VendorPaymentService._generateCode(tenantId, "vendorPaymentNumber", config.vendorPaymentNumberPrefix);

    const vendorPayment = new VendorPaymentModel({
      tenantId, vendorPaymentNumber, vendorId, vendorName: vendor.name, lineAllocations, totalAmount,
      currency: bankAccount.currency, bankAccountId, vendorBankAccountId, paymentDate: new Date(paymentDate), priority,
      paymentCategory: config.defaultVendorPaymentCategory, paymentType, department, costCenter, projectId, source,
      financialPeriodId: financialPeriod?._id || null, baseCurrency, baseCurrencyAmount, exchangeRate,
      exchangeRateId, exchangeRateVersion, exchangeRateProvider, exchangeRateType,
      duplicateCheck: { isDuplicate: false, matchedVendorPaymentIds: [], checkedAt: new Date() },
      fundAvailabilityCheck,
      status: config.defaultVendorPaymentStatus, requiresDualApproval: needsDualApproval,
      proposedBy: userId || null, proposedAt: new Date(),
      timeline: [{ event: "VendorPaymentProposed", description: `Proposed payment of ${totalAmount} ${bankAccount.currency} to ${vendor.name} across ${lineAllocations.length} invoice(s).`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    if (!approvalRequired) {
      vendorPayment.status = "Approved";
      vendorPayment.approvedAt = new Date();
      vendorPayment.timeline.push({ event: "VendorPaymentApproved", description: "Auto-approved — below the configured approval threshold.", performedBy: "system" });
    }
    await vendorPayment.save();

    await AuditLogModel.create({ action: "finance.vendorpayment.propose", module: "Finance", resource: "VendorPayment", resourceId: vendorPayment._id.toString(), userId: userId || null, tenantId, details: { vendorPaymentNumber, totalAmount, invoiceCount: lineAllocations.length } });
    publishEvent("VendorPaymentProposed", { tenantId, vendorPaymentId: vendorPayment._id.toString(), vendorId: vendorId.toString(), totalAmount, currency: bankAccount.currency, performedBy: userId || null });
    if (vendorPayment.status === "Approved") {
      publishEvent("VendorPaymentApproved", { tenantId, vendorPaymentId: vendorPayment._id.toString(), performedBy: "system" });
    }

    return vendorPayment.toJSON();
  }

  static async listVendorPayments(query, tenantId) {
    const config = getFinanceConfig();
    const { vendorId, status, currency, bankAccount } = query;
    const filter = { tenantId };
    if (vendorId) filter.vendorId = vendorId;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;
    if (bankAccount) filter.bankAccountId = bankAccount;
    if (query.paymentDate) filter.paymentDate = new Date(query.paymentDate);

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { paymentDate: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      const field = query.sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      VendorPaymentModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      VendorPaymentModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getVendorPaymentById(vendorPaymentId, tenantId) {
    const vendorPayment = await VendorPaymentModel.findOne({ _id: vendorPaymentId, tenantId }).lean();
    if (!vendorPayment) throw new Error("Vendor payment not found.");

    const auditSummary = await AuditLogModel.find({ tenantId, resource: "VendorPayment", resourceId: vendorPayment._id.toString() }).sort({ createdAt: -1 }).limit(20).lean();
    return { ...vendorPayment, auditSummary };
  }

  static async approveVendorPayment(vendorPaymentId, tenantId, userId) {
    const vendorPayment = await VendorPaymentModel.findOne({ _id: vendorPaymentId, tenantId });
    if (!vendorPayment) throw new Error("Vendor payment not found.");
    if (!isVendorPaymentApprovable(vendorPayment.status)) throw new Error(`Vendor payment cannot be approved from status "${vendorPayment.status}".`);
    if (vendorPayment.approvals.some((a) => a.approvedBy === (userId || null))) {
      throw new Error("This user has already approved this payment — a second, different approver is required.");
    }

    vendorPayment.approvals.push({ approvedBy: userId || null, approvedAt: new Date() });
    const required = requiredApprovalCount(vendorPayment.requiresDualApproval);

    if (hasEnoughApprovals(vendorPayment.approvals, required)) {
      vendorPayment.status = "Approved";
      vendorPayment.approvedAt = new Date();
      vendorPayment.updatedBy = userId || null;
      vendorPayment.timeline.push({ event: "VendorPaymentApproved", description: "Vendor payment approved.", performedBy: userId || null });
      await vendorPayment.save();
      publishEvent("VendorPaymentApproved", { tenantId, vendorPaymentId: vendorPayment._id.toString(), performedBy: userId || null });
    } else {
      vendorPayment.updatedBy = userId || null;
      vendorPayment.timeline.push({ event: "VendorPaymentPartiallyApproved", description: `${vendorPayment.approvals.length}/${required} approvals recorded.`, performedBy: userId || null });
      await vendorPayment.save();
    }

    await AuditLogModel.create({ action: "finance.vendorpayment.approve", module: "Finance", resource: "VendorPayment", resourceId: vendorPayment._id.toString(), userId: userId || null, tenantId, details: { approvalsCount: vendorPayment.approvals.length, required } });

    return vendorPayment.toJSON();
  }

  static async rejectVendorPayment(vendorPaymentId, data, tenantId, userId) {
    const vendorPayment = await VendorPaymentModel.findOne({ _id: vendorPaymentId, tenantId });
    if (!vendorPayment) throw new Error("Vendor payment not found.");
    if (!isVendorPaymentRejectable(vendorPayment.status)) throw new Error(`Vendor payment cannot be rejected from status "${vendorPayment.status}".`);

    vendorPayment.status = "Rejected";
    vendorPayment.rejectedBy = userId || null;
    vendorPayment.rejectedAt = new Date();
    vendorPayment.rejectionReason = data?.reason || null;
    vendorPayment.updatedBy = userId || null;
    vendorPayment.timeline.push({ event: "VendorPaymentRejected", description: data?.reason || "Vendor payment rejected.", performedBy: userId || null });
    await vendorPayment.save();

    await AuditLogModel.create({ action: "finance.vendorpayment.reject", module: "Finance", resource: "VendorPayment", resourceId: vendorPayment._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return vendorPayment.toJSON();
  }

  static async cancelVendorPayment(vendorPaymentId, data, tenantId, userId) {
    const vendorPayment = await VendorPaymentModel.findOne({ _id: vendorPaymentId, tenantId });
    if (!vendorPayment) throw new Error("Vendor payment not found.");
    if (!isVendorPaymentCancellable(vendorPayment.status)) throw new Error(`Vendor payment cannot be cancelled from status "${vendorPayment.status}".`);

    vendorPayment.status = "Cancelled";
    vendorPayment.cancelledBy = userId || null;
    vendorPayment.cancelledAt = new Date();
    vendorPayment.cancellationReason = data?.reason || null;
    vendorPayment.updatedBy = userId || null;
    vendorPayment.timeline.push({ event: "VendorPaymentCancelled", description: data?.reason || "Vendor payment cancelled.", performedBy: userId || null });
    await vendorPayment.save();

    await AuditLogModel.create({ action: "finance.vendorpayment.cancel", module: "Finance", resource: "VendorPayment", resourceId: vendorPayment._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return vendorPayment.toJSON();
  }

  static async holdVendorPayment(vendorPaymentId, data, tenantId, userId) {
    const vendorPayment = await VendorPaymentModel.findOne({ _id: vendorPaymentId, tenantId });
    if (!vendorPayment) throw new Error("Vendor payment not found.");
    if (!isVendorPaymentHoldable(vendorPayment.status)) throw new Error(`Vendor payment cannot be held from status "${vendorPayment.status}".`);

    vendorPayment.status = "On Hold";
    vendorPayment.heldBy = userId || null;
    vendorPayment.heldAt = new Date();
    vendorPayment.holdReason = data?.reason || null;
    vendorPayment.updatedBy = userId || null;
    vendorPayment.timeline.push({ event: "VendorPaymentHeld", description: data?.reason || "Vendor payment placed on hold.", performedBy: userId || null });
    await vendorPayment.save();

    await AuditLogModel.create({ action: "finance.vendorpayment.hold", module: "Finance", resource: "VendorPayment", resourceId: vendorPayment._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return vendorPayment.toJSON();
  }

  static async releaseVendorPaymentHold(vendorPaymentId, tenantId, userId) {
    const vendorPayment = await VendorPaymentModel.findOne({ _id: vendorPaymentId, tenantId });
    if (!vendorPayment) throw new Error("Vendor payment not found.");
    if (!isVendorPaymentReleasable(vendorPayment.status)) throw new Error(`Vendor payment cannot be released from status "${vendorPayment.status}".`);

    vendorPayment.status = "Approved";
    vendorPayment.updatedBy = userId || null;
    vendorPayment.timeline.push({ event: "VendorPaymentHoldReleased", description: "Hold released — returned to Approved.", performedBy: userId || null });
    await vendorPayment.save();

    await AuditLogModel.create({ action: "finance.vendorpayment.release_hold", module: "Finance", resource: "VendorPayment", resourceId: vendorPayment._id.toString(), userId: userId || null, tenantId, details: {} });

    return vendorPayment.toJSON();
  }

  /**
   * POST /api/v1/vendor-payments/{vendorPaymentId}/schedule
   */
  static async scheduleVendorPayment(vendorPaymentId, tenantId, userId) {
    const config = getFinanceConfig();
    const vendorPayment = await VendorPaymentModel.findOne({ _id: vendorPaymentId, tenantId });
    if (!vendorPayment) throw new Error("Vendor payment not found.");
    if (!isVendorPaymentSchedulable(vendorPayment.status)) throw new Error(`Vendor payment cannot be scheduled from status "${vendorPayment.status}".`);

    const adjustedDate = nextBusinessDay(vendorPayment.paymentDate, config.businessDaySkipWeekends);
    vendorPayment.paymentDate = adjustedDate;
    vendorPayment.status = "Scheduled";
    vendorPayment.scheduledAt = new Date();
    vendorPayment.updatedBy = userId || null;
    vendorPayment.timeline.push({ event: "VendorPaymentScheduled", description: `Scheduled for ${adjustedDate.toISOString().slice(0, 10)}.`, performedBy: userId || null });
    await vendorPayment.save();

    await AuditLogModel.create({ action: "finance.vendorpayment.schedule", module: "Finance", resource: "VendorPayment", resourceId: vendorPayment._id.toString(), userId: userId || null, tenantId, details: { paymentDate: adjustedDate } });
    publishEvent("VendorPaymentScheduled", { tenantId, vendorPaymentId: vendorPayment._id.toString(), paymentDate: adjustedDate, performedBy: userId || null });

    return vendorPayment.toJSON();
  }

  /**
   * POST /api/v1/vendor-payments/{vendorPaymentId}/execute
   * Validate Approval -> Reserve Funds (Cash Availability check) -> Call
   * Payment Engine -> Receive Gateway Result -> Update AP -> Generate
   * Journal/Ledger (both happen inside PaymentService/AccountsPayableService's
   * own already-real logic) -> Audit -> Publish VendorPaymentCompleted.
   * Never moves money itself — delegates entirely to `PaymentService.createPayment`
   * (Part 7) and `AccountsPayableService.allocatePayment` (Part 6), the
   * literal "Payment Engine executes, Vendor Payment Platform orchestrates"
   * distinction this Part opens with. The real bank-account debit happens
   * automatically too, via Part 13's own `PaymentCaptured` event listener
   * — no new money-movement code was needed for it.
   */
  static async executeVendorPayment(vendorPaymentId, tenantId, userId) {
    const vendorPayment = await VendorPaymentModel.findOne({ _id: vendorPaymentId, tenantId });
    if (!vendorPayment) throw new Error("Vendor payment not found.");
    if (!isVendorPaymentExecutable(vendorPayment.status)) throw new Error(`Vendor payment cannot be executed from status "${vendorPayment.status}".`);

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    const bankAccount = await BankAccountModel.findOne({ _id: vendorPayment.bankAccountId, tenantId }).lean();
    if (!bankAccount) throw new Error("Paying bank account no longer exists.");
    if (bankAccount.balances.available < vendorPayment.totalAmount) {
      throw new Error(`Insufficient available balance: requested ${vendorPayment.totalAmount} ${vendorPayment.currency}, available ${bankAccount.balances.available}.`);
    }

    vendorPayment.status = "Executing";
    vendorPayment.executedAt = new Date();
    vendorPayment.updatedBy = userId || null;
    vendorPayment.timeline.push({ event: "VendorPaymentExecuted", description: "Execution started.", performedBy: userId || null });
    await vendorPayment.save();
    publishEvent("VendorPaymentExecuted", { tenantId, vendorPaymentId: vendorPayment._id.toString(), totalAmount: vendorPayment.totalAmount, performedBy: userId || null });

    try {
      const payment = await PaymentService.createPayment({
        paymentType: "Vendor", partyType: "vendor", partyId: vendorPayment.vendorId, bankAccountId: vendorPayment.bankAccountId,
        amount: vendorPayment.totalAmount, currency: vendorPayment.currency, paymentMethod: "Bank Transfer", reference: vendorPayment.vendorPaymentNumber
      }, tenantId, userId);

      if (payment.status === "Failed") {
        vendorPayment.status = "Failed";
        vendorPayment.executionResult = { gatewayStatus: payment.status, failureReason: payment.failureReason || null };
        vendorPayment.timeline.push({ event: "VendorPaymentFailed", description: payment.failureReason || "Gateway payment failed.", performedBy: userId || null });
        await vendorPayment.save();
        await AuditLogModel.create({ action: "finance.vendorpayment.execute", module: "Finance", resource: "VendorPayment", resourceId: vendorPayment._id.toString(), userId: userId || null, tenantId, details: { failed: true } });
        publishEvent("VendorPaymentFailed", { tenantId, vendorPaymentId: vendorPayment._id.toString(), reason: payment.failureReason || null, performedBy: userId || null });
        return vendorPayment.toJSON();
      }

      const allocationWarnings = [];
      for (const line of vendorPayment.lineAllocations) {
        try {
          await AccountsPayableService.allocatePayment(line.payableId, { paymentId: payment._id, amount: line.amount }, tenantId, userId);
        } catch (error) {
          allocationWarnings.push({ payableId: line.payableId, error: error.message });
        }
      }

      vendorPayment.paymentId = payment._id;
      vendorPayment.status = "Completed";
      vendorPayment.completedAt = new Date();
      vendorPayment.executionResult = { gatewayStatus: payment.status, transactionId: payment.gatewayDetails?.transactionId || null, allocationWarnings };
      vendorPayment.updatedBy = userId || null;
      vendorPayment.timeline.push({ event: "VendorPaymentCompleted", description: `Completed — ${vendorPayment.totalAmount} ${vendorPayment.currency} paid to ${vendorPayment.vendorName}.`, performedBy: userId || null });
      await vendorPayment.save();

      await AuditLogModel.create({ action: "finance.vendorpayment.execute", module: "Finance", resource: "VendorPayment", resourceId: vendorPayment._id.toString(), userId: userId || null, tenantId, details: { paymentId: payment._id.toString(), allocationWarningCount: allocationWarnings.length } });
      publishEvent("VendorPaymentCompleted", { tenantId, vendorPaymentId: vendorPayment._id.toString(), vendorId: vendorPayment.vendorId.toString(), paymentId: payment._id.toString(), totalAmount: vendorPayment.totalAmount, performedBy: userId || null });
    } catch (error) {
      vendorPayment.status = "Failed";
      vendorPayment.executionResult = { failureReason: error.message };
      vendorPayment.timeline.push({ event: "VendorPaymentFailed", description: error.message, performedBy: userId || null });
      await vendorPayment.save();
      publishEvent("VendorPaymentFailed", { tenantId, vendorPaymentId: vendorPayment._id.toString(), reason: error.message, performedBy: userId || null });
    }

    return vendorPayment.toJSON();
  }

  /**
   * POST /api/v1/vendor-payments/{vendorPaymentId}/file — "Payment
   * Files... ACH, SEPA, ISO 20022, SWIFT MT, CSV — Generated
   * automatically." Real generation via services/paymentFileGenerators/,
   * archived through the same generic buffer-storage bridge every other
   * Finance PDF/statement artifact this session already uses.
   */
  static async generatePaymentFile(vendorPaymentIds, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { format } = data;
    if (!config.paymentFileFormats.includes(format)) throw new Error(`Invalid format "${format}".`);
    const generator = getPaymentFileGenerator(format);
    if (!generator) throw new Error(`Payment file format "${format}" is not supported — no generator is implemented for it.`);

    const vendorPayments = await VendorPaymentModel.find({ _id: { $in: vendorPaymentIds }, tenantId }).lean();
    if (vendorPayments.length === 0) throw new Error("No vendor payments found.");
    const currencies = new Set(vendorPayments.map((vp) => vp.currency));
    if (currencies.size > 1) throw new Error("All vendor payments in one file must share the same currency.");

    const bankAccount = await BankAccountModel.findOne({ _id: vendorPayments[0].bankAccountId, tenantId }).lean();
    if (!bankAccount) throw new Error("Paying bank account not found.");

    const vendorIds = [...new Set(vendorPayments.map((vp) => vp.vendorId.toString()))];
    const vendors = await VendorModel.find({ _id: { $in: vendorIds }, tenantId }).lean();
    const vendorById = new Map(vendors.map((v) => [v._id.toString(), v]));

    const batchNumber = await VendorPaymentService._generateCode(tenantId, "paymentFileNumber", "PMTFILE");
    const batchData = {
      batchNumber,
      paymentDate: vendorPayments[0].paymentDate,
      currency: vendorPayments[0].currency,
      originator: { name: bankAccount.accountName, taxId: bankAccount.bankAccountCode, routingNumber: bankAccount.routingNumber, accountNumber: bankAccount.accountNumberLast4, iban: bankAccount.iban, swiftBic: bankAccount.swiftCode, bankName: bankAccount.bankName },
      payments: vendorPayments.map((vp) => {
        const vendor = vendorById.get(vp.vendorId.toString());
        const vendorBankAccount = vp.vendorBankAccountId ? (vendor?.bankAccounts || []).find((b) => b._id.toString() === vp.vendorBankAccountId.toString()) : (vendor?.bankAccounts || []).find((b) => b.isPrimary);
        return { vendorName: vp.vendorName, vendorTaxId: null, amount: vp.totalAmount, reference: vp.vendorPaymentNumber, bankAccount: vendorBankAccount || {} };
      })
    };

    const result = generator.generate(batchData);
    const stored = await storeDocumentPdf({ tenantId, folder: "vendor-payment-files", filename: result.filename, buffer: Buffer.from(result.content, "utf8") });

    const fileGeneration = { format, generatedAt: new Date(), url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider };
    await VendorPaymentModel.updateMany({ _id: { $in: vendorPaymentIds }, tenantId }, { $set: { fileGeneration } });

    await AuditLogModel.create({ action: "finance.vendorpayment.generate_file", module: "Finance", resource: "VendorPayment", resourceId: vendorPaymentIds.join(","), userId: userId || null, tenantId, details: { format, count: vendorPayments.length } });

    return fileGeneration;
  }

  // ---- Payment Batches ----

  /**
   * POST /api/v1/payment-batches
   */
  static async createPaymentBatch(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { batchType, scheduledDate, vendorPaymentIds } = data;
    if (!config.paymentBatchTypes.includes(batchType)) throw new Error(`Invalid batchType "${batchType}".`);
    if (!Array.isArray(vendorPaymentIds) || vendorPaymentIds.length === 0) throw new Error("vendorPaymentIds must be a non-empty array.");

    const vendorPayments = await VendorPaymentModel.find({ _id: { $in: vendorPaymentIds }, tenantId }).lean();
    if (vendorPayments.length !== vendorPaymentIds.length) throw new Error("One or more vendor payments were not found.");
    const currencies = new Set(vendorPayments.map((vp) => vp.currency));
    if (currencies.size > 1) throw new Error("All vendor payments in one batch must share the same currency.");

    const totalAmount = roundCurrency(vendorPayments.reduce((sum, vp) => sum + vp.totalAmount, 0));
    const batchNumber = await VendorPaymentService._generateCode(tenantId, "paymentBatchNumber", config.paymentBatchNumberPrefix);

    const batch = await PaymentBatchModel.create({
      tenantId, batchNumber, batchType, scheduledDate: new Date(scheduledDate), vendorPaymentIds, totalAmount,
      currency: vendorPayments[0].currency, status: "Open", createdBy: userId || null, updatedBy: userId || null,
      timeline: [{ event: "PaymentBatchGenerated", description: `${batchType} batch of ${vendorPayments.length} payment(s) totaling ${totalAmount} ${vendorPayments[0].currency}.`, performedBy: userId || null }]
    });

    await VendorPaymentModel.updateMany({ _id: { $in: vendorPaymentIds }, tenantId }, { $set: { batchId: batch._id } });

    await AuditLogModel.create({ action: "finance.vendorpayment.create_batch", module: "Finance", resource: "PaymentBatch", resourceId: batch._id.toString(), userId: userId || null, tenantId, details: { batchNumber, batchType, totalAmount, count: vendorPayments.length } });
    publishEvent("PaymentBatchGenerated", { tenantId, batchId: batch._id.toString(), batchType, totalAmount, count: vendorPayments.length, performedBy: userId || null });

    return batch.toJSON();
  }

  static async listPaymentBatches(query, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    if (query.batchType) filter.batchType = query.batchType;
    return PaymentBatchModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async getPaymentBatchById(batchId, tenantId) {
    const batch = await PaymentBatchModel.findOne({ _id: batchId, tenantId }).lean();
    if (!batch) throw new Error("Payment batch not found.");
    return batch;
  }

  /**
   * POST /api/v1/payment-batches/{batchId}/execute — gap-fill: executes
   * every still-Scheduled vendor payment in the batch (skipping any
   * already Completed/Failed/Cancelled from an earlier partial run),
   * tracking real per-payment outcomes rather than treating the whole
   * batch as one atomic unit.
   */
  static async executePaymentBatch(batchId, tenantId, userId) {
    const batch = await PaymentBatchModel.findOne({ _id: batchId, tenantId });
    if (!batch) throw new Error("Payment batch not found.");
    if (batch.status === "Completed") throw new Error("Payment batch has already completed.");

    batch.status = "Executing";
    await batch.save();

    const vendorPayments = await VendorPaymentModel.find({ _id: { $in: batch.vendorPaymentIds }, tenantId, status: "Scheduled" }).lean();
    let failedCount = 0;
    for (const vp of vendorPayments) {
      const result = await VendorPaymentService.executeVendorPayment(vp._id, tenantId, userId);
      if (result.status === "Failed") failedCount += 1;
    }

    batch.status = failedCount > 0 ? "PartiallyFailed" : "Completed";
    batch.executedAt = new Date();
    batch.updatedBy = userId || null;
    batch.timeline.push({ event: "PaymentBatchExecuted", description: `Executed ${vendorPayments.length} payment(s), ${failedCount} failed.`, performedBy: userId || null });
    await batch.save();

    await AuditLogModel.create({ action: "finance.vendorpayment.execute_batch", module: "Finance", resource: "PaymentBatch", resourceId: batch._id.toString(), userId: userId || null, tenantId, details: { executed: vendorPayments.length, failed: failedCount } });

    return batch.toJSON();
  }

  // ---- Advance Payments ----

  /**
   * POST /api/v1/vendor-payments/advances — "Advance Payments... Purchase
   * Advances, Contract Advances, Deposit Payments, Prepayments — Linked
   * automatically to future invoices." Reuses `VendorCreditService.createCredit`
   * directly — the exact same auto-linking `AccountsPayableService.createPayable`
   * already consumes via `consumeAvailableCredits` (Part 6), so a future
   * payable for this vendor picks up this advance automatically with zero
   * new linking code needed here.
   */
  static async createVendorAdvance(data, tenantId, userId) {
    const { vendorId, bankAccountId, amount, currency, reason = "Vendor advance" } = data;
    if (!vendorId || !bankAccountId || !amount || !currency) throw new Error("vendorId, bankAccountId, amount, and currency are required.");

    const vendor = await VendorModel.findOne({ _id: vendorId, tenantId }).lean();
    if (!vendor) throw new Error("Vendor not found.");

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    const payment = await PaymentService.createPayment({
      paymentType: "Vendor", partyType: "vendor", partyId: vendorId, bankAccountId, amount, currency, paymentMethod: "Bank Transfer", reference: `ADVANCE-${vendor.name}`
    }, tenantId, userId);

    if (payment.status === "Failed") throw new Error(payment.failureReason || "Gateway payment failed while issuing the advance.");

    const credit = await VendorCreditService.createCredit({ vendorId, amount, currency, source: "Advance", sourceReferenceId: payment._id }, tenantId, userId);

    await AuditLogModel.create({ action: "finance.vendorpayment.create_advance", module: "Finance", resource: "VendorCredit", resourceId: credit._id.toString(), userId: userId || null, tenantId, details: { vendorId: vendorId.toString(), amount: roundCurrency(amount), paymentId: payment._id.toString() } });
    publishEvent("VendorAdvanceCreated", { tenantId, vendorId: vendorId.toString(), creditId: credit._id.toString(), paymentId: payment._id.toString(), amount: roundCurrency(amount), performedBy: userId || null });

    return { payment, credit };
  }

  /**
   * GET /api/v1/vendor-payments/suggest-timing — "Discount Optimization...
   * AI Payment Recommendation." Real LLM call via the same
   * `AIModelRouterService` Cash Forecasting (Part 15) and AI Matching
   * (Part 14) already use — fed real open payables and real bank balances,
   * advisory only, never auto-schedules anything.
   */
  static async suggestPaymentTiming(tenantId) {
    const [payables, bankAccounts] = await Promise.all([
      AccountsPayableModel.find({ tenantId, status: { $in: ["Open", "Partially Paid"] } }).select("vendorId vendorName invoiceNumber outstandingBalance currency dueDate").sort({ dueDate: 1 }).limit(100).lean(),
      BankAccountModel.find({ tenantId, status: "Active" }).select("bankAccountCode bankName currency balances").lean()
    ]);

    if (payables.length === 0) return { aiAvailable: true, recommendations: [], message: "No open payables to analyze." };

    const systemPrompt = "You are a vendor payment timing assistant for an ERP. Given a list of open payables (due dates, amounts) and the company's real bank account balances, recommend which payables to pay now vs. defer, considering cash availability and due dates. Respond with ONLY JSON: {\"recommendations\":[{\"payableId\":\"...\",\"recommendation\":\"PayNow\"|\"Defer\",\"reasoning\":\"...\"}]}. Advisory only — nothing will be executed automatically.";
    const userPrompt = `Open payables:\n${JSON.stringify(payables.map((p) => ({ id: p._id.toString(), vendor: p.vendorName, invoice: p.invoiceNumber, amount: p.outstandingBalance, currency: p.currency, dueDate: p.dueDate })))}\n\nBank accounts:\n${JSON.stringify(bankAccounts.map((b) => ({ code: b.bankAccountCode, currency: b.currency, available: b.balances.available })))}`;

    let llmResult;
    try {
      llmResult = await AIModelRouterService.route({ tenantId, category: "reasoning", messages: [{ role: "user", content: userPrompt }], tools: [], systemPrompt });
    } catch (error) {
      return { aiAvailable: false, recommendations: [], message: error.message };
    }

    let recommendations = [];
    try {
      const jsonText = (llmResult.content || "{}").replace(/^```json\s*|\s*```$/g, "").trim();
      const parsed = JSON.parse(jsonText);
      recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
    } catch {
      return { aiAvailable: true, recommendations: [], message: "The AI did not return a valid recommendation list." };
    }

    const validIds = new Set(payables.map((p) => p._id.toString()));
    const validRecommendations = recommendations.filter((r) => validIds.has(r.payableId));

    return { aiAvailable: true, recommendations: validRecommendations, provider: llmResult.provider, model: llmResult.model };
  }
}

export default VendorPaymentService;
