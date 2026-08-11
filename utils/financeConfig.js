import dotenv from 'dotenv';
import { getBookingConfig } from './bookingConfig.js';

dotenv.config();

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }
  return value;
};

const parseStringList = (value, fallback) => {
  const parsed = parseJson(value, fallback);
  if (!Array.isArray(parsed)) return fallback;
  return parsed.map((item) => `${item}`.trim()).filter(Boolean);
};

const parseBoolean = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
};

// Chart of Accounts configuration — Finance Module Part 2. Mirrors
// utils/bookingConfig.js's pattern (env override with JSON fallback) so
// account categories/types/statuses stay admin-configurable rather than
// hardcoded, per the doc's "AI Coding Rules: Configuration Driven".
//
// Tenant-only: currency support is delegated to getBookingConfig()'s
// supportedCurrencies/defaultCurrency rather than duplicating a second list
// that could drift out of sync — one currency catalog for the whole ERP.
export const getFinanceConfig = () => {
  const bookingConfig = getBookingConfig();
  return {
    // "Account Categories" — Assets, Liabilities, Equity, Revenue, Expense.
    accountCategories: parseStringList(process.env.ACCOUNT_CATEGORIES_JSON, ['Assets', 'Liabilities', 'Equity', 'Revenue', 'Expense']),
    // "Account Types" — Header, Posting, Control, Summary, System, Temporary, Virtual.
    accountTypes: parseStringList(process.env.ACCOUNT_TYPES_JSON, ['Header', 'Posting', 'Control', 'Summary', 'System', 'Temporary', 'Virtual']),
    // "Account Status" — Draft, Active, Inactive, Archived.
    accountStatuses: parseStringList(process.env.ACCOUNT_STATUSES_JSON, ['Draft', 'Active', 'Inactive', 'Archived']),
    defaultAccountStatus: process.env.DEFAULT_ACCOUNT_STATUS || 'Active',
    defaultAccountType: process.env.DEFAULT_ACCOUNT_TYPE || 'Posting',
    // Real, pre-existing bug fixed in Part 19 (Multi-Currency & FX):
    // bookingConfig.supportedCurrencies defaults to lowercase codes
    // ('usd','sar',...) for Booking's own convention (see
    // BookingController.js's own .toLowerCase() comparisons), but every
    // Finance document stores/compares currency as uppercase ISO 4217
    // ('USD') — confirmed via services/paymentFileGenerators, IBAN tests,
    // and every Finance model's own currency field. Left un-uppercased,
    // this silently broke 8 Joi schemas (BankAccount, BankReconciliation,
    // CashManagement, Expense x2, VendorPayment x2, CustomerCollection)
    // that validate `currency` directly against this list with no
    // `.uppercase()` mapping — a real "USD" would 400 there — plus 3
    // service-layer `config.supportedCurrencies.includes(currency)` checks
    // (CashManagementService, BankAccountService, ExpenseService) that
    // would reject it the same way. Uppercasing once here, at Finance's
    // own re-export of Booking's list, fixes every one of those call
    // sites without touching bookingConfig.js (Booking/GDS/Flight/Hotel
    // keep their own lowercase convention, untouched).
    supportedCurrencies: bookingConfig.supportedCurrencies.map((c) => c.toUpperCase()),
    defaultCurrency: bookingConfig.defaultCurrency.toUpperCase(),
    defaultPageSize: parseInt(process.env.DEFAULT_ACCOUNT_PAGE_SIZE || '20', 10),
    maxPageSize: parseInt(process.env.MAX_ACCOUNT_PAGE_SIZE || '100', 10),
    // "Hierarchy unlimited" — still capped to stop a bad parentId chain (or a
    // future bug) from recursing/looping without bound; configurable per
    // deployment rather than an unreviewable literal in the service.
    maxHierarchyDepth: parseInt(process.env.MAX_ACCOUNT_HIERARCHY_DEPTH || '10', 10),

    // General Journal — Finance Module Part 3.
    journalTypes: parseStringList(process.env.JOURNAL_TYPES_JSON, ['Manual', 'Automatic', 'Recurring', 'Adjustment', 'Opening Balance', 'Closing', 'Reversal', 'Exchange Rate Adjustment', 'Year End Closing']),
    journalStatuses: parseStringList(process.env.JOURNAL_STATUSES_JSON, ['Draft', 'Pending Approval', 'Approved', 'Posted', 'Rejected', 'Cancelled', 'Archived']),
    defaultJournalStatus: process.env.DEFAULT_JOURNAL_STATUS || 'Draft',
    defaultJournalType: process.env.DEFAULT_JOURNAL_TYPE || 'Manual',
    journalNumberPrefix: process.env.JOURNAL_NUMBER_PREFIX || 'JV',
    // "Approval Policies: No Approval / Single Approval / Dual Approval /
    // Finance Manager / CFO Approval / Amount Based Approval" — the spec
    // names policy *categories* but gives no concrete thresholds or role
    // names to wire against this codebase's actual RBAC keys. Implemented
    // now as a single configurable on/off gate (permission-checked via
    // finance.journal.approve) rather than guessing amount tiers or
    // inventing CFO/Finance-Manager role names that don't exist yet — the
    // model's approvals[] shape stays ready for a real multi-tier policy
    // engine once concrete rules are specified.
    journalApprovalRequired: parseBoolean(process.env.JOURNAL_APPROVAL_REQUIRED, true),

    // Financial Periods — shared by Journal (Part 3) and Ledger (Part 4)
    // posting validation.
    financialPeriodTypes: parseStringList(process.env.FINANCIAL_PERIOD_TYPES_JSON, ['Daily', 'Monthly', 'Quarterly', 'Yearly', 'Custom']),
    financialPeriodStatuses: parseStringList(process.env.FINANCIAL_PERIOD_STATUSES_JSON, ['Open', 'Closed', 'Locked']),

    // General Ledger — Finance Module Part 4.
    accountBalanceCacheTtlSeconds: parseInt(process.env.ACCOUNT_BALANCE_CACHE_TTL_SECONDS || '30', 10),
    trialBalanceCacheTtlSeconds: parseInt(process.env.TRIAL_BALANCE_CACHE_TTL_SECONDS || '30', 10),
    defaultLedgerPageSize: parseInt(process.env.DEFAULT_LEDGER_PAGE_SIZE || '50', 10),
    maxLedgerPageSize: parseInt(process.env.MAX_LEDGER_PAGE_SIZE || '200', 10),

    // Accounts Receivable — Finance Module Part 5.
    receivableStatuses: parseStringList(process.env.RECEIVABLE_STATUSES_JSON, ['Draft', 'Open', 'Partially Paid', 'Paid', 'Overdue', 'In Collection', 'Settled', 'Written Off', 'Cancelled', 'Disputed']),
    defaultReceivableStatus: process.env.DEFAULT_RECEIVABLE_STATUS || 'Open',
    // "Aging Buckets: Current, 1-30, 31-60, 61-90, 91-120, 120+ Days.
    // Configurable aging rules." `minDays`/`maxDays` are days *past due*
    // (dueDate to reference date); `null` means unbounded on that side.
    // JSON can't encode Infinity, hence null rather than -Infinity/Infinity.
    agingBuckets: parseJson(process.env.AR_AGING_BUCKETS_JSON, [
      { label: 'Current', minDays: null, maxDays: 0 },
      { label: '1-30 Days', minDays: 1, maxDays: 30 },
      { label: '31-60 Days', minDays: 31, maxDays: 60 },
      { label: '61-90 Days', minDays: 61, maxDays: 90 },
      { label: '91-120 Days', minDays: 91, maxDays: 120 },
      { label: '120+ Days', minDays: 121, maxDays: null }
    ]),
    // "Collection Workflow: Open -> Reminder -> Follow-up -> Supervisor
    // Review -> Collection Team -> Legal Action (Optional) -> Write Off."
    // Drives services/receivableOverdueScheduler.js's auto-escalation —
    // reaching the first stage also moves the receivable's own `status`
    // from Overdue to "In Collection" (fires CollectionStarted).
    collectionStages: parseJson(process.env.AR_COLLECTION_STAGES_JSON, [
      { stage: 'Reminder', afterDaysOverdue: 1 },
      { stage: 'Follow-up', afterDaysOverdue: 15 },
      { stage: 'Supervisor Review', afterDaysOverdue: 30 },
      { stage: 'Collection Team', afterDaysOverdue: 60 },
      { stage: 'Legal Action', afterDaysOverdue: 90 }
    ]),
    overdueCheckCron: process.env.AR_OVERDUE_CRON_SCHEDULE || '0 4 * * *',
    // "Credit Limit... Automatic validation before new invoices." A
    // customer with no configured limit (0/unset) is treated as
    // unlimited — same "unconfigured = permissive" stance as Financial
    // Periods. This flag lets a tenant disable the check entirely even
    // where limits ARE configured.
    creditLimitEnforcement: parseBoolean(process.env.AR_CREDIT_LIMIT_ENFORCEMENT, true),
    // Resolved by account code against the tenant's own Chart of Accounts
    // (Part 2) when posting a Write Off's ledger entries. Left unset by
    // default — write-off completes without a ledger posting until a
    // tenant configures both, rather than guessing which of their accounts
    // is "the" AR control / bad debt expense account.
    arControlAccountCode: process.env.AR_CONTROL_ACCOUNT_CODE || null,
    badDebtExpenseAccountCode: process.env.BAD_DEBT_EXPENSE_ACCOUNT_CODE || null,
    // Debit side of a payment-allocation journal, and credit side for the
    // overpayment portion — same "skip ledger posting until configured"
    // fallback as the two account codes above.
    defaultCashAccountCode: process.env.DEFAULT_CASH_ACCOUNT_CODE || null,
    customerCreditLiabilityAccountCode: process.env.CUSTOMER_CREDIT_LIABILITY_ACCOUNT_CODE || null,

    // Enterprise Payment Engine — Finance Module Part 7. Consolidates what
    // was previously two parallel minimal models (Part 5's customer-side
    // PaymentModel, Part 6's VendorPaymentModel) into one Payment Engine
    // that AR/AP call into as "specialized workflows," per the spec's own
    // explicit architecture review. Payments are independent transactions
    // (the request example has no customer/vendor reference at all) — the
    // party relationship, when known, is optional/informational
    // (partyType/partyId); the real relationship is established through
    // `allocations[]`.
    paymentTypes: parseStringList(process.env.PAYMENT_TYPES_JSON, ['Customer', 'Vendor', 'Employee', 'Refund', 'Advance', 'Deposit']),
    defaultPaymentType: process.env.DEFAULT_PAYMENT_TYPE || 'Customer',
    // Matches the spec's own wording exactly (including the space in
    // "Bank Transfer") since it's given as a literal request-example value.
    paymentMethods: parseStringList(process.env.PAYMENT_METHODS_JSON, ['Cash', 'Bank Transfer', 'Cheque', 'Credit Card', 'Debit Card', 'Wallet', 'UPI', 'Mobile Money', 'Crypto', 'Custom Method']),
    // "Manual" isn't in the spec's own Payment Gateways list but is the
    // real, honest gateway value for Cash/Cheque/Bank Transfer — money that
    // settles without an external API call. Only Stripe is actually wired
    // this pass (services/gateways/StripeGatewayAdapter.js); the rest exist
    // as configurable values with the adapter contract ready, not yet
    // implemented (services/gateways/BaseGatewayAdapter.js).
    gateways: parseStringList(process.env.PAYMENT_GATEWAYS_JSON, ['Manual', 'Stripe', 'PayPal', 'Square', 'AuthorizeNet', 'Adyen', 'Razorpay', 'Custom']),
    defaultGateway: process.env.DEFAULT_PAYMENT_GATEWAY || 'Manual',
    // Full Payment Lifecycle: Initiated -> Pending -> Authorized -> Captured
    // -> Allocated -> Settled -> Completed; alternates: Failed, Cancelled,
    // Expired, Voided, Refunded, Chargeback.
    paymentStatuses: parseStringList(process.env.PAYMENT_STATUSES_JSON, ['Initiated', 'Pending', 'Authorized', 'Captured', 'Allocated', 'Settled', 'Completed', 'Failed', 'Cancelled', 'Expired', 'Voided', 'Refunded', 'Chargeback']),
    defaultPaymentStatus: process.env.DEFAULT_PAYMENT_STATUS || 'Initiated',
    paymentNumberPrefix: process.env.PAYMENT_NUMBER_PREFIX || 'PAY',
    // "Supported Targets: Invoice, Accounts Receivable, Accounts Payable,
    // Expense, Payroll, Subscription, Booking, Visa, Travel." Every value
    // is accepted here for validation/documentation purposes, but
    // PaymentService.allocate only actually implements the ones with a
    // real, existing collection to validate against and a well-defined
    // effect (AccountsReceivable, AccountsPayable, Booking, Visa, Travel);
    // Invoice/Expense/Payroll/Subscription have no module in this codebase
    // yet and are rejected with a clear "not yet supported" error rather
    // than accepting an unvalidatable dangling reference.
    allocationTargetTypes: parseStringList(process.env.PAYMENT_ALLOCATION_TARGET_TYPES_JSON, ['AccountsReceivable', 'AccountsPayable', 'Booking', 'Visa', 'Travel', 'Invoice', 'Expense', 'Payroll', 'Subscription']),
    // Rule-based Fraud Detection thresholds — real, deterministic checks
    // (Duplicate Payment, Velocity Check, Amount Threshold), explicitly NOT
    // the spec's "AI advisory" risk scoring (Country Check and Blacklisted
    // Customer are skipped entirely: no country/IP field or blacklist flag
    // exists anywhere in this codebase to check against — see the Part 7
    // doc's Deferred section for why guessing one wasn't the right call).
    fraudDuplicateWindowMinutes: parseInt(process.env.FRAUD_DUPLICATE_WINDOW_MINUTES || '5', 10),
    fraudVelocityWindowMinutes: parseInt(process.env.FRAUD_VELOCITY_WINDOW_MINUTES || '60', 10),
    fraudVelocityMaxCount: parseInt(process.env.FRAUD_VELOCITY_MAX_COUNT || '5', 10),
    fraudAmountThreshold: parseInt(process.env.FRAUD_AMOUNT_THRESHOLD || '1000000', 10),

    // Accounts Payable — Finance Module Part 6. Unlike AR, the spec's own
    // Payable Lifecycle has an approval gate before a payable becomes
    // payable at all (Draft -> Pending Approval -> Approved -> Open), and
    // has no Overdue/In-Collection states — vendor aging is purely a live
    // read (Vendor Aging section), not a status a payable transitions
    // through, so unlike AR there is no overdue-scheduler for AP.
    payableStatuses: parseStringList(process.env.PAYABLE_STATUSES_JSON, ['Draft', 'Pending Approval', 'Approved', 'Open', 'Partially Paid', 'Paid', 'Settled', 'Cancelled', 'Disputed', 'Written Off']),
    defaultPayableStatus: process.env.DEFAULT_PAYABLE_STATUS || 'Draft',
    // "Payment Scheduling: Immediate, Scheduled Date, Weekly Batch, Monthly
    // Batch, Priority Payment, Urgent Payment." Modeled as a priority label
    // plus a scheduledDate on the payable (planning/visibility metadata for
    // the deferred Cash Flow Planning report) — not an automatic payment
    // execution engine (that would mean real bank-transfer integration,
    // far beyond this module's scope).
    paymentPriorities: parseStringList(process.env.AP_PAYMENT_PRIORITIES_JSON, ['Immediate', 'Scheduled', 'Priority', 'Urgent']),
    // Reuses AR's agingBuckets shape/config (utils/financeConfig.js
    // AR_AGING_BUCKETS_JSON) for "Vendor Aging" — one bucket definition for
    // the whole ERP rather than a near-duplicate AP-specific list.
    apControlAccountCode: process.env.AP_CONTROL_ACCOUNT_CODE || null,
    // Credit side when a payable is written off — forgiving a liability is
    // a gain, so this is an *income* account, the mirror-opposite of AR's
    // badDebtExpenseAccountCode (an expense).
    vendorWaiverIncomeAccountCode: process.env.VENDOR_WAIVER_INCOME_ACCOUNT_CODE || null,
    // Debit side for the excess when we overpay a vendor — an asset (money
    // the vendor owes back to us), the mirror-opposite of AR's
    // customerCreditLiabilityAccountCode (a liability).
    vendorAdvanceAssetAccountCode: process.env.VENDOR_ADVANCE_ASSET_ACCOUNT_CODE || null,

    // Enterprise Receipts — Finance Module Part 8. "A single payment may
    // generate one or multiple receipts, depending on business rules."
    receiptStatuses: parseStringList(process.env.RECEIPT_STATUSES_JSON, ['Draft', 'Generated', 'Issued', 'Delivered', 'Viewed', 'Archived', 'Cancelled', 'Reissued', 'Voided']),
    // POST /receipts generates immediately (no separate "submit" step was
    // contracted), so a new receipt starts past Draft.
    defaultReceiptStatus: process.env.DEFAULT_RECEIPT_STATUS || 'Generated',
    receiptTemplates: parseStringList(process.env.RECEIPT_TEMPLATES_JSON, ['Default', 'Retail', 'Corporate', 'Government', 'POS', 'Subscription', 'Travel', 'Visa', 'Custom']),
    defaultReceiptTemplate: process.env.DEFAULT_RECEIPT_TEMPLATE || 'Default',
    // "Delivery Channels: Email, SMS, WhatsApp, Print, Customer Portal,
    // Mobile App, Webhook." Only Email/SMS/WhatsApp/Webhook have a real
    // adapter this pass (services/delivery/) — Print needs no delivery
    // action (the PDF itself is the printable artifact); Customer
    // Portal/Mobile App have no such surface in this codebase to deliver
    // to. Requesting them is still accepted (real intent, honestly
    // recorded as unavailable) rather than silently dropped.
    deliveryMethods: parseStringList(process.env.RECEIPT_DELIVERY_METHODS_JSON, ['Email', 'SMS', 'WhatsApp', 'Print', 'CustomerPortal', 'MobileApp', 'Webhook']),
    receiptNumberPrefix: process.env.RECEIPT_NUMBER_PREFIX || 'RCT',
    // "Receipt Not Already Generated (Configurable)" — one receipt per
    // payment by default; a tenant can opt into multiple (batch/partial
    // receipting scenarios) by setting this true.
    receiptAllowMultiplePerPayment: parseBoolean(process.env.RECEIPT_ALLOW_MULTIPLE_PER_PAYMENT, false),
    // "Payment Verified" (Validation Rules) — this codebase has no separate
    // payment-verification step/flag (Part 7's Payment Engine IS the
    // verification: a payment reaching one of these statuses means the
    // gateway/manual capture already confirmed the funds), so "verified"
    // is treated as equivalent to the payment having reached one of these.
    receiptEligiblePaymentStatuses: parseStringList(process.env.RECEIPT_ELIGIBLE_PAYMENT_STATUSES_JSON, ['Captured', 'Allocated', 'Settled', 'Completed']),
    // Base URL the QR code / PDF download links point at — must be
    // explicitly configured for externally reachable links (mirrors
    // utils/storageConfig.js's own "never manufacture a provider URL" rule
    // for DOCUMENT_STORAGE_BASE_URL). Falls back to FRONTEND_URL, then to
    // the API's own local dev URL as a last resort so links still resolve
    // in local development without extra setup.
    receiptVerificationBaseUrl: process.env.RECEIPT_VERIFICATION_BASE_URL || process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || '7000'}`,

    // Enterprise Invoices — Finance Module Part 9. "An invoice is much more
    // than a PDF. It is a financial contract." AR generation happens at
    // Issue, not at Draft creation — see docs/05-api/07-finance-api.md
    // Part 9's own reasoning for why Draft/Approve/Issue are treated as
    // real, separate gated states (same interpretation already applied to
    // Journal's and AP's identical "Business Workflow lists many steps but
    // Lifecycle shows gated states" tension).
    invoiceTypes: parseStringList(process.env.INVOICE_TYPES_JSON, ['Commercial', 'Tax', 'Proforma', 'Recurring', 'Deposit', 'Installment', 'Credit', 'Debit', 'Subscription', 'Custom']),
    defaultInvoiceType: process.env.DEFAULT_INVOICE_TYPE || 'Commercial',
    invoiceStatuses: parseStringList(process.env.INVOICE_STATUSES_JSON, ['Draft', 'Pending Approval', 'Approved', 'Issued', 'Partially Paid', 'Paid', 'Closed', 'Cancelled', 'Voided', 'Written Off', 'Disputed']),
    defaultInvoiceStatus: process.env.DEFAULT_INVOICE_STATUS || 'Draft',
    // "Approval Workflow" — same single configurable gate as Journal's
    // JOURNAL_APPROVAL_REQUIRED, for the identical reason (no concrete
    // multi-tier policy/thresholds were given to build a real policy engine
    // against).
    invoiceApprovalRequired: parseBoolean(process.env.INVOICE_APPROVAL_REQUIRED, true),
    invoiceNumberPrefix: process.env.INVOICE_NUMBER_PREFIX || 'INV',
    // `taxCodes` (the original minimal tax-code -> rate lookup) moved
    // below to the Finance Module Part 20 (Tax Engine) config block,
    // where it now serves as that engine's own last-resort fallback —
    // see that block's own doc comment for why.
    // Fallback revenue account for the auto-generated AR creation journal
    // (Debit AR control / Credit Revenue) when an invoice doesn't specify
    // its own revenueAccountCode — same "skip ledger posting until
    // configured" fallback as every other optional account code in this
    // module if left unset.
    defaultRevenueAccountCode: process.env.DEFAULT_REVENUE_ACCOUNT_CODE || null,

    // Enterprise Credit Notes — Finance Module Part 10. A credit note always
    // originates against an already-issued Invoice ("Invoice Created ->
    // Customer Returns Item -> Credit Note Issued"). Lifecycle (Draft ->
    // Pending Approval -> Approved -> Issued -> Allocated -> Closed) gets the
    // same gated-states interpretation already applied identically to
    // Journal/AP/Invoice — see docs/05-api/07-finance-api.md Part 10.
    creditNoteReasons: parseStringList(process.env.CREDIT_NOTE_REASONS_JSON, ['Product Return', 'Service Cancellation', 'Pricing Correction', 'Tax Correction', 'Billing Error', 'Customer Goodwill', 'Other']),
    creditNoteStatuses: parseStringList(process.env.CREDIT_NOTE_STATUSES_JSON, ['Draft', 'Pending Approval', 'Approved', 'Issued', 'Allocated', 'Closed', 'Cancelled', 'Voided']),
    defaultCreditNoteStatus: process.env.DEFAULT_CREDIT_NOTE_STATUS || 'Draft',
    // Same single configurable approval gate as Journal/Invoice, for the
    // same reason (no concrete multi-tier policy was specified).
    creditNoteApprovalRequired: parseBoolean(process.env.CREDIT_NOTE_APPROVAL_REQUIRED, true),
    creditNoteNumberPrefix: process.env.CREDIT_NOTE_NUMBER_PREFIX || 'CN',
    // "Refund Eligibility... Approved Refund OR Customer Credit Wallet" —
    // the excess of a credit note beyond the invoice's still-outstanding
    // balance ALWAYS becomes real, immediately-usable Customer Credit
    // (there is no mechanism in this codebase to auto-execute a real bank
    // refund from a credit note — see CreditNoteService.allocateCreditNote's
    // doc comment). `disposition: 'Refund'` additionally fires a
    // `RefundRequested` event as a real signal for finance-ops / a future
    // Refund Management module to actually move money, rather than
    // fabricating an automatic payout this module has no way to perform.
    defaultCreditNoteDisposition: process.env.DEFAULT_CREDIT_NOTE_DISPOSITION || 'CustomerCredit',

    // Enterprise Debit Notes — Finance Module Part 11. The mirror-opposite
    // of Credit Notes: increases (rather than decreases) an existing
    // obligation — either a customer's Accounts Receivable or a vendor's
    // Accounts Payable (party-aware; see docs/05-api/07-finance-api.md
    // Part 11 for why this codebase's own reality — no VendorInvoice model
    // exists — required diverging from the spec's single generic
    // `invoiceId` request field). Same gated Draft -> ... -> Closed
    // lifecycle interpretation as Credit Note.
    debitNoteReasons: parseStringList(process.env.DEBIT_NOTE_REASONS_JSON, ['Additional Charges', 'Price Correction', 'Underbilling Adjustment', 'Late Fee', 'Returned Cheque Charge', 'Tax Adjustment', 'Shipping Correction', 'Contractual Penalty', 'Other']),
    debitNoteStatuses: parseStringList(process.env.DEBIT_NOTE_STATUSES_JSON, ['Draft', 'Pending Approval', 'Approved', 'Issued', 'Allocated', 'Closed', 'Cancelled', 'Voided']),
    defaultDebitNoteStatus: process.env.DEFAULT_DEBIT_NOTE_STATUS || 'Draft',
    // Same single configurable approval gate as Credit Note/Journal/Invoice.
    debitNoteApprovalRequired: parseBoolean(process.env.DEBIT_NOTE_APPROVAL_REQUIRED, true),
    debitNoteNumberPrefix: process.env.DEBIT_NOTE_NUMBER_PREFIX || 'DBN',

    // Enterprise Refund Management — Finance Module Part 12. "Credit Note is
    // an accounting document. Refund is the actual movement of money." A
    // Refund is independent from a Credit Note (see docs/05-api/07-finance-api.md
    // Part 12) — `createRefund` accepts either a direct `paymentId` (the
    // spec's own request example) or a `creditNoteId` link (the "Credit Note
    // + Refund" common case, redeeming the specific CustomerCredit that
    // Credit Note's own allocation already produced for
    // `disposition: "Refund"`).
    refundStatuses: parseStringList(process.env.REFUND_STATUSES_JSON, ['Requested', 'Under Review', 'Approved', 'Processing', 'Completed', 'Rejected', 'Cancelled', 'Failed']),
    defaultRefundStatus: process.env.DEFAULT_REFUND_STATUS || 'Requested',
    // "Approval Policies... Amount Based" — unlike every other module's
    // single on/off gate, Refund additionally supports a real amount
    // threshold: approval is required whenever EITHER the boolean gate is on
    // OR the refund amount reaches this threshold (0/unset = no
    // threshold-forced approval, matching this codebase's "0 = unconfigured"
    // convention already used for AR's creditLimit). Still not the full
    // CFO/Finance-Manager tiered role chain the spec lists — no such role
    // concept exists in this codebase beyond permission keys (same call
    // already made for Journal/Invoice/Credit Note/Debit Note's own
    // approval gates).
    refundApprovalRequired: parseBoolean(process.env.REFUND_APPROVAL_REQUIRED, true),
    refundApprovalAmountThreshold: parseInt(process.env.REFUND_APPROVAL_AMOUNT_THRESHOLD || '0', 10),
    refundNumberPrefix: process.env.REFUND_NUMBER_PREFIX || 'REF',
    // Matches the spec's own wording (including spaces), same convention as
    // paymentMethods' "Bank Transfer". "Original Gateway" is the real
    // default — refunding the same way the customer paid.
    refundMethods: parseStringList(process.env.REFUND_METHODS_JSON, ['Original Gateway', 'Bank Transfer', 'Cash', 'Cheque', 'Customer Wallet', 'Store Credit', 'Custom Method']),
    defaultRefundMethod: process.env.DEFAULT_REFUND_METHOD || 'Original Gateway',
    // "Time Window" eligibility check — days since the original payment's
    // transactionDate. 0 = unlimited (same "0 = unconfigured" convention as
    // creditLimit/refundApprovalAmountThreshold above).
    refundWindowDays: parseInt(process.env.REFUND_WINDOW_DAYS || '90', 10),
    // Fraud Risk scoring deliberately REUSES Part 7's own Payment fraud
    // thresholds (fraudDuplicateWindowMinutes etc. above) rather than
    // duplicating a parallel set of env vars — it's the identical
    // duplicate/velocity/amount-threshold shape applied to RefundModel
    // instead of PaymentModel, and the spec itself says "AI advisory only"
    // (RefundService.computeRefundRiskScore never blocks creation, purely
    // informs the approver — see docs/05-api/07-finance-api.md Part 12).

    // Chargebacks — grouped under Refund Management per this spec's own
    // Business Purpose list ("Chargebacks") and Domain Events
    // (ChargebackCreated/ChargebackResolved), modeled as its own small
    // collection (ChargebackModel) linked to the original Payment rather
    // than folded into Refund's own status enum — a chargeback is a
    // bank-forced event against the PAYMENT (Part 7's own paymentStatuses
    // already lists "Chargeback" as a payment status with no endpoint to
    // reach it until now), not an outcome of a Refund we ourselves
    // initiated. See docs/05-api/07-finance-api.md Part 12 for the full
    // reasoning on why "Chargeback" was deliberately NOT added to
    // refundStatuses above despite appearing in the spec's own Refund
    // Lifecycle diagram.
    chargebackStatuses: parseStringList(process.env.CHARGEBACK_STATUSES_JSON, ['Open', 'Evidence Submitted', 'Under Appeal', 'Won', 'Lost']),
    defaultChargebackStatus: process.env.DEFAULT_CHARGEBACK_STATUS || 'Open',
    chargebackNumberPrefix: process.env.CHARGEBACK_NUMBER_PREFIX || 'CB',
    // Debit side when a chargeback is finally lost — a real, distinct
    // economic event (a bank-forced loss, sometimes with an extra dispute
    // fee) from a normal customer-initiated refund, so it gets its own
    // optional account code rather than reusing defaultRevenueAccountCode.
    // Same "skip ledger posting until configured" fallback as every other
    // optional account code in this module.
    chargebackLossExpenseAccountCode: process.env.CHARGEBACK_LOSS_EXPENSE_ACCOUNT_CODE || null,

    // Enterprise Bank Accounts — Finance Module Part 13. "A bank account is
    // not just a database record. It is the source of truth for cash
    // movement." Tenant-only per §3 of the standing master instructions —
    // the spec's own "Branch Bank Accounts"/"Branch Match"/`branchId`
    // request field are dropped entirely; see docs/05-api/07-finance-api.md
    // Part 13 for the full removal rationale.
    bankAccountTypes: parseStringList(process.env.BANK_ACCOUNT_TYPES_JSON, ['Operating', 'Savings', 'Settlement', 'Payroll', 'Escrow', 'Petty Cash', 'Treasury', 'Virtual Account', 'Custom']),
    // Lifecycle: Pending Verification -> Verified -> Active (== the spec's
    // own "Operational" — see docs/05-api/07-finance-api.md Part 13 for why
    // those two are treated as one real state, not two). "Created" isn't
    // used as a resting status (see same doc) — a brand-new account starts
    // straight in "Pending Verification"; `BankAccountCreated` still fires
    // at that same moment regardless of which status string is assigned.
    bankAccountStatuses: parseStringList(process.env.BANK_ACCOUNT_STATUSES_JSON, ['Pending Verification', 'Verified', 'Active', 'Frozen', 'Suspended', 'Closed', 'Archived']),
    defaultBankAccountStatus: process.env.DEFAULT_BANK_ACCOUNT_STATUS || 'Pending Verification',
    // Same single configurable approval gate as every other module's — no
    // concrete multi-tier "Create/Close/Freeze/Reopen/Change-Authorized-Users"
    // policy matrix was specified to build a real per-action policy engine
    // against.
    bankAccountApprovalRequired: parseBoolean(process.env.BANK_ACCOUNT_APPROVAL_REQUIRED, true),
    bankAccountCodePrefix: process.env.BANK_ACCOUNT_CODE_PREFIX || 'BA',
    // Debit/credit counterpart for a manual balance adjustment
    // (BankAccountService.manualAdjustment) when the bank account's own
    // linked `glAccountCode` is set — e.g. entering an opening balance or a
    // bank fee. Same "skip ledger posting until configured" fallback as
    // every other optional account code in this module.
    bankAdjustmentSuspenseAccountCode: process.env.BANK_ADJUSTMENT_SUSPENSE_ACCOUNT_CODE || null,

    // Enterprise Bank Reconciliation — Finance Module Part 14. "Does the
    // money in our ERP match the money shown by the bank?" Tenant-only per
    // §3 of the standing master instructions — the spec's own "Branch
    // Match" validation rule is dropped entirely.
    //
    // Real resting states only — "Statement Imported" and "Auto Matching"
    // are transient/momentary (recorded in the session's own timeline, not
    // as a lingering `status`) for the identical reason Part 13's own
    // "Created" wasn't kept as a resting bank-account status: a freshly
    // imported statement runs auto-matching synchronously as part of the
    // same import call (the spec's own Business Workflow lists "Auto
    // Match -> Generate Exceptions" as steps WITHIN the import endpoint,
    // before `StatementImported` even publishes) and lands directly on
    // "Manual Review" — see docs/05-api/07-finance-api.md Part 14.
    // "Reopened" is likewise an action (`reopenReconciliation`), not a
    // resting status — reopening moves a session back to "Manual Review".
    reconciliationStatuses: parseStringList(process.env.RECONCILIATION_STATUSES_JSON, ['Manual Review', 'Approved', 'Completed', 'Rejected', 'Archived']),
    defaultReconciliationStatus: process.env.DEFAULT_RECONCILIATION_STATUS || 'Manual Review',
    reconciliationApprovalRequired: parseBoolean(process.env.RECONCILIATION_APPROVAL_REQUIRED, true),
    reconciliationNumberPrefix: process.env.RECONCILIATION_NUMBER_PREFIX || 'REC',
    // "Supported Formats." Deliberately excludes "Open Banking API" — no
    // live Open Banking/aggregator integration (Plaid, TrueLayer, ...)
    // exists anywhere in this codebase, and listing it here as if
    // implemented would misrepresent what this module actually does (same
    // discipline `services/gateways/index.js` already applies to
    // not-yet-implemented payment gateways). "Custom" accepts a
    // tenant-pre-shaped JSON transaction array directly, for banks whose
    // own export tooling a tenant has already converted themselves.
    reconciliationImportFormats: parseStringList(process.env.RECONCILIATION_IMPORT_FORMATS_JSON, ['CSV', 'Excel', 'MT940', 'CAMT.053', 'OFX', 'Custom']),
    reconciliationImportMaxFileSizeBytes: parseInt(process.env.RECONCILIATION_IMPORT_MAX_FILE_SIZE_BYTES || `${10 * 1024 * 1024}`, 10),
    // "Tolerance Window" — how many days apart a statement line and an ERP
    // BankTransactionModel entry may still be considered a date match, and
    // how many days before/after the statement date to even pull ERP
    // transactions as match candidates in the first place.
    reconciliationDateToleranceDays: parseInt(process.env.RECONCILIATION_DATE_TOLERANCE_DAYS || '3', 10),
    reconciliationLookbackDays: parseInt(process.env.RECONCILIATION_LOOKBACK_DAYS || '7', 10),
    // Absolute currency-unit tolerance for an amount to still count as a
    // match (covers small bank-fee/rounding differences) — a flat amount
    // rather than a percentage, avoiding float-precision debates over what
    // "0.5%" means for a very large or very small transaction.
    reconciliationAmountTolerance: parseFloat(process.env.RECONCILIATION_AMOUNT_TOLERANCE || '1'),
    // "Weighted scoring supported." Must sum to 1 —
    // BankReconciliationService normalizes if a tenant's override doesn't.
    reconciliationMatchWeights: parseJson(process.env.RECONCILIATION_MATCH_WEIGHTS_JSON, { amount: 0.5, date: 0.3, reference: 0.2 }),
    // A statement/ERP pair at or above this weighted score (0-100)
    // auto-matches; below it, the pair is left for manual review (or an AI
    // suggestion — see "AI Matching" below).
    reconciliationAutoMatchThreshold: parseInt(process.env.RECONCILIATION_AUTO_MATCH_THRESHOLD || '85', 10),

    // Enterprise Cash Management — Finance Module Part 15. "Cash != Bank."
    // Deliberately its own separate model family (CashLocationModel/
    // CashTransactionModel), NOT a specialization of Part 13's
    // BankAccountModel even though its own `accountType` enum already
    // listed "Petty Cash" — the user's own spec explicitly states Cash and
    // Bank "are managed separately because they have different business
    // rules, risks, controls, and audit requirements," settling the open
    // design question Part 14's own doc note deliberately left for this
    // Part to resolve on its merits. Tenant-only per §3 of the standing
    // master instructions — the spec's own "Branch Vaults"/"Validate
    // Branch"/`branchId` request field/"Branch Isolation"/"Branch cash
    // demand" are all dropped; see docs/05-api/07-finance-api.md Part 15.
    cashLocationTypes: parseStringList(process.env.CASH_LOCATION_TYPES_JSON, ['Cash Drawer', 'Petty Cash', 'Cash Counter', 'Safe', 'Vault', 'POS Till', 'Custom']),
    // Real resting states only — "Location Created"/"Operational" collapse
    // into "Opened" (same reasoning as Part 13's Bank Account "Created"/
    // "Active"=="Operational" collapses); "Cash Transactions"/"Cash Count"/
    // "Balanced"/"Shortage"/"Overage" from the spec's own Lifecycle diagram
    // are NOT location statuses here — they describe the recurring cash-
    // count CYCLE, modeled as its own separate, repeatable CashCountModel
    // resource, not a status the location itself permanently sits in (a
    // location isn't "in shortage" forever — a specific count reveals one,
    // then it gets resolved). See docs/05-api/07-finance-api.md Part 15.
    cashLocationStatuses: parseStringList(process.env.CASH_LOCATION_STATUSES_JSON, ['Opened', 'Closed', 'Archived']),
    defaultCashLocationStatus: process.env.DEFAULT_CASH_LOCATION_STATUS || 'Opened',
    cashLocationCodePrefix: process.env.CASH_LOCATION_CODE_PREFIX || 'CSH',
    // "Safe & Vault... Cash Deposit, Cash Withdrawal" are implemented as
    // ordinary Cash Transfers where one side is a Safe/Vault-typed
    // location — not separate deposit/withdrawal endpoints duplicating the
    // same real money-movement mechanism.
    cashTransferStatuses: parseStringList(process.env.CASH_TRANSFER_STATUSES_JSON, ['Pending Approval', 'Approved', 'Completed', 'Rejected', 'Cancelled']),
    defaultCashTransferStatus: process.env.DEFAULT_CASH_TRANSFER_STATUS || 'Pending Approval',
    cashTransferApprovalRequired: parseBoolean(process.env.CASH_TRANSFER_APPROVAL_REQUIRED, true),
    cashTransferNumberPrefix: process.env.CASH_TRANSFER_NUMBER_PREFIX || 'CTR',
    // "Dual Control... Dual Authorization... Optional" — a transfer
    // touching a location with `dualAuthorizationRequired: true` needs two
    // DIFFERENT users' approvals before it executes, not the single gate
    // every other module's approval flag provides.
    cashCountTypes: parseStringList(process.env.CASH_COUNT_TYPES_JSON, ['Scheduled', 'Surprise', 'Daily Closing', 'Weekly', 'Monthly', 'Manual']),
    cashCountNumberPrefix: process.env.CASH_COUNT_NUMBER_PREFIX || 'CNT',
    // A count's variance is "None" (Balanced) only when the absolute
    // difference is at/under this tolerance — 0 (default) requires an
    // exact match, same "0 = unconfigured/strict" convention available
    // elsewhere, but a tenant may allow a small de-minimis rounding gap.
    cashCountVarianceTolerance: parseFloat(process.env.CASH_COUNT_VARIANCE_TOLERANCE || '0'),
    pettyCashAdvanceNumberPrefix: process.env.PETTY_CASH_ADVANCE_NUMBER_PREFIX || 'PCA',
    // Debit side when a cash count reveals a real shortage (money is
    // genuinely missing) — an expense; credit side when it reveals an
    // overage (unexplained extra cash) — income. Same "skip ledger posting
    // until configured" fallback as every other optional account code in
    // this module.
    cashShortageExpenseAccountCode: process.env.CASH_SHORTAGE_EXPENSE_ACCOUNT_CODE || null,
    cashOverageIncomeAccountCode: process.env.CASH_OVERAGE_INCOME_ACCOUNT_CODE || null,

    // Enterprise Expense Management — Finance Module Part 16. "The expense
    // is not the payment. The reimbursement is the financial event." —
    // `paymentMethod` (how the employee originally paid) and
    // `reimbursementMethod` (how the company pays them back) are two
    // deliberately separate fields on ExpenseModel, not one. Tenant-only
    // per §3 of the standing master instructions — the spec's own "Branch
    // Match"/"Branch Isolation"/`branch` query param are dropped; see
    // docs/05-api/07-finance-api.md Part 16.
    expenseCategories: parseStringList(process.env.EXPENSE_CATEGORIES_JSON, ['Travel', 'Visa', 'Meals', 'Accommodation', 'Fuel', 'Office Supplies', 'Marketing', 'Training', 'Utilities', 'IT Equipment', 'Custom']),
    // Real resting states only — "Manager Review"/"Finance Review" from
    // the spec's own Lifecycle diagram collapse into one "Under Review"
    // status; which levels are actually still pending is tracked by
    // `requiredApprovalLevels`/`approvals[]` on the expense itself (same
    // ordered-multi-approval array design already proven by Part 15's
    // CashTransferModel), not by a separate status string per level.
    expenseStatuses: parseStringList(process.env.EXPENSE_STATUSES_JSON, ['Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected', 'Cancelled', 'Returned', 'Reimbursed', 'Closed']),
    defaultExpenseStatus: process.env.DEFAULT_EXPENSE_STATUS || 'Draft',
    expenseNumberPrefix: process.env.EXPENSE_NUMBER_PREFIX || 'EXP',
    // How the employee originally paid — "Corporate Cards... Company
    // Credit Cards, Debit Cards, Fuel Cards, Virtual Cards" plus the
    // ordinary personal-payment cases.
    expensePaymentMethods: parseStringList(process.env.EXPENSE_PAYMENT_METHODS_JSON, ['Personal Cash', 'Personal Card', 'Corporate Card', 'Corporate Debit Card', 'Fuel Card', 'Virtual Card']),
    // "Reimbursement... Supports: Payroll, Bank Transfer, Cash, Petty
    // Cash, Wallet Credit, Accounts Payable." Payroll and Wallet Credit
    // are deliberately excluded — no Payroll module and no employee-wallet
    // concept exist anywhere in this codebase (same "don't list an
    // unimplemented integration as if it were real" discipline Part 14
    // already applied to excluding "Open Banking API").
    reimbursementMethods: parseStringList(process.env.EXPENSE_REIMBURSEMENT_METHODS_JSON, ['Bank Transfer', 'Cash', 'Petty Cash', 'Accounts Payable']),
    // "Approval Policies... Manager, Department Head, Finance, CFO,
    // Amount Based, Multi-level Approval." Manager review is always
    // required; Finance/CFO are added when the expense amount reaches
    // these thresholds (0 = that tier never required beyond Manager) — a
    // real, concrete amount-based policy, unlike every earlier module's
    // single on/off gate (those had no concrete thresholds to build
    // against; this spec's own two-step Manager->Finance Lifecycle gives
    // real structure to build a genuine one).
    expenseApprovalThresholdFinance: parseFloat(process.env.EXPENSE_APPROVAL_THRESHOLD_FINANCE || '500'),
    expenseApprovalThresholdCFO: parseFloat(process.env.EXPENSE_APPROVAL_THRESHOLD_CFO || '5000'),
    // "Receipt Management" — below this amount, a receipt isn't mandatory
    // (a real, common real-world policy threshold); 0 = always required.
    expenseReceiptRequiredAboveAmount: parseFloat(process.env.EXPENSE_RECEIPT_REQUIRED_ABOVE_AMOUNT || '25'),
    // Optional per-category ceiling — {} (default) means no cap configured.
    expenseMaxAmountPerCategory: parseJson(process.env.EXPENSE_MAX_AMOUNT_PER_CATEGORY_JSON, {}),
    // "Budget Validation... Budget rules configurable." Block hard-stops
    // submission over budget; Warn allows it through but flags
    // `budgetExceeded` and fires `BudgetExceeded` for a human to see.
    expenseBudgetEnforcement: (process.env.EXPENSE_BUDGET_ENFORCEMENT || 'Warn'),
    // "Per Diem & Mileage... Country Rules... Mileage Rate... Vehicle
    // Type." Real, configurable rate tables — the claimed amount is
    // COMPUTED from these when per diem/mileage applies, never
    // caller-supplied directly for those line items.
    perDiemRatesByCountry: parseJson(process.env.EXPENSE_PER_DIEM_RATES_JSON, { Default: 50 }),
    mileageRatesByVehicleType: parseJson(process.env.EXPENSE_MILEAGE_RATES_JSON, { Car: 0.5, Motorcycle: 0.25, Bicycle: 0.1 }),
    mileageDistanceUnit: process.env.EXPENSE_MILEAGE_DISTANCE_UNIT || 'km',
    expenseReceiptMaxFileSizeBytes: parseInt(process.env.EXPENSE_RECEIPT_MAX_FILE_SIZE_BYTES || `${10 * 1024 * 1024}`, 10),
    // "OCR Extraction" — real (tesseract.js for images, the already-
    // installed pdf-parse for text-based PDFs), not the Visa domain's own
    // honestly-stubbed "queued to an external processor we don't have"
    // pattern (services/DocumentVerificationService.js). Disableable per
    // tenant since OCR is CPU-work, not a hard requirement to file a claim.
    expenseOcrEnabled: parseBoolean(process.env.EXPENSE_OCR_ENABLED, true),
    // Debit side of the reimbursement journal for the Bank Transfer/Cash/
    // Petty Cash methods (the paying Bank Account's/Cash Location's own
    // `glAccountCode` is the credit side) — "Accounts Payable" reuses
    // AccountsPayableService.createPayable's own existing journal logic
    // directly instead, so this account code is only consulted for the
    // other three methods. Same "skip posting until configured" fallback
    // as every other optional account code in this module.
    expenseReimbursementExpenseAccountCode: process.env.EXPENSE_REIMBURSEMENT_EXPENSE_ACCOUNT_CODE || null,

    // Enterprise Vendor Payments — Finance Module Part 17. "Payment Engine
    // moves money. Vendor Payment Platform decides which vendor, which
    // invoices, which bank account, which date, which approval, which
    // payment file." `VendorPaymentService.executeVendorPayment` never
    // moves money itself — it delegates entirely to the already-real
    // `PaymentService.createPayment` (Part 7) + `AccountsPayableService.allocatePayment`
    // (Part 6), the literal architectural distinction this Part opens
    // with. Tenant-only per §3 of the standing master instructions — the
    // spec's own "Branch Match"/"Branch Isolation"/`branch` query param
    // are dropped; see docs/05-api/07-finance-api.md Part 17.
    //
    // Real resting states only — "Proposed" and "Pending Approval" from
    // the spec's own Lifecycle diagram collapse into one: a freshly
    // created proposal simply sits in "Proposed" awaiting approval; there
    // is no distinguishing trigger between "just proposed" and "pending
    // approval" (same collapse already applied to Bank Reconciliation's
    // "Statement Imported"/"Auto Matching" and Cash Management's own
    // transient states this session).
    vendorPaymentStatuses: parseStringList(process.env.VENDOR_PAYMENT_STATUSES_JSON, ['Proposed', 'Approved', 'Scheduled', 'Executing', 'Completed', 'Rejected', 'Cancelled', 'Failed', 'On Hold']),
    defaultVendorPaymentStatus: process.env.DEFAULT_VENDOR_PAYMENT_STATUS || 'Proposed',
    vendorPaymentNumberPrefix: process.env.VENDOR_PAYMENT_NUMBER_PREFIX || 'VPY',
    vendorPaymentApprovalRequired: parseBoolean(process.env.VENDOR_PAYMENT_APPROVAL_REQUIRED, true),
    // "Dual Approval" (Security section) — reuses the exact same
    // ordered/count-based multi-approval design Part 15's own
    // CashTransferModel dual authorization already proved: at/above this
    // amount, two DIFFERENT users must approve, not one (0 = never
    // required beyond the single default gate).
    vendorPaymentDualApprovalThreshold: parseFloat(process.env.VENDOR_PAYMENT_DUAL_APPROVAL_THRESHOLD || '0'),
    paymentBatchTypes: parseStringList(process.env.PAYMENT_BATCH_TYPES_JSON, ['Daily', 'Weekly', 'Monthly', 'Urgent', 'Custom']),
    paymentBatchNumberPrefix: process.env.PAYMENT_BATCH_NUMBER_PREFIX || 'BATCH',
    // "Payment Files... Generated automatically." Real generators for all
    // five (services/paymentFileGenerators/, the mirror-opposite of Part
    // 14's real statement PARSERS) — "ISO 20022" and "SEPA" share the same
    // real pain.001 XML generator (SEPA Credit Transfer IS a specific
    // ISO 20022 usage/scheme), not two parallel implementations.
    paymentFileFormats: parseStringList(process.env.PAYMENT_FILE_FORMATS_JSON, ['CSV', 'ACH', 'SEPA', 'ISO 20022', 'SWIFT MT']),
    // "Payment Scheduling... Business Day." Real Sat/Sun rolling; "Holiday
    // Rules" is honestly NOT implemented — no holiday-calendar data exists
    // anywhere in this codebase (same category of deferral as Part 14's
    // excluded Open Banking API).
    businessDaySkipWeekends: parseBoolean(process.env.VENDOR_PAYMENT_BUSINESS_DAY_SKIP_WEEKENDS, true),

    // Enterprise Customer Payments — Finance Module Part 18. "The Customer
    // Collection Platform manages the collection strategy. The Payment
    // Engine performs the actual payment." `CustomerCollectionService.collect`
    // never moves money itself — it delegates entirely to the already-real
    // `PaymentService.createPayment` (Part 7) + `AccountsReceivableService.allocatePayment`
    // (Part 5), the exact mirror of Part 17's own "Payment Engine executes,
    // orchestration layer decides" distinction on the AP side. Tenant-only
    // per §3 of the standing master instructions — the spec's own "Branch
    // Match"/"Branch Isolation"/`branch` query param are dropped; see
    // docs/05-api/07-finance-api.md Part 18.
    //
    // Real resting states only. "Payment Requested" and "Reminder Sent"
    // from the spec's own Lifecycle diagram collapse into the collection
    // simply starting in "Requested" — a reminder is a side effect logged
    // on the collection (via CollectionReminderModel), not a distinct
    // resting status (same collapse discipline as every prior Part).
    customerCollectionStatuses: parseStringList(process.env.CUSTOMER_COLLECTION_STATUSES_JSON, ['Requested', 'Partially Collected', 'Collected', 'Overdue', 'Payment Failed', 'Disputed', 'Written Off', 'Cancelled', 'Closed']),
    defaultCustomerCollectionStatus: process.env.DEFAULT_CUSTOMER_COLLECTION_STATUS || 'Requested',
    customerCollectionNumberPrefix: process.env.CUSTOMER_COLLECTION_NUMBER_PREFIX || 'COL',
    // "Installment Plans... Weekly, Monthly, Quarterly, Custom Schedule."
    installmentFrequencies: parseStringList(process.env.INSTALLMENT_FREQUENCIES_JSON, ['Weekly', 'Monthly', 'Quarterly', 'Custom']),
    // "Advance Customer Deposits... Booking Deposit, Visa Deposit, Project
    // Deposit, Subscription Deposit." Reuses `CustomerCreditService.createCredit`
    // directly (Part 10) — the same auto-linking `AccountsReceivableService.createReceivable`
    // already consumes via `consumeAvailableCredits`, mirroring Part 17's
    // own `createVendorAdvance` reuse of `VendorCreditService` on the AP
    // side. No dedicated deposit-source list existed before this Part;
    // sourced against CustomerCredit's own free-text `source` field.
    customerDepositSourceTypes: parseStringList(process.env.CUSTOMER_DEPOSIT_SOURCE_TYPES_JSON, ['Booking Deposit', 'Visa Deposit', 'Project Deposit', 'Subscription Deposit']),
    // "Payment Links... One-Time Link, Expiring Link, QR Payment." Real
    // token + QR reuse of `services/ReceiptQrService.js` (Part 8) — the
    // exact same `crypto.randomBytes(24)` unguessable-token pattern and
    // `qrcode` PNG generation, not a parallel implementation. Reuses
    // Part 8's own `receiptVerificationBaseUrl` as the base for the public
    // link too, rather than a second base-URL env var for the same host.
    paymentLinkExpiryHours: parseInt(process.env.PAYMENT_LINK_EXPIRY_HOURS || '168', 10),
    // "Reminder Engine... Email, SMS, WhatsApp, Push Notification, Customer
    // Portal... Configurable Schedule." Reuses Part 8's own `deliveryMethods`
    // list and real `services/delivery/` adapters — Push Notification/
    // Customer Portal have no real surface in this codebase (same honest
    // "NotConfigured" treatment Part 8 already applies to those two). Real
    // sending happens two ways: (1) `services/customerCollectionScheduler.js`
    // marks a Collection Overdue against its own paymentDueDate, on this
    // cron; (2) a new `NotificationRequested` listener in
    // `CustomerCollectionService` finally consumes the dunning escalation
    // events `receivableOverdueScheduler.js` (Part 5) has published all
    // along with zero prior listener — "Dunning Process... Friendly
    // Reminder, Second Reminder, Final Notice, Late Fee, Collection Hold,
    // Legal Escalation" reuses AR's own `collectionStages` (Part 5) as the
    // single source of escalation truth for the whole ERP, rather than a
    // second, parallel stage list that could drift out of sync.
    customerCollectionOverdueCron: process.env.CUSTOMER_COLLECTION_OVERDUE_CRON_SCHEDULE || '0 9 * * *',
    // "Late Fee" — a configurable percentage of the outstanding balance,
    // applied at most once per collection (idempotent via `lateFeeAppliedAt`)
    // once the configured dunning stage is reached. 0 = disabled (no late
    // fee behavior unless a tenant explicitly opts in).
    lateFeePercent: parseFloat(process.env.CUSTOMER_COLLECTION_LATE_FEE_PERCENT || '0'),
    lateFeeStage: process.env.CUSTOMER_COLLECTION_LATE_FEE_STAGE || 'Collection Team',

    // Enterprise Multi-Currency & Foreign Exchange — Finance Module Part
    // 19. "One business transaction can involve multiple currencies
    // simultaneously. The ERP must preserve all of them correctly for
    // accounting and reporting." Tenant-only per the standing master
    // instructions — the spec names no branch language this Part, but the
    // same rule applies regardless.
    //
    // Real resting states only. "Currency Created -> Rate Imported ->
    // Validated -> Activated -> Used" is the pipeline TO activation, not
    // four separate resting states before it — a currency simply starts
    // Draft and becomes Active; "Rate Imported"/"Validated"/"Used" have no
    // distinguishing trigger of their own (same collapse discipline as
    // every prior Part).
    currencyStatuses: parseStringList(process.env.CURRENCY_STATUSES_JSON, ['Draft', 'Active', 'Suspended', 'Archived']),
    defaultCurrencyStatus: process.env.DEFAULT_CURRENCY_STATUS || 'Draft',
    // "Approval Workflow" — same single configurable gate as Journal's/
    // Invoice's own, for the identical reason (no concrete multi-tier
    // policy was given to build a real policy engine against).
    currencyApprovalRequired: parseBoolean(process.env.CURRENCY_APPROVAL_REQUIRED, false),
    // "Conversion Engine... Spot Rate, Historical Rate, Average Rate,
    // Month-End Rate, Custom Rate."
    exchangeRateTypes: parseStringList(process.env.EXCHANGE_RATE_TYPES_JSON, ['Spot', 'Historical', 'Average', 'MonthEnd', 'Custom']),
    defaultExchangeRateType: process.env.DEFAULT_EXCHANGE_RATE_TYPE || 'Spot',
    // "Rate Providers... Central Bank, Commercial Bank, Open Exchange
    // APIs, Manual Entry, Custom Provider. Priority configurable." Only
    // "Manual" and "OpenExchangeAPI" have a real code path in this pass —
    // Central Bank/Commercial Bank/Custom Provider integrations need real
    // credentials/contracts this codebase doesn't have (same category of
    // deferral as every other Part's excluded external integrations); a
    // rate can still be recorded under those provider names manually.
    rateProviders: parseStringList(process.env.RATE_PROVIDERS_JSON, ['CentralBank', 'CommercialBank', 'OpenExchangeAPI', 'Manual', 'Custom']),
    defaultRateProvider: process.env.DEFAULT_RATE_PROVIDER || 'Manual',
    // Real HTTP integration (services/CurrencyService.js importRatesFromProvider,
    // global fetch — no SDK needed) against openexchangerates.org's real
    // API — honestly "not configured" (never faked) when no app id is set.
    openExchangeRatesAppId: process.env.OPEN_EXCHANGE_RATES_APP_ID || null,
    openExchangeRatesBaseUrl: process.env.OPEN_EXCHANGE_RATES_BASE_URL || 'https://openexchangerates.org/api',
    // "Revaluation... Bank Accounts, Accounts Receivable, Accounts
    // Payable, Loans, Investments." Loans/Investments have no module
    // anywhere in this codebase to revalue — same "deferred, no concrete
    // target to build against" treatment as every other Part's excluded
    // pieces; the three real targets read live balances directly off
    // their own already-shipped models (BankAccountModel/
    // AccountsReceivableModel/AccountsPayableModel) with no schema
    // changes needed to any of them.
    fxRevaluationTargets: parseStringList(process.env.FX_REVALUATION_TARGETS_JSON, ['BankAccount', 'AccountsReceivable', 'AccountsPayable']),
    fxRevaluationCron: process.env.FX_REVALUATION_CRON_SCHEDULE || '0 1 1 * *',
    // FX Gain/Loss journal posting — skipped until both are configured,
    // same "skip ledger posting until configured" fallback used for every
    // other optional account-code pair in this module (e.g. AR's own
    // arControlAccountCode/badDebtExpenseAccountCode).
    fxGainAccountCode: process.env.FX_GAIN_ACCOUNT_CODE || null,
    fxLossAccountCode: process.env.FX_LOSS_ACCOUNT_CODE || null,

    // Enterprise Tax Engine — Finance Module Part 20. "A real ERP never
    // hardcodes tax logic. It uses a centralized Tax Engine." Replaces
    // Invoice/Credit Note/Debit Note's own static `taxCodes` lookup
    // (below, kept only as the final fallback — see its own doc comment)
    // with a real, versioned, country-aware `TaxRuleModel` that
    // `TaxService.resolveRatesForCodes` resolves against; the pure
    // `resolveTaxRate`/`computeLineTotals` functions those three services
    // already had are untouched — only what array gets fed into them
    // changes. Tenant-only per the standing master instructions — the
    // spec's own "Branch Isolation" is dropped.
    //
    // Real resting states only. "Draft -> Reviewed -> Approved ->
    // Effective -> Active" collapses "Reviewed" into "Draft" (no separate
    // review-only action was given) and "Effective"/"Active" into
    // "Approved" (whether an Approved rule is currently effective is
    // computed from its own effectiveDate/endDate at resolution time, not
    // a separately-mutated status — the same "don't need a cron to flip a
    // status a date range already encodes" reasoning used nowhere else in
    // this codebase yet, but the more correct one for a date-ranged
    // record). "Expired" IS real and cron-driven
    // (services/taxRuleExpiryScheduler.js) since it needs to actually
    // fire the named `TaxRuleExpired` event once past its own `endDate`.
    taxRuleStatuses: parseStringList(process.env.TAX_RULE_STATUSES_JSON, ['Draft', 'Approved', 'Expired', 'Archived', 'Superseded']),
    defaultTaxRuleStatus: process.env.DEFAULT_TAX_RULE_STATUS || 'Draft',
    taxRuleApprovalRequired: parseBoolean(process.env.TAX_RULE_APPROVAL_REQUIRED, true),
    // "Tax Types... VAT, GST, Sales Tax, Service Tax, Withholding Tax,
    // Import Tax, Export Tax, Luxury Tax, Environmental Tax, Custom
    // Types."
    taxTypes: parseStringList(process.env.TAX_TYPES_JSON, ['VAT', 'GST', 'SalesTax', 'ServiceTax', 'WithholdingTax', 'ImportTax', 'ExportTax', 'LuxuryTax', 'EnvironmentalTax', 'Custom']),
    // "Tax Calculation... Inclusive Tax, Exclusive Tax, Compound Tax,
    // Cascading Tax." Compound/Cascading are the same real mechanism here
    // (a rule's `compoundOnTaxCodes` names which other resolved taxes its
    // own base amount already includes) — not two parallel
    // implementations.
    taxCalculationMethods: parseStringList(process.env.TAX_CALCULATION_METHODS_JSON, ['Exclusive', 'Inclusive', 'Compound']),
    defaultTaxCalculationMethod: process.env.DEFAULT_TAX_CALCULATION_METHOD || 'Exclusive',
    // "Withholding Tax... Supplier Payments, Professional Services,
    // Contractors, Dividends, Interest."
    withholdingCategories: parseStringList(process.env.WITHHOLDING_CATEGORIES_JSON, ['SupplierPayments', 'ProfessionalServices', 'Contractors', 'Dividends', 'Interest']),
    // "Reverse Charge... Domestic, International, B2B, B2C." A rule opts
    // into one or more of these scopes; the caller of calculateTax
    // declares which scope(s) the actual transaction matches
    // (`reverseChargeContext`) — reverse charge only applies when both
    // agree, never assumed from country alone.
    reverseChargeScopes: parseStringList(process.env.REVERSE_CHARGE_SCOPES_JSON, ['Domestic', 'International', 'B2B', 'B2C']),
    // "Tax Exemptions... Government, Diplomatic, Educational, Medical,
    // Export, Charity. Certificate based."
    taxExemptionTypes: parseStringList(process.env.TAX_EXEMPTION_TYPES_JSON, ['Government', 'Diplomatic', 'Educational', 'Medical', 'Export', 'Charity']),
    // Monthly, 1st of the month at 02:00 — real, cron-driven rule
    // expiry (services/taxRuleExpiryScheduler.js).
    taxRuleExpiryCron: process.env.TAX_RULE_EXPIRY_CRON_SCHEDULE || '0 2 1 * *',
    // "Tax Reporting... VAT Return, GST Return, Sales Tax Return,
    // Withholding Return, Country Specific Reports." "Country Specific
    // Reports"/"Electronic Filing Integration" have no concrete report
    // shape or filing API given anywhere in this Part's spec — `Custom`
    // covers the former (same real aggregation, any reportType label);
    // electronic filing itself is honestly deferred (no credentials for
    // any country's e-filing API exist in this codebase).
    taxReportTypes: parseStringList(process.env.TAX_REPORT_TYPES_JSON, ['VATReturn', 'GSTReturn', 'SalesTaxReturn', 'WithholdingReturn', 'Custom']),
    // Tax collected from customers (output) sits here as a liability
    // until remitted; tax paid on withholding (input) sits here as a
    // recoverable/remitted asset — both skip ledger posting until
    // configured, same "skip until configured" fallback as every other
    // optional account-code pair in this module.
    taxPayableAccountCode: process.env.TAX_PAYABLE_ACCOUNT_CODE || null,
    taxReceivableAccountCode: process.env.TAX_RECEIVABLE_ACCOUNT_CODE || null,
    // Minimal, real tax-code -> rate lookup — Finance Module Part 9's
    // original implementation, kept ONLY as the last-resort fallback for
    // a `taxCode` with no matching `TaxRuleModel` row for the requested
    // country/date (e.g. a tenant that hasn't configured the real Tax
    // Engine yet) — `TaxService.resolveRatesForCodes` always tries the
    // real, versioned, country-aware rule first. An unrecognized taxCode
    // is still a real validation error either way, never silently 0%.
    taxCodes: parseJson(process.env.TAX_CODES_JSON, [
      { code: 'VAT', rate: 0.15, label: 'VAT 15%' },
      { code: 'GST', rate: 0.05, label: 'GST 5%' },
      { code: 'ZERO', rate: 0, label: 'Zero-Rated' }
    ]),

    // Enterprise Discount & Pricing Engine — Finance Module Part 21. "The
    // ERP should never let individual modules calculate discounts
    // independently. Instead, every module should ask a centralized
    // Pricing & Discount Engine." Mirrors Part 20's own integration
    // pattern exactly: Invoice's existing, real, already-tested
    // `computeLineTotals` per-line `discountType`/`discountValue`
    // (Percentage/Flat, Part 9) is untouched — it's still what actually
    // APPLIES a discount; this engine's job is to RESOLVE what that
    // discount (and base price) should be when a line supplies an
    // optional `productCode` instead of a caller-supplied `unitPrice`,
    // expressed back as a plain `Flat` discountValue so no change to
    // `computeLineTotals` itself was needed. No Product/Catalog model
    // exists anywhere in this codebase — `productCode` is treated as an
    // opaque SKU string throughout, the same "real, but no FK to
    // validate against" treatment Part 20 already gave `taxCode`.
    // Tenant-only per the standing master instructions — the spec's own
    // "Branch Isolation" is dropped.
    //
    // Real resting states only — identical collapse discipline to Part
    // 20's own TaxRuleModel ("Reviewed"/"Effective"/"Active" aren't
    // separate resting states; "Expired" is the one real, cron-driven
    // status since it needs to fire a named event).
    pricingRuleStatuses: parseStringList(process.env.PRICING_RULE_STATUSES_JSON, ['Draft', 'Approved', 'Expired', 'Archived', 'Superseded']),
    defaultPricingRuleStatus: process.env.DEFAULT_PRICING_RULE_STATUS || 'Draft',
    pricingRuleApprovalRequired: parseBoolean(process.env.PRICING_RULE_APPROVAL_REQUIRED, true),
    // "Rule Priority: Product Rule -> Customer Rule -> Contract Rule ->
    // Promotion Rule -> Coupon Rule -> Loyalty Rule." CustomerSpecific and
    // Contract resolve the BASE price (Contract wins when both match, the
    // same "most specific wins" priority Part 20's own jurisdiction
    // resolution already established); Volume/Promotion/Loyalty resolve
    // DISCOUNTS layered on top, in this exact pipeline order.
    pricingRuleTypes: parseStringList(process.env.PRICING_RULE_TYPES_JSON, ['CustomerSpecific', 'Contract', 'Volume', 'Promotion', 'Loyalty']),
    // "Discount Types: Percentage, Fixed Amount, Buy X Get Y, Free
    // Shipping, Bundle Discount, Category Discount, Custom Formula." Real
    // calculation logic exists only for Percentage/FixedAmount/BuyXGetY
    // (see PricingService's own doc comments) — Free Shipping has no
    // Shipping module in this codebase; Category/Bundle Discount would
    // need a real Product/Category catalog, which doesn't exist; Custom
    // Formula would need a formula-evaluation engine, its own unscoped
    // feature. All seven are still accepted as valid rule configuration
    // (honest intent, never silently rejected), only three compute.
    discountTypes: parseStringList(process.env.DISCOUNT_TYPES_JSON, ['Percentage', 'FixedAmount', 'BuyXGetY', 'FreeShipping', 'BundleDiscount', 'CategoryDiscount', 'CustomFormula']),
    // "Promotion Types: Seasonal, Holiday, Flash Sale, Campaign, Launch
    // Offer, Clearance, Custom Promotion." Only meaningful when a
    // PricingRuleModel's own ruleType is 'Promotion'.
    promotionTypes: parseStringList(process.env.PROMOTION_TYPES_JSON, ['Seasonal', 'Holiday', 'FlashSale', 'Campaign', 'LaunchOffer', 'Clearance', 'Custom']),
    // "Coupon Support... Single Use, Multi Use, Expiry Date, Usage
    // Limits, Customer Specific, Product Specific."
    couponUsageTypes: parseStringList(process.env.COUPON_USAGE_TYPES_JSON, ['SingleUse', 'MultiUse']),
    // Monthly, 1st of the month at 03:00 — real, cron-driven rule/coupon/
    // promotion expiry (services/pricingRuleExpiryScheduler.js).
    pricingRuleExpiryCron: process.env.PRICING_RULE_EXPIRY_CRON_SCHEDULE || '0 3 1 * *',
    // "Historical invoices can always be recalculated using the pricing
    // rules that were effective at the time of sale" — the real mapping
    // from a customer's own existing `category` field (Draft/Regular/
    // Premium/VIP/Corporate/Loyalty Member — already shipped, Part 1) to
    // the `customerGroup` a PricingRuleModel targets, case-insensitively.
    // "Loyalty Discounts" resolve against `loyalty_member` specifically;
    // no separate points-balance/loyalty-account system exists in this
    // codebase to build a redemption engine against, so loyalty stays a
    // flat/percentage tier discount, honestly scoped.
    loyaltyCustomerCategory: process.env.LOYALTY_CUSTOMER_CATEGORY || 'loyalty_member',

    // Enterprise Financial Approval Workflow — Finance Module Part 22.
    // "If each module implements its own approval logic, you'll end up
    // with duplicated, inconsistent workflows. The better approach is a
    // centralized Approval Platform." A real, purpose-built engine —
    // deliberately distinct from `utils/WorkflowEngine.js` (the existing
    // generic Booking/Visa/Travel state machine): that one gates a single
    // state transition behind a single required role/permission with no
    // persisted definition, no multi-level chains, no delegation, no
    // escalation, no SLA, no digital signature, and reads Travel-domain
    // config files (bookingConfig/travelConfig/etc), not this module's
    // own tenant-owned RBAC. Structurally too different to extend safely
    // — see docs/05-api/07-finance-api.md Part 22 for the full analysis.
    // Tenant-only per the standing master instructions.
    //
    // Real resting states only — identical collapse discipline to every
    // rule-engine Part this session (Tax/Pricing): "Reviewed"/"Effective"/
    // "Active" aren't separate states for a WORKFLOW DEFINITION;
    // "Expired" is the one real, cron-driven status.
    workflowDefinitionStatuses: parseStringList(process.env.WORKFLOW_DEFINITION_STATUSES_JSON, ['Draft', 'Approved', 'Expired', 'Archived', 'Superseded']),
    defaultWorkflowDefinitionStatus: process.env.DEFAULT_WORKFLOW_DEFINITION_STATUS || 'Draft',
    workflowDefinitionApprovalRequired: parseBoolean(process.env.WORKFLOW_DEFINITION_APPROVAL_REQUIRED, true),
    // "The module integrates with Finance, Procurement, HR, Sales, CRM,
    // Inventory, Projects, Payroll." Seeded with the Finance modules that
    // actually exist in this codebase today, plus `Custom` for forward
    // compatibility with modules this Part doesn't touch (no Procurement/
    // HR/Sales/CRM/Inventory/Projects/Payroll module exists yet).
    workflowModules: parseStringList(process.env.WORKFLOW_MODULES_JSON, ['Expense', 'Invoice', 'Journal', 'VendorPayment', 'CustomerCollection', 'PurchaseOrder', 'TaxRule', 'PricingRule', 'Custom']),
    // "Approval Types: Sequential, Parallel, Any One, All Required,
    // Majority Vote, Conditional." Real completion logic for all six —
    // see ApprovalWorkflowService's own doc comments for exactly how each
    // decides completion.
    approvalTypes: parseStringList(process.env.APPROVAL_TYPES_JSON, ['Sequential', 'Parallel', 'AnyOne', 'AllRequired', 'MajorityVote', 'Conditional']),
    // A live approval REQUEST's own real resting states — "Draft"/
    // "Submitted"/"Pending Approval" from the spec's own Lifecycle
    // collapse into one: `startApproval` always creates a live Pending
    // request directly (no separate draft-instance concept was
    // contracted). "Approved" and "Completed" collapse too — reaching
    // full approval IS completion, the same "Collected"=="Closed"-style
    // unification judgement call already made elsewhere this session
    // where no real distinguishing trigger existed between them (unlike
    // Part 18's Invoice-precedented Collected/Closed split, nothing here
    // names a separate close action).
    approvalRequestStatuses: parseStringList(process.env.APPROVAL_REQUEST_STATUSES_JSON, ['Pending', 'Escalated', 'Approved', 'Rejected', 'Cancelled', 'Expired']),
    // "Delegation... Temporary Delegate, Permanent Delegate, Out of
    // Office, Approval Proxy." "Approval Proxy" is the same real
    // mechanism as the other three (one user's decisions are recorded on
    // another's behalf) — not a fourth parallel implementation.
    delegationTypes: parseStringList(process.env.DELEGATION_TYPES_JSON, ['Temporary', 'Permanent', 'OutOfOffice']),
    // "Notifications: Email, SMS, Push Notification, WhatsApp, Microsoft
    // Teams, Slack." Reuses Part 8's own real services/delivery/ adapters
    // (Email/SMS/WhatsApp/Webhook) — Push/Teams/Slack have no real
    // surface anywhere in this codebase, same honest "NotConfigured"
    // treatment every other Part already gives channels without a real
    // adapter.
    approvalNotificationChannels: parseStringList(process.env.APPROVAL_NOTIFICATION_CHANNELS_JSON, ['Email', 'SMS', 'WhatsApp', 'Push', 'Teams', 'Slack']),
    defaultApprovalNotificationChannel: process.env.DEFAULT_APPROVAL_NOTIFICATION_CHANNEL || 'Email',
    // "SLA Tracking and Escalations... SLA Expiry, Reminder, Manager
    // Escalation, Executive Escalation, Automatic Reassignment." A
    // workflow definition's own `slaHours`/escalation config (per level)
    // drives this; these are only the last-resort defaults when a
    // definition doesn't set its own.
    defaultApprovalSlaHours: parseInt(process.env.DEFAULT_APPROVAL_SLA_HOURS || '48', 10),
    // Hourly — real, cron-driven SLA-expiry escalation
    // (services/approvalEscalationScheduler.js). Finer-grained than the
    // other Parts' own daily/monthly schedulers since an SLA is measured
    // in hours, not days.
    approvalEscalationCron: process.env.APPROVAL_ESCALATION_CRON_SCHEDULE || '0 * * * *',

    // Enterprise Settlement Engine — Finance Module Part 23. "A payment is
    // when money is authorized or captured. A settlement is when the
    // money is actually transferred and finalized." Closes a real,
    // long-standing gap: Part 7's own `paymentStatuses` has listed
    // `'Settled'` since the Payment Engine first shipped, and read
    // predicates across the codebase (`isPaymentRefundable`, Part 8's own
    // `receiptEligiblePaymentStatuses`) have always treated it as a real,
    // reachable status — but nothing anywhere ever actually SET a
    // payment's status to `'Settled'` (confirmed by grep before writing
    // any code for this Part). `SettlementService.completeSettlement`
    // (via the new, minimal `PaymentService.markSettled`) is the real
    // first setter. Tenant-only per the standing master instructions.
    //
    // Real resting states only. "Validated" collapses into "Pending"
    // (validation happens inline inside `createSettlement`, never a
    // separate stored state); "Grouped Into Batch" collapses into the
    // settlement's own `batchId` being non-null, not a separate status
    // value (same "a field already encodes this" reasoning Part 22 used
    // for a workflow rule's own effective-dating).
    settlementStatuses: parseStringList(process.env.SETTLEMENT_STATUSES_JSON, ['Pending', 'Sent', 'Processing', 'Completed', 'Failed', 'Reversed', 'Disputed', 'Cancelled']),
    defaultSettlementStatus: process.env.DEFAULT_SETTLEMENT_STATUS || 'Pending',
    settlementNumberPrefix: process.env.SETTLEMENT_NUMBER_PREFIX || 'STL',
    // "Settlement Batches... Daily, Weekly, Monthly, Gateway, Merchant,
    // Manual Batch."
    settlementBatchTypes: parseStringList(process.env.SETTLEMENT_BATCH_TYPES_JSON, ['Daily', 'Weekly', 'Monthly', 'Gateway', 'Merchant', 'Manual']),
    settlementBatchNumberPrefix: process.env.SETTLEMENT_BATCH_NUMBER_PREFIX || 'SBATCH',
    // "Settlement Fees... Gateway Fee, Bank Fee, Commission, Tax, FX Fee,
    // Processing Fee. Configurable." A real, per-gateway fee schedule —
    // percentage + fixed component per fee type, keyed by the payment's
    // own `gateway` field (Part 7), falling back to `Default` for a
    // gateway with no specific schedule configured. `computeSettlementFees`
    // (services/SettlementService.js) is the real math.
    settlementFeeTypes: parseStringList(process.env.SETTLEMENT_FEE_TYPES_JSON, ['GatewayFee', 'BankFee', 'Commission', 'Tax', 'FXFee', 'ProcessingFee']),
    settlementFeeSchedule: parseJson(process.env.SETTLEMENT_FEE_SCHEDULE_JSON, {
      Default: { GatewayFee: { percent: 2.9, fixed: 0.30 }, ProcessingFee: { percent: 0, fixed: 0 } },
      Stripe: { GatewayFee: { percent: 2.9, fixed: 0.30 }, ProcessingFee: { percent: 0, fixed: 0 } },
      Manual: { GatewayFee: { percent: 0, fixed: 0 }, ProcessingFee: { percent: 0, fixed: 0 } }
    }),
    // "Split Settlements... Marketplace, Commission, Partner Share,
    // Vendor Share, Platform Fee. Automatic allocation." VendorShare/
    // PartnerShare splits with a real `payeeId` (a Vendor) reuse
    // `VendorCreditService.createCredit` directly (Part 17's own reuse
    // pattern) — never a parallel payout mechanism.
    settlementSplitTypes: parseStringList(process.env.SETTLEMENT_SPLIT_TYPES_JSON, ['Marketplace', 'Commission', 'PartnerShare', 'VendorShare', 'PlatformFee']),
    // "Settlement Adjustments... Corrections, Reversals, Chargebacks,
    // Manual Adjustments, Compensation Entries." `Chargeback` never
    // duplicates Part 12's own real, complete `ChargebackModel` workflow
    // — an adjustment of this type only ever LINKS an existing chargeback
    // (`chargebackId`), it doesn't reimplement dispute handling.
    settlementAdjustmentTypes: parseStringList(process.env.SETTLEMENT_ADJUSTMENT_TYPES_JSON, ['Correction', 'Reversal', 'ManualAdjustment', 'CompensationEntry', 'Chargeback']),
    // Fee/commission expense sits here until posted; the settlement's own
    // net receivable/clearing account is the other side — both skip
    // ledger posting until configured, same "skip until configured"
    // fallback as every other optional account-code pair in this module.
    settlementFeeExpenseAccountCode: process.env.SETTLEMENT_FEE_EXPENSE_ACCOUNT_CODE || null,
    settlementClearingAccountCode: process.env.SETTLEMENT_CLEARING_ACCOUNT_CODE || null,
    // "Settlement Reconciliation... Gateway Reports, Bank Statements,
    // Internal Ledger, Exception Detection, Automatic matching." Reuses
    // Part 14's own real fuzzy-matching tolerances/weights directly
    // (`reconciliationAmountTolerance`/`reconciliationDateToleranceDays`/
    // `reconciliationMatchWeights`, above) rather than a second, parallel
    // tolerance config that could drift out of sync — one matching engine
    // for the whole ERP.

    // Enterprise Financial Reporting — Finance Module Part 24. "The
    // reporting platform should never calculate business transactions
    // directly. Instead, it should read from the General Ledger and
    // other accounting records that have already been posted." This
    // module is a thin, real aggregation/presentation layer over
    // already-shipped, already-immutable sources —
    // `LedgerService.getTrialBalance`/`listEntries` (Part 4),
    // `JournalService.listJournals` (Part 3), `TaxService.generateTaxReport`
    // (Part 20), `computeAgingBucket` (Part 5/6), `ExpenseBudgetModel`
    // (Part 16) — never a second, parallel calculation of any of them.
    // Tenant-only per the standing master instructions.
    //
    // Real resting states only. "Validated -> Data Retrieved ->
    // Aggregated -> Generated" is the pipeline inside ONE synchronous
    // `generateReport` call, not four separate resting states — the
    // same collapse discipline as every rule-engine Part this session.
    // "Exported" isn't a status either — a report can be exported
    // multiple times, in multiple formats, without changing its own
    // generation state, so exports live in their own array instead.
    reportStatuses: parseStringList(process.env.REPORT_STATUSES_JSON, ['Requested', 'Generated', 'Cancelled', 'Expired', 'Archived']),
    defaultReportStatus: process.env.DEFAULT_REPORT_STATUS || 'Requested',
    // "Supported Reports: Trial Balance, Balance Sheet, Profit & Loss,
    // Cash Flow Statement, General Ledger, Journal Register, AR Aging,
    // AP Aging, Tax Reports, Budget vs Actual, Retained Earnings, Custom
    // Reports."
    reportTypes: parseStringList(process.env.REPORT_TYPES_JSON, ['TrialBalance', 'BalanceSheet', 'ProfitAndLoss', 'CashFlow', 'GeneralLedger', 'JournalRegister', 'ARAging', 'APAging', 'TaxReport', 'BudgetVsActual', 'RetainedEarnings', 'Custom']),
    // "Export Formats: PDF, Excel, CSV, JSON, API, Scheduled Email." Real
    // generation exists for PDF/Excel/CSV/JSON — "API" is simply the
    // report's own real GET endpoint (no separate artifact to generate);
    // "Scheduled Email" is a real delivery MECHANISM (below), not a file
    // format, so it's not in this list.
    reportExportFormats: parseStringList(process.env.REPORT_EXPORT_FORMATS_JSON, ['PDF', 'Excel', 'CSV', 'JSON']),
    // "Report Scheduling: Daily, Weekly, Monthly, Quarterly, Yearly, On
    // Demand." "On Demand" is just calling POST /financial-reports/generate
    // directly — not a schedule row.
    reportScheduleFrequencies: parseStringList(process.env.REPORT_SCHEDULE_FREQUENCIES_JSON, ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly']),
    // Daily at 05:00 — real, cron-driven schedule runner
    // (services/financialReportScheduler.js).
    reportScheduleCron: process.env.REPORT_SCHEDULE_CRON_SCHEDULE || '0 5 * * *',
    // A generated report older than this many days is eligible for the
    // scheduler to mark `Expired` (real cron-driven, mirrors every other
    // Part's own expiry scheduler) — 0 disables expiry entirely.
    reportRetentionDays: parseInt(process.env.REPORT_RETENTION_DAYS || '365', 10),
    // "Retained Earnings" — a real formula (opening retained earnings +
    // current-period Net Income − dividends). No dividend/distribution
    // concept exists anywhere in this codebase, so that term is always 0
    // unless a future Part introduces one — honestly, not silently
    // guessed at.
    retainedEarningsAccountCode: process.env.RETAINED_EARNINGS_ACCOUNT_CODE || null,

    // Enterprise Financial Dashboard — Finance Module Part 25. "A report
    // answers 'What happened?' A dashboard answers 'What is happening
    // right now?'" This Part deliberately EXTENDS the existing, real,
    // already-shipped `services/KPIEngine.js` (Travel/Visa) with its own
    // `computeFinanceMetrics`/`refreshFinanceSummary`, and mirrors
    // `VisaAnalyticsEngine.js`/`VisaDashboardController.js`'s own proven
    // "persisted daily summary + CacheManager + background refresh via
    // queueMicrotask, never aggregate transactional tables inline on a
    // dashboard request" architecture — not a second, parallel dashboard
    // system. Tenant-only per the standing master instructions.
    // 'CEO'/'Board'/'Department' added by Financial Analytics Platform
    // Enhancements (Part 29) — see FinanceAnalyticsEngine.js's own
    // ceoDashboard/boardDashboard/departmentDashboard doc comments.
    financeDashboardTypes: parseStringList(process.env.FINANCE_DASHBOARD_TYPES_JSON, ['Executive', 'CFO', 'Treasury', 'AccountsReceivable', 'AccountsPayable', 'Revenue', 'Expense', 'CashFlow', 'Tax', 'Custom', 'CEO', 'Board', 'Department']),
    // "Alerts: Low Cash, High Expenses, Large Payment, Overdue
    // Receivable, Overdue Payable, Budget Exceeded, Negative Cash Flow,
    // Tax Due, Custom Alerts." Real, threshold-driven — every alert type
    // below has a concrete, configurable trigger value; none is
    // fabricated or always-on.
    dashboardAlertTypes: parseStringList(process.env.DASHBOARD_ALERT_TYPES_JSON, ['LowCash', 'HighExpenses', 'LargePayment', 'OverdueReceivable', 'OverduePayable', 'BudgetExceeded', 'NegativeCashFlow', 'TaxDue', 'Custom']),
    dashboardAlertSeverities: parseStringList(process.env.DASHBOARD_ALERT_SEVERITIES_JSON, ['Info', 'Warning', 'Critical']),
    // "Refresh: Real Time, 30 Seconds, 1 Minute, 5 Minutes, Manual." Real
    // client-facing polling-interval OPTIONS a caller/preference can pick
    // — the actual summary refresh cadence server-side is event-driven
    // (KPIEngine.refreshFinanceSummary, triggered on relevant domain
    // events / on cache-miss), not a fixed poll loop of its own.
    dashboardRefreshIntervals: parseStringList(process.env.DASHBOARD_REFRESH_INTERVALS_JSON, ['RealTime', '30Seconds', '1Minute', '5Minutes', 'Manual']),
    defaultDashboardRefreshInterval: process.env.DEFAULT_DASHBOARD_REFRESH_INTERVAL || '5Minutes',
    // Short TTL — a dashboard should feel live without hammering the same
    // aggregation on every single request; mirrors
    // `accountBalanceCacheTtlSeconds`'s own real short-cache reasoning
    // (Part 4).
    dashboardCacheTtlSeconds: parseInt(process.env.DASHBOARD_CACHE_TTL_SECONDS || '60', 10),
    // Real, configurable alert thresholds — "Low Cash" fires when total
    // live bank balance drops below this; "Large Payment" flags any
    // single payment at/above this amount.
    lowCashThreshold: parseFloat(process.env.DASHBOARD_LOW_CASH_THRESHOLD || '0'),
    largePaymentThreshold: parseFloat(process.env.DASHBOARD_LARGE_PAYMENT_THRESHOLD || '0'),
    // "FX Exposure: Medium." Real thresholds (in base-currency terms) —
    // reuses Part 19's own `CurrencyService.getCurrencyExposure` for the
    // real net exposure figure; these two values just classify it into
    // Low/Medium/High.
    fxExposureMediumThreshold: parseFloat(process.env.DASHBOARD_FX_EXPOSURE_MEDIUM_THRESHOLD || '50000'),
    fxExposureHighThreshold: parseFloat(process.env.DASHBOARD_FX_EXPOSURE_HIGH_THRESHOLD || '250000'),
    // "High Expenses" — today's real GL Expense-category movement
    // exceeding this. 0 disables the check.
    highExpenseDailyThreshold: parseFloat(process.env.DASHBOARD_HIGH_EXPENSE_DAILY_THRESHOLD || '0'),
    // "Tax Due" — a real, already-generated `TaxReportModel` (Part 20)
    // with a net payable at/above this, for the current month. No due-
    // date concept exists on a tax report to compare against, so this
    // stays scoped to "a real outstanding liability exists," not "is
    // overdue by N days" — honestly, not guessed at.
    taxDueThreshold: parseFloat(process.env.DASHBOARD_TAX_DUE_THRESHOLD || '0'),

    // Enterprise Financial Analytics — Finance Module Part 26. "Reports
    // describe. Dashboards monitor. Analytics explains, predicts, and
    // helps optimize." Reads exclusively from already-immutable sources
    // this codebase already has — `LedgerService.getTrialBalance`'s own
    // real historical as-of-date support (Part 4) and
    // `FinancialReportService.getPeriodMovement` (Part 24) sampled at
    // bucketed points in time — never a parallel recalculation of a
    // business transaction, and never dependent on Part 25's own
    // same-day-only `FinanceOperationsSummaryModel` for historical depth.
    // Tenant-only per the standing master instructions.
    //
    // Real resting states only — "Data Selected -> Validated ->
    // Aggregated -> Model Applied -> Insight Generated -> Published" is
    // the pipeline inside ONE synchronous `runAnalysis` call, the same
    // collapse discipline already applied identically to Part 24's own
    // report-generation pipeline; "Recalculated" isn't a status either —
    // re-running the same parameters simply creates a new immutable row
    // (same "immutable history, re-run = new row" discipline as
    // FinancialReportModel/TaxReportModel).
    analyticsStatuses: parseStringList(process.env.ANALYTICS_STATUSES_JSON, ['Completed', 'Cancelled', 'Archived', 'Expired']),
    defaultAnalyticsStatus: process.env.DEFAULT_ANALYTICS_STATUS || 'Completed',
    // Every type below maps to a real, already-shipped data source (see
    // docs/05-api/07-finance-api.md Part 26's own "Reuse across prior
    // Parts" section for the full mapping). Deliberately excludes the
    // spec's own Product/Department/Project/Country/Branch Profitability,
    // Revenue by Channel/Product, Revenue Mix, and Fixed vs Variable
    // Costs — no Product/Department/Channel/Country dimension exists
    // anywhere on a revenue-generating record in this codebase (Invoice
    // only carries `customerId`), and no fixed/variable cost-behavior tag
    // exists on any expense category to classify by — honestly deferred,
    // not guessed at, same discipline as every prior Part's own Deferred
    // section.
    analysisTypes: parseStringList(process.env.ANALYSIS_TYPES_JSON, [
      'RevenueTrend', 'RevenueForecast', 'RevenueByCustomer', 'RecurringRevenue',
      'ExpenseTrend', 'ExpenseForecast', 'ExpenseCategories', 'CostDrivers', 'DepartmentExpenses',
      'CashFlowForecast', 'WorkingCapitalForecast',
      'FinancialRatios',
      'BudgetVsActual', 'CurrentVsPrevious', 'ForecastVsActual',
      'ScenarioPlanning',
      'AnomalyDetection',
      'ExecutiveInsights',
      'Custom'
    ]),
    // How many trailing real GL-backed buckets a Trend/Forecast analysis
    // samples by default when the caller doesn't specify periodStart —
    // 12 months of real, immutable GL history.
    analyticsTrendBucketsBack: parseInt(process.env.ANALYTICS_TREND_BUCKETS_BACK || '12', 10),
    // How many future buckets a Forecast analysis projects by default
    // when `period` isn't a recognizable forward-looking horizon string
    // (e.g. "Next12Months", "Next90Days", "Weekly", "Monthly",
    // "Quarterly", "Yearly").
    analyticsForecastHorizonBuckets: parseInt(process.env.ANALYTICS_FORECAST_HORIZON_BUCKETS || '3', 10),
    // Below this many real historical data points, a Trend/Forecast
    // result is honestly returned with `confidenceLevel: "Low"` and
    // `insufficientData: true` rather than fabricating a regression line
    // through 0-2 points.
    analyticsMinDataPointsForTrend: parseInt(process.env.ANALYTICS_MIN_DATA_POINTS_FOR_TREND || '3', 10),
    analyticsConfidenceMediumDataPoints: parseInt(process.env.ANALYTICS_CONFIDENCE_MEDIUM_DATA_POINTS || '6', 10),
    analyticsConfidenceHighDataPoints: parseInt(process.env.ANALYTICS_CONFIDENCE_HIGH_DATA_POINTS || '12', 10),
    // "Anomaly Detection... Threshold Rules" + "Machine Learning Models."
    // Real statistical z-score threshold — a bucket/transaction whose
    // deviation from the trailing mean exceeds this many standard
    // deviations is flagged. The spec's own "Machine Learning Models" is
    // explicitly NOT built (see docs/05-api/07-finance-api.md Part 26's
    // Deferred section) — same honesty already applied to Part 25's own
    // "no ML" Tax Due alert.
    analyticsAnomalyStdDevThreshold: parseFloat(process.env.ANALYTICS_ANOMALY_STDDEV_THRESHOLD || '2', 10),
    // "Duplicate Payments" anomaly — reuses Part 7's own real Payment
    // fraud-detection window rather than a second, parallel duplicate-
    // window config (`fraudDuplicateWindowMinutes`, above).
    //
    // A generated analysis older than this many days is eligible for
    // expiry — 0 disables, same "0 = unconfigured" convention as
    // `reportRetentionDays` (Part 24).
    analyticsRetentionDays: parseInt(process.env.ANALYTICS_RETENTION_DAYS || '365', 10),

    // Enterprise Audit & Compliance — Finance Module Part 27. "Who, what,
    // when, where, why, how, before value, after value, approval chain,
    // and whether the action complied with organizational or regulatory
    // policies" — genuinely more than the pre-existing `AuditLogModel`
    // (a simple activity log, written by nearly every service this
    // session) was ever designed to hold. `AuditEventModel` is a real,
    // additive, hash-chained, tamper-evident record — not a replacement
    // for `AuditLogModel`, which every existing call site keeps using
    // unchanged. Tenant-only per the standing master instructions.
    //
    // Real resting states only. "Captured -> Validated -> Stored ->
    // Indexed -> Available For Investigation" is the pipeline inside ONE
    // synchronous `recordEvent` call, the same collapse discipline
    // already applied identically to every prior Part's own multi-step
    // Business Workflow diagram.
    auditEventStatuses: parseStringList(process.env.AUDIT_EVENT_STATUSES_JSON, ['Active', 'Archived']),
    // "Audit Categories: Authentication, Authorization, Financial,
    // Inventory, HR, Security, Configuration, Master Data, System,
    // Custom." Only Financial/System have real, concrete integration
    // this pass (see docs/05-api/07-finance-api.md Part 27's own "Real
    // integration, not every category" section) — the others are real,
    // valid, config-driven values a future module's own service can
    // start using immediately without any schema change here.
    auditCategories: parseStringList(process.env.AUDIT_CATEGORIES_JSON, ['Authentication', 'Authorization', 'Financial', 'Inventory', 'HR', 'Security', 'Configuration', 'MasterData', 'System', 'Custom']),
    auditSeverities: parseStringList(process.env.AUDIT_SEVERITIES_JSON, ['Info', 'Warning', 'Critical']),
    // "Compliance Status" on a stored event — Compliant/Violation only
    // apply once at least one real Active CompliancePolicyModel rule was
    // actually evaluated against it; NotEvaluated is the honest default
    // when no policy is configured for that event's category/entityType
    // — never silently defaulted to "Compliant".
    complianceStatuses: parseStringList(process.env.COMPLIANCE_STATUSES_JSON, ['Compliant', 'Violation', 'Exception', 'NotEvaluated']),
    // "Compliance Rules: SOX, GDPR, ISO 27001, PCI DSS, HIPAA, Local
    // Regulations, Custom Policies." These are real, tenant-assignable
    // LABELS on a `CompliancePolicyModel` row for a tenant's own
    // categorization/reporting — this module does NOT implement actual
    // jurisdiction-specific SOX/GDPR/ISO27001/PCI-DSS/HIPAA regulatory
    // logic (that would require real legal/compliance domain expertise
    // per jurisdiction, far beyond a generic ERP codebase to fabricate
    // honestly) — same "config-driven label, not a fabricated engine"
    // stance already applied to Part 20 Tax Engine's own per-country
    // rate reality.
    compliancePolicyTypes: parseStringList(process.env.COMPLIANCE_POLICY_TYPES_JSON, ['SOX', 'GDPR', 'ISO27001', 'PCIDSS', 'HIPAA', 'LocalRegulation', 'Custom']),
    // "Segregation of Duties: Role Conflict Detection, Approval Conflict,
    // Payment Conflict, Configuration Conflict." Two real, concrete rule
    // types are actually evaluable against this codebase's own real
    // data — `SegregationOfDuties` (same user created AND approved the
    // same real record) and `FieldChangeRestriction` (a configured field
    // changed between a real event's own beforeState/afterState).
    // "Payment Conflict"/"Configuration Conflict" collapse into these
    // same two real mechanisms rather than becoming fabricated, distinct
    // rule types with no independent real logic of their own.
    complianceRuleTypes: parseStringList(process.env.COMPLIANCE_RULE_TYPES_JSON, ['SegregationOfDuties', 'FieldChangeRestriction', 'Custom']),
    // Real, already-seeded permission-key pairs (utils/authDomainDefaults.js)
    // that grant BOTH the create and approve side of the same real Finance
    // workflow — a Role holding both is flagged by `checkRoleConflicts`.
    // Tenant admins can override this list entirely via the env var.
    sodConflictingPermissionPairs: parseJson(process.env.SOD_CONFLICTING_PERMISSION_PAIRS_JSON, [
      ['finance.journal.create', 'finance.journal.approve'],
      ['finance.invoice.create', 'finance.invoice.approve'],
      ['finance.payable.create', 'finance.payable.approve'],
      ['finance.expense.create', 'finance.expense.approve'],
      ['finance.creditnote.create', 'finance.creditnote.approve'],
      ['finance.debitnote.create', 'finance.debitnote.approve'],
      ['finance.refund.create', 'finance.refund.approve'],
      ['finance.bankaccount.create', 'finance.bankaccount.approve'],
      ['finance.reconciliation.create', 'finance.reconciliation.approve'],
      ['finance.cash.create', 'finance.cash.approve'],
      ['finance.vendorpayment.create', 'finance.vendorpayment.approve'],
      ['finance.customercollection.create', 'finance.customercollection.approve'],
      ['finance.settlement.create', 'finance.settlement.approve']
    ]),
    // "Entity-level" Segregation of Duties (createdBy === approvedBy on
    // the SAME real record) is only wired this pass for the entity types
    // whose own real approver field shape has actually been read and
    // verified — Journal/Invoice/AccountsPayable (flat `approvedBy`) and
    // Expense (`approvals[].approvedBy`, Part 22's own ordered multi-
    // approval design). Requesting any other `entityType` returns a
    // clear "not yet supported" error rather than guessing a field name
    // on an unverified schema.
    sodSupportedEntityTypes: parseStringList(process.env.SOD_SUPPORTED_ENTITY_TYPES_JSON, ['Journal', 'Invoice', 'AccountsPayable', 'Expense']),
    // "Data Retention: 7 Years, 10 Years, Unlimited, Legal Hold." 0 =
    // unlimited (same "0 = unconfigured" convention as every other
    // retention-days field this session). `legalHold: true` on an
    // individual AuditEventModel row overrides this entirely, real and
    // enforced (the retention scheduler skips any row with it set).
    auditRetentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '2555', 10), // 7 years
    // Daily at 03:00 — real, cron-driven expiry (services/auditRetentionScheduler.js),
    // mirrors financialReportScheduler.js's own runReportExpiry pattern
    // exactly (one cross-tenant updateMany, no per-tenant loop needed).
    auditRetentionCron: process.env.AUDIT_RETENTION_CRON_SCHEDULE || '0 3 * * *',
    // "Investigation... Cross-Module Search." Reuses the same
    // default/max page size convention as every other list endpoint this
    // session rather than a separate investigation-specific cap.
    auditEventMaxExportRecords: parseInt(process.env.AUDIT_EVENT_MAX_EXPORT_RECORDS || '5000', 10),

    // Financial Analytics Platform Enhancements — Part 29. "EBITDA" —
    // Earnings Before Interest, Taxes, Depreciation, and Amortization.
    // This codebase's Chart of Accounts has no built-in sub-classification
    // distinguishing Interest/Income-Tax/Depreciation/Amortization expense
    // from ordinary Expense — and no Fixed Assets/Depreciation module
    // exists to generate real depreciation postings in the first place.
    // Rather than fabricating these figures, EBITDA is computed as
    // NetIncome + the REAL ledger movement of whichever of these four
    // account codes a tenant explicitly configures (0 for any left unset)
    // — the same "skip until configured" honest fallback already used by
    // `retainedEarningsAccountCode`/`arControlAccountCode`/etc. above. A
    // tenant that configures none of these still gets a real EBITDA
    // figure — it's simply equal to Net Income, honestly, not a
    // fabricated distinct calculation.
    interestExpenseAccountCode: process.env.INTEREST_EXPENSE_ACCOUNT_CODE || null,
    incomeTaxExpenseAccountCode: process.env.INCOME_TAX_EXPENSE_ACCOUNT_CODE || null,
    depreciationExpenseAccountCode: process.env.DEPRECIATION_EXPENSE_ACCOUNT_CODE || null,
    amortizationExpenseAccountCode: process.env.AMORTIZATION_EXPENSE_ACCOUNT_CODE || null,
  };
};

export default getFinanceConfig;
