import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { accountSchemas, journalSchemas, receivableSchemas, paymentSchemas, payableSchemas, vendorSchemas, receiptSchemas, invoiceSchemas, creditNoteSchemas, debitNoteSchemas, refundSchemas, chargebackSchemas, bankAccountSchemas, bankReconciliationSchemas, cashManagementSchemas, expenseSchemas, vendorPaymentSchemas, customerCollectionSchemas, currencySchemas, taxSchemas, pricingSchemas, approvalWorkflowSchemas, settlementSchemas, financialReportSchemas, financialDashboardSchemas, financialAnalyticsSchemas, auditComplianceSchemas } from "../middleware/validateRequest.js";
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deactivateAccount
} from "../controllers/FinanceController.js";
import {
  listJournals,
  getJournal,
  createJournal,
  updateJournal,
  approveJournal,
  rejectJournal,
  cancelJournal,
  postJournal,
  reverseJournal
} from "../controllers/JournalController.js";
import {
  listLedgerEntries,
  getAccountBalance,
  getTrialBalance,
  recalculateLedger
} from "../controllers/GeneralLedgerController.js";
import {
  listReceivables,
  getReceivable,
  createReceivable,
  allocatePayment as allocateReceivablePayment,
  writeOffReceivable
} from "../controllers/AccountsReceivableController.js";
import {
  listPayments,
  getPayment,
  createPayment,
  allocatePayment as allocatePaymentGeneric,
  voidPayment,
  refundPayment
} from "../controllers/PaymentController.js";
import {
  listPayables,
  getPayable,
  createPayable,
  approvePayable,
  allocatePayment as allocatePayablePayment,
  writeOffPayable,
  schedulePayment
} from "../controllers/AccountsPayableController.js";
import {
  listVendors,
  getVendor,
  createVendor
} from "../controllers/VendorController.js";
import {
  listReceipts,
  getReceipt,
  createReceipt,
  reissueReceipt,
  cancelReceipt,
  redeliverReceipt,
  verifyReceipt,
  downloadReceiptPdf
} from "../controllers/ReceiptController.js";
import {
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  approveInvoice,
  issueInvoice,
  cancelInvoice as cancelInvoiceAction,
  voidInvoice,
  closeInvoice
} from "../controllers/InvoiceController.js";
import {
  listCreditNotes,
  getCreditNote,
  createCreditNote,
  approveCreditNote,
  issueCreditNote,
  allocateCreditNote,
  cancelCreditNote,
  voidCreditNote,
  closeCreditNote
} from "../controllers/CreditNoteController.js";
import {
  listDebitNotes,
  getDebitNote,
  createDebitNote,
  approveDebitNote,
  issueDebitNote,
  allocateDebitNote,
  cancelDebitNote,
  voidDebitNote,
  closeDebitNote
} from "../controllers/DebitNoteController.js";
import {
  listRefunds,
  getRefund,
  createRefund,
  reviewRefund,
  approveRefund,
  rejectRefund,
  processRefund,
  cancelRefund
} from "../controllers/RefundController.js";
import {
  listChargebacks,
  getChargeback,
  createChargeback,
  submitChargebackEvidence,
  resolveChargeback
} from "../controllers/ChargebackController.js";
import {
  listBankAccounts,
  getBankAccount,
  createBankAccount,
  updateBankAccount,
  verifyBankAccount,
  activateBankAccount,
  freezeBankAccount,
  reopenBankAccount,
  suspendBankAccount,
  closeBankAccount,
  archiveBankAccount,
  adjustBalance,
  holdFunds,
  releaseHold,
  createVirtualAccount,
  linkSettlementAccount,
  listBankTransactions
} from "../controllers/BankAccountController.js";
import {
  uploadStatementFile,
  importStatement,
  listReconciliations,
  getReconciliation,
  runAutoMatch,
  matchTransaction,
  unmatchTransaction,
  listStatementTransactions,
  listExceptions,
  resolveException,
  createAdjustment,
  approveReconciliation,
  completeReconciliation,
  rejectReconciliation,
  reopenReconciliation,
  archiveReconciliation,
  suggestAiMatches,
  acceptAiSuggestion,
  getReport,
  exportReportCsv
} from "../controllers/BankReconciliationController.js";
import {
  listCashLocations,
  getCashLocation,
  createCashLocation,
  updateCashLocation,
  closeCashLocation,
  archiveCashLocation,
  listCashLocationTransactions,
  listCashTransfers,
  getCashTransfer,
  createCashTransfer,
  approveCashTransfer,
  rejectCashTransfer,
  cancelCashTransfer,
  listCashCounts,
  getCashCount,
  createCashCount,
  resolveCashCountVariance,
  listPettyCashAdvances,
  getPettyCashAdvance,
  issuePettyCashAdvance,
  settlePettyCashAdvance,
  replenishPettyCash,
  forecastCashNeeds
} from "../controllers/CashManagementController.js";
import {
  uploadReceiptFile,
  listExpenses,
  getExpense,
  createExpense,
  updateExpense,
  uploadReceipt,
  verifyExpenseReceipt,
  submitExpense,
  approveExpense,
  rejectExpense,
  returnExpense,
  cancelExpense,
  reimburseExpense,
  closeExpense,
  listExpenseBudgets,
  getExpenseBudget,
  createExpenseBudget
} from "../controllers/ExpenseController.js";
import {
  addVendorBankAccount,
  listVendorBankAccounts,
  setPrimaryVendorBankAccount,
  listVendorPayments,
  getVendorPayment,
  createVendorPaymentProposal,
  approveVendorPayment,
  rejectVendorPayment,
  cancelVendorPayment,
  holdVendorPayment,
  releaseVendorPaymentHold,
  scheduleVendorPayment,
  executeVendorPayment,
  generatePaymentFile,
  listPaymentBatches,
  getPaymentBatch,
  createPaymentBatch,
  executePaymentBatch,
  createVendorAdvance,
  suggestPaymentTiming
} from "../controllers/VendorPaymentController.js";
import {
  createCollectionRequest,
  listCollections,
  getCollectionAnalytics,
  getCollection,
  collectPayment,
  disputeCollection,
  writeOffCollection,
  cancelCollection,
  closeCollection,
  createInstallmentPlan,
  generatePaymentLink,
  viewCollectionByToken,
  sendReminder,
  listCollectionReminders,
  createCustomerDeposit
} from "../controllers/CustomerCollectionController.js";
import {
  createCurrency,
  listCurrencies,
  getCurrency,
  activateCurrency,
  suspendCurrency,
  archiveCurrency,
  createExchangeRate,
  listExchangeRates,
  importExchangeRates,
  convertCurrency,
  runRevaluation,
  listRevaluations,
  getCurrencyExposure
} from "../controllers/CurrencyController.js";
import {
  createTaxRule,
  listTaxRules,
  getTaxRule,
  approveTaxRule,
  archiveTaxRule,
  calculateTax,
  calculateWithholdingTax,
  createExemption,
  listExemptions,
  revokeExemption,
  generateTaxReport,
  listTaxReports
} from "../controllers/TaxController.js";
import {
  createPricingRule,
  listPricingRules,
  getPricingRule,
  approvePricingRule,
  archivePricingRule,
  calculatePrice,
  createPriceList,
  listPriceLists,
  upsertPriceListEntry,
  listPriceListEntries,
  createCoupon,
  listCoupons,
  revokeCoupon
} from "../controllers/PricingController.js";
import {
  createWorkflowDefinition,
  listWorkflowDefinitions,
  getWorkflowDefinition,
  approveWorkflowDefinition,
  archiveWorkflowDefinition,
  startApproval,
  listApprovalRequests,
  getApprovalRequest,
  recordDecision,
  cancelApprovalRequest,
  createDelegation,
  listDelegations,
  revokeDelegation
} from "../controllers/ApprovalWorkflowController.js";
import {
  createSettlement,
  listSettlements,
  getSettlement,
  cancelSettlement,
  completeSettlement,
  createSettlementAdjustment,
  reconcileSettlements,
  fetchGatewaySettlementReport,
  createBatch,
  listBatches,
  getBatch,
  sendBatch,
  completeBatch
} from "../controllers/SettlementController.js";
import {
  generateReport,
  listReports,
  getFinancialReport,
  archiveReport,
  cancelReport,
  drillDownReport,
  exportReport,
  createSchedule,
  listSchedules,
  cancelSchedule
} from "../controllers/FinancialReportController.js";
import {
  getFinancialExecutiveDashboard,
  getFinancialCFODashboard,
  getFinancialTreasuryDashboard,
  getFinancialARDashboard,
  getFinancialAPDashboard,
  getFinancialRevenueDashboard,
  getFinancialExpenseDashboard,
  getFinancialCashFlowDashboard,
  getFinancialTaxDashboard,
  getFinancialCustomDashboard,
  getFinancialDashboardKPIs,
  getFinancialDashboardTrends,
  getFinancialCEODashboard,
  getFinancialBoardDashboard,
  getFinancialDepartmentDashboard,
  refreshFinancialDashboard,
  listDashboardAlerts,
  acknowledgeDashboardAlert,
  drillThroughDashboard,
  getDashboardPreferences,
  saveDashboardPreferences
} from "../controllers/FinancialDashboardController.js";
import {
  runAnalysis,
  listAnalytics,
  getFinancialAnalysis,
  cancelAnalysis,
  archiveAnalysis
} from "../controllers/FinancialAnalyticsController.js";
import {
  recordEvent,
  listEvents,
  verifyIntegrity,
  getEntityTimeline,
  getUserActivity,
  getCorrelatedEvents,
  getFinancialAuditEvent,
  setLegalHold,
  exportEvidence,
  checkSegregationOfDuties,
  checkRoleConflicts,
  createPolicy,
  listPolicies,
  updatePolicyStatus
} from "../controllers/AuditComplianceController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 15 minutes."
});

// Receipts — docs/05-api/07-finance-api.md Part 8's "Public Verification
// API." Deliberately registered BEFORE router.use(authenticateAccessToken)
// below, so these two stay public while everything else in this file
// (including every other /receipts route) is protected — Express applies
// middleware only to routes registered after it, same principle
// routes/VisaRoutes.js uses (there via per-route auth instead of a blanket
// router.use()). Access control is the unguessable token in the URL, not a
// login — see controllers/ReceiptController.js's own doc comments on these
// two handlers for the full reasoning. Do not move these below the
// router.use() line.
router.get("/receipts/verify/:token", limiter, verifyReceipt);
router.get("/receipts/download/:token", limiter, downloadReceiptPdf);

// Customer Payments — docs/05-api/07-finance-api.md Part 18's own payment
// link. GET-only by design (see CustomerCollectionService.getCollectionByToken's
// doc comment for why there is deliberately no unauthenticated pay-via-token
// POST endpoint) — same public-token-as-access-control convention as the
// two Receipt routes above. Do not move this below the router.use() line.
router.get("/customer-payments/pay/:token", limiter, viewCollectionByToken);

// Finance data is tenant-owned (customer/company financial records) — never
// public, matching every other tenant-scoped route group in this codebase.
router.use(authenticateAccessToken);

// Chart of Accounts — docs/05-api/07-finance-api.md Part 2.
router.get("/accounts", limiter, listAccounts);
router.post("/accounts", limiter, validate(accountSchemas.createAccount), createAccount);
router.get("/accounts/:accountId", limiter, getAccount);
router.patch("/accounts/:accountId", limiter, validate(accountSchemas.updateAccount), updateAccount);
router.delete("/accounts/:accountId", limiter, deactivateAccount);

// General Journal — docs/05-api/07-finance-api.md Part 3.
router.get("/journals", limiter, listJournals);
router.post("/journals", limiter, validate(journalSchemas.createJournal), createJournal);
router.get("/journals/:journalId", limiter, getJournal);
router.patch("/journals/:journalId", limiter, validate(journalSchemas.updateJournal), updateJournal);
router.post("/journals/:journalId/approve", limiter, approveJournal);
router.post("/journals/:journalId/reject", limiter, validate(journalSchemas.rejectJournal), rejectJournal);
router.post("/journals/:journalId/cancel", limiter, cancelJournal);
router.post("/journals/:journalId/post", limiter, postJournal);
router.post("/journals/:journalId/reverse", limiter, validate(journalSchemas.reverseJournal), reverseJournal);

// General Ledger — docs/05-api/07-finance-api.md Part 4. Static paths
// registered before the dynamic /:accountId/balance path.
router.get("/general-ledger/trial-balance", limiter, getTrialBalance);
router.post("/general-ledger/recalculate", limiter, recalculateLedger);
router.get("/general-ledger/:accountId/balance", limiter, getAccountBalance);
router.get("/general-ledger", limiter, listLedgerEntries);

// Accounts Receivable — docs/05-api/07-finance-api.md Part 5.
router.get("/accounts-receivable", limiter, listReceivables);
router.post("/accounts-receivable", limiter, validate(receivableSchemas.createReceivable), createReceivable);
router.get("/accounts-receivable/:receivableId", limiter, getReceivable);
router.post("/accounts-receivable/:receivableId/allocate-payment", limiter, validate(receivableSchemas.allocatePayment), allocateReceivablePayment);
router.post("/accounts-receivable/:receivableId/write-off", limiter, validate(receivableSchemas.writeOffReceivable), writeOffReceivable);

// Enterprise Payment Engine — docs/05-api/07-finance-api.md Part 7.
router.get("/payments", limiter, listPayments);
router.post("/payments", limiter, validate(paymentSchemas.createPayment), createPayment);
router.get("/payments/:paymentId", limiter, getPayment);
router.post("/payments/:paymentId/allocate", limiter, validate(paymentSchemas.allocate), allocatePaymentGeneric);
router.post("/payments/:paymentId/void", limiter, validate(paymentSchemas.void), voidPayment);
router.post("/payments/:paymentId/refund", limiter, validate(paymentSchemas.refund), refundPayment);

// Accounts Payable — docs/05-api/07-finance-api.md Part 6.
router.get("/accounts-payable", limiter, listPayables);
router.post("/accounts-payable", limiter, validate(payableSchemas.createPayable), createPayable);
router.get("/accounts-payable/:payableId", limiter, getPayable);
router.post("/accounts-payable/:payableId/approve", limiter, approvePayable);
router.post("/accounts-payable/:payableId/allocate-payment", limiter, validate(payableSchemas.allocatePayment), allocatePayablePayment);
router.post("/accounts-payable/:payableId/write-off", limiter, validate(payableSchemas.writeOffPayable), writeOffPayable);
router.post("/accounts-payable/:payableId/schedule-payment", limiter, validate(payableSchemas.schedulePayment), schedulePayment);

// Minimal Vendors (see controllers/VendorController.js doc comment).
router.get("/vendors", limiter, listVendors);
router.post("/vendors", limiter, validate(vendorSchemas.createVendor), createVendor);
router.get("/vendors/:vendorId", limiter, getVendor);

// Enterprise Receipts — docs/05-api/07-finance-api.md Part 8. The public
// verify/download routes for this same resource are registered above,
// before authenticateAccessToken.
router.get("/receipts", limiter, listReceipts);
router.post("/receipts", limiter, validate(receiptSchemas.createReceipt), createReceipt);
router.get("/receipts/:receiptId", limiter, getReceipt);
router.post("/receipts/:receiptId/reissue", limiter, validate(receiptSchemas.reissue), reissueReceipt);
router.post("/receipts/:receiptId/cancel", limiter, validate(receiptSchemas.cancel), cancelReceipt);
router.post("/receipts/:receiptId/redeliver", limiter, validate(receiptSchemas.redeliver), redeliverReceipt);

// Enterprise Invoices — docs/05-api/07-finance-api.md Part 9.
router.get("/invoices", limiter, listInvoices);
router.post("/invoices", limiter, validate(invoiceSchemas.createInvoice), createInvoice);
router.get("/invoices/:invoiceId", limiter, getInvoice);
router.patch("/invoices/:invoiceId", limiter, validate(invoiceSchemas.updateInvoice), updateInvoice);
router.post("/invoices/:invoiceId/approve", limiter, approveInvoice);
router.post("/invoices/:invoiceId/issue", limiter, issueInvoice);
router.post("/invoices/:invoiceId/cancel", limiter, validate(invoiceSchemas.cancel), cancelInvoiceAction);
router.post("/invoices/:invoiceId/void", limiter, validate(invoiceSchemas.void), voidInvoice);
router.post("/invoices/:invoiceId/close", limiter, closeInvoice);

// Enterprise Credit Notes — docs/05-api/07-finance-api.md Part 10.
router.get("/credit-notes", limiter, listCreditNotes);
router.post("/credit-notes", limiter, validate(creditNoteSchemas.createCreditNote), createCreditNote);
router.get("/credit-notes/:creditNoteId", limiter, getCreditNote);
router.post("/credit-notes/:creditNoteId/approve", limiter, approveCreditNote);
router.post("/credit-notes/:creditNoteId/issue", limiter, issueCreditNote);
router.post("/credit-notes/:creditNoteId/allocate", limiter, allocateCreditNote);
router.post("/credit-notes/:creditNoteId/cancel", limiter, validate(creditNoteSchemas.cancel), cancelCreditNote);
router.post("/credit-notes/:creditNoteId/void", limiter, validate(creditNoteSchemas.void), voidCreditNote);
router.post("/credit-notes/:creditNoteId/close", limiter, closeCreditNote);

// Enterprise Debit Notes — docs/05-api/07-finance-api.md Part 11.
router.get("/debit-notes", limiter, listDebitNotes);
router.post("/debit-notes", limiter, validate(debitNoteSchemas.createDebitNote), createDebitNote);
router.get("/debit-notes/:debitNoteId", limiter, getDebitNote);
router.post("/debit-notes/:debitNoteId/approve", limiter, approveDebitNote);
router.post("/debit-notes/:debitNoteId/issue", limiter, issueDebitNote);
router.post("/debit-notes/:debitNoteId/allocate", limiter, allocateDebitNote);
router.post("/debit-notes/:debitNoteId/cancel", limiter, validate(debitNoteSchemas.cancel), cancelDebitNote);
router.post("/debit-notes/:debitNoteId/void", limiter, validate(debitNoteSchemas.void), voidDebitNote);
router.post("/debit-notes/:debitNoteId/close", limiter, closeDebitNote);

// Enterprise Refund Management — docs/05-api/07-finance-api.md Part 12.
// Chargeback routes (a static "/refunds/chargebacks..." sub-path) are
// registered BEFORE the dynamic "/refunds/:refundId" routes below — same
// static-before-dynamic ordering already used for General Ledger's
// trial-balance route above — so "chargebacks" is never captured as a
// :refundId param.
router.get("/refunds/chargebacks", limiter, listChargebacks);
router.post("/refunds/chargebacks", limiter, validate(chargebackSchemas.createChargeback), createChargeback);
router.get("/refunds/chargebacks/:chargebackId", limiter, getChargeback);
router.post("/refunds/chargebacks/:chargebackId/evidence", limiter, validate(chargebackSchemas.submitEvidence), submitChargebackEvidence);
router.post("/refunds/chargebacks/:chargebackId/resolve", limiter, validate(chargebackSchemas.resolve), resolveChargeback);

router.get("/refunds", limiter, listRefunds);
router.post("/refunds", limiter, validate(refundSchemas.createRefund), createRefund);
router.get("/refunds/:refundId", limiter, getRefund);
router.post("/refunds/:refundId/review", limiter, reviewRefund);
router.post("/refunds/:refundId/approve", limiter, approveRefund);
router.post("/refunds/:refundId/reject", limiter, validate(refundSchemas.reject), rejectRefund);
router.post("/refunds/:refundId/process", limiter, processRefund);
router.post("/refunds/:refundId/cancel", limiter, validate(refundSchemas.cancel), cancelRefund);

// Enterprise Bank Accounts — docs/05-api/07-finance-api.md Part 13.
router.get("/bank-accounts", limiter, listBankAccounts);
router.post("/bank-accounts", limiter, validate(bankAccountSchemas.createBankAccount), createBankAccount);
router.get("/bank-accounts/:accountId", limiter, getBankAccount);
router.patch("/bank-accounts/:accountId", limiter, validate(bankAccountSchemas.updateBankAccount), updateBankAccount);
router.post("/bank-accounts/:accountId/verify", limiter, verifyBankAccount);
router.post("/bank-accounts/:accountId/activate", limiter, activateBankAccount);
router.post("/bank-accounts/:accountId/freeze", limiter, validate(bankAccountSchemas.freeze), freezeBankAccount);
router.post("/bank-accounts/:accountId/reopen", limiter, reopenBankAccount);
router.post("/bank-accounts/:accountId/suspend", limiter, validate(bankAccountSchemas.suspend), suspendBankAccount);
router.post("/bank-accounts/:accountId/close", limiter, validate(bankAccountSchemas.close), closeBankAccount);
router.post("/bank-accounts/:accountId/archive", limiter, archiveBankAccount);
router.post("/bank-accounts/:accountId/adjust-balance", limiter, validate(bankAccountSchemas.adjustBalance), adjustBalance);
router.post("/bank-accounts/:accountId/hold", limiter, validate(bankAccountSchemas.hold), holdFunds);
router.post("/bank-accounts/:accountId/release-hold", limiter, validate(bankAccountSchemas.releaseHold), releaseHold);
router.post("/bank-accounts/:accountId/virtual-accounts", limiter, validate(bankAccountSchemas.createVirtualAccount), createVirtualAccount);
router.post("/bank-accounts/:accountId/link-settlement-account", limiter, validate(bankAccountSchemas.linkSettlementAccount), linkSettlementAccount);
router.get("/bank-accounts/:accountId/transactions", limiter, listBankTransactions);

// Enterprise Bank Reconciliation — docs/05-api/07-finance-api.md Part 14.
// Static "/bank-reconciliation/import" and "/bank-reconciliation/exceptions/..."
// routes registered BEFORE the dynamic "/bank-reconciliation/:reconciliationId"
// routes below — same static-before-dynamic ordering already used for
// Refund's chargebacks (Part 12) and General Ledger's trial-balance route.
router.post("/bank-reconciliation/import", limiter, uploadStatementFile, validate(bankReconciliationSchemas.importStatement), importStatement);
router.post("/bank-reconciliation/exceptions/:exceptionId/resolve", limiter, validate(bankReconciliationSchemas.resolveException), resolveException);

router.get("/bank-reconciliation", limiter, listReconciliations);
router.get("/bank-reconciliation/:reconciliationId", limiter, getReconciliation);
router.post("/bank-reconciliation/:reconciliationId/auto-match", limiter, runAutoMatch);
router.post("/bank-reconciliation/:reconciliationId/match", limiter, validate(bankReconciliationSchemas.matchTransaction), matchTransaction);
router.post("/bank-reconciliation/:reconciliationId/unmatch", limiter, validate(bankReconciliationSchemas.unmatchTransaction), unmatchTransaction);
router.get("/bank-reconciliation/:reconciliationId/transactions", limiter, listStatementTransactions);
router.get("/bank-reconciliation/:reconciliationId/exceptions", limiter, listExceptions);
router.post("/bank-reconciliation/:reconciliationId/adjustments", limiter, validate(bankReconciliationSchemas.createAdjustment), createAdjustment);
router.post("/bank-reconciliation/:reconciliationId/approve", limiter, approveReconciliation);
router.post("/bank-reconciliation/:reconciliationId/complete", limiter, completeReconciliation);
router.post("/bank-reconciliation/:reconciliationId/reject", limiter, validate(bankReconciliationSchemas.reject), rejectReconciliation);
router.post("/bank-reconciliation/:reconciliationId/reopen", limiter, reopenReconciliation);
router.post("/bank-reconciliation/:reconciliationId/archive", limiter, archiveReconciliation);
router.post("/bank-reconciliation/:reconciliationId/ai-suggest", limiter, suggestAiMatches);
router.post("/bank-reconciliation/:reconciliationId/ai-accept", limiter, validate(bankReconciliationSchemas.matchTransaction), acceptAiSuggestion);
router.get("/bank-reconciliation/:reconciliationId/report", limiter, getReport);
router.get("/bank-reconciliation/:reconciliationId/report/export", limiter, exportReportCsv);

// Enterprise Cash Management — docs/05-api/07-finance-api.md Part 15.
router.get("/cash-locations", limiter, listCashLocations);
router.post("/cash-locations", limiter, validate(cashManagementSchemas.createCashLocation), createCashLocation);
router.get("/cash-locations/:cashLocationId", limiter, getCashLocation);
router.patch("/cash-locations/:cashLocationId", limiter, validate(cashManagementSchemas.updateCashLocation), updateCashLocation);
router.post("/cash-locations/:cashLocationId/close", limiter, validate(cashManagementSchemas.close), closeCashLocation);
router.post("/cash-locations/:cashLocationId/archive", limiter, archiveCashLocation);
router.get("/cash-locations/:cashLocationId/transactions", limiter, listCashLocationTransactions);
router.post("/cash-locations/:cashLocationId/counts", limiter, validate(cashManagementSchemas.createCashCount), createCashCount);
router.post("/cash-locations/:cashLocationId/petty-cash/advances", limiter, validate(cashManagementSchemas.issuePettyCashAdvance), issuePettyCashAdvance);
router.post("/cash-locations/:cashLocationId/petty-cash/replenish", limiter, validate(cashManagementSchemas.replenishPettyCash), replenishPettyCash);

router.get("/cash-transfers", limiter, listCashTransfers);
router.post("/cash-transfers", limiter, validate(cashManagementSchemas.createCashTransfer), createCashTransfer);
router.get("/cash-transfers/:transferId", limiter, getCashTransfer);
router.post("/cash-transfers/:transferId/approve", limiter, approveCashTransfer);
router.post("/cash-transfers/:transferId/reject", limiter, validate(cashManagementSchemas.reject), rejectCashTransfer);
router.post("/cash-transfers/:transferId/cancel", limiter, validate(cashManagementSchemas.cancel), cancelCashTransfer);

router.get("/cash-counts", limiter, listCashCounts);
router.get("/cash-counts/:countId", limiter, getCashCount);
router.post("/cash-counts/:countId/resolve", limiter, validate(cashManagementSchemas.resolveVariance), resolveCashCountVariance);

router.get("/petty-cash/advances", limiter, listPettyCashAdvances);
router.get("/petty-cash/advances/:advanceId", limiter, getPettyCashAdvance);
router.post("/petty-cash/advances/:advanceId/settle", limiter, validate(cashManagementSchemas.settlePettyCashAdvance), settlePettyCashAdvance);

router.get("/cash-management/forecast", limiter, forecastCashNeeds);

// Enterprise Expense Management — docs/05-api/07-finance-api.md Part 16.
router.get("/expense-budgets", limiter, listExpenseBudgets);
router.post("/expense-budgets", limiter, validate(expenseSchemas.createBudget), createExpenseBudget);
router.get("/expense-budgets/:budgetId", limiter, getExpenseBudget);

router.get("/expenses", limiter, listExpenses);
router.post("/expenses", limiter, validate(expenseSchemas.createExpense), createExpense);
router.get("/expenses/:expenseId", limiter, getExpense);
router.patch("/expenses/:expenseId", limiter, validate(expenseSchemas.updateExpense), updateExpense);
router.post("/expenses/:expenseId/receipts", limiter, uploadReceiptFile, uploadReceipt);
router.post("/expenses/:expenseId/receipts/:attachmentId/verify", limiter, validate(expenseSchemas.verifyReceipt), verifyExpenseReceipt);
router.post("/expenses/:expenseId/submit", limiter, submitExpense);
router.post("/expenses/:expenseId/approve", limiter, validate(expenseSchemas.approve), approveExpense);
router.post("/expenses/:expenseId/reject", limiter, validate(expenseSchemas.reject), rejectExpense);
router.post("/expenses/:expenseId/return", limiter, validate(expenseSchemas.returnExpense), returnExpense);
router.post("/expenses/:expenseId/cancel", limiter, validate(expenseSchemas.cancel), cancelExpense);
router.post("/expenses/:expenseId/reimburse", limiter, validate(expenseSchemas.reimburse), reimburseExpense);
router.post("/expenses/:expenseId/close", limiter, closeExpense);

// Enterprise Vendor Payments — docs/05-api/07-finance-api.md Part 17.
router.post("/vendors/:vendorId/bank-accounts", limiter, validate(vendorPaymentSchemas.addVendorBankAccount), addVendorBankAccount);
router.get("/vendors/:vendorId/bank-accounts", limiter, listVendorBankAccounts);
router.post("/vendors/:vendorId/bank-accounts/:bankAccountRecordId/set-primary", limiter, setPrimaryVendorBankAccount);

// Static routes registered BEFORE the dynamic "/vendor-payments/:vendorPaymentId"
// routes below — same static-before-dynamic ordering already used
// repeatedly this session (Refund's chargebacks, Bank Reconciliation's
// exceptions, ...).
router.post("/vendor-payments/advances", limiter, validate(vendorPaymentSchemas.createAdvance), createVendorAdvance);
router.get("/vendor-payments/suggest-timing", limiter, suggestPaymentTiming);
router.post("/vendor-payments/file", limiter, validate(vendorPaymentSchemas.generateFile), generatePaymentFile);

router.get("/vendor-payments", limiter, listVendorPayments);
router.post("/vendor-payments", limiter, validate(vendorPaymentSchemas.createProposal), createVendorPaymentProposal);
router.get("/vendor-payments/:vendorPaymentId", limiter, getVendorPayment);
router.post("/vendor-payments/:vendorPaymentId/approve", limiter, approveVendorPayment);
router.post("/vendor-payments/:vendorPaymentId/reject", limiter, validate(vendorPaymentSchemas.reject), rejectVendorPayment);
router.post("/vendor-payments/:vendorPaymentId/cancel", limiter, validate(vendorPaymentSchemas.cancel), cancelVendorPayment);
router.post("/vendor-payments/:vendorPaymentId/hold", limiter, validate(vendorPaymentSchemas.hold), holdVendorPayment);
router.post("/vendor-payments/:vendorPaymentId/release-hold", limiter, releaseVendorPaymentHold);
router.post("/vendor-payments/:vendorPaymentId/schedule", limiter, scheduleVendorPayment);
router.post("/vendor-payments/:vendorPaymentId/execute", limiter, executeVendorPayment);

router.get("/payment-batches", limiter, listPaymentBatches);
router.post("/payment-batches", limiter, validate(vendorPaymentSchemas.createBatch), createPaymentBatch);
router.get("/payment-batches/:batchId", limiter, getPaymentBatch);
router.post("/payment-batches/:batchId/execute", limiter, executePaymentBatch);

// Enterprise Customer Payments — docs/05-api/07-finance-api.md Part 18.
// "The Customer Collection Platform manages the collection strategy. The
// Payment Engine performs the actual payment." Static routes registered
// BEFORE the dynamic "/customer-payments/:collectionId" routes below —
// same static-before-dynamic ordering used repeatedly this session.
router.post("/customer-payments/deposits", limiter, validate(customerCollectionSchemas.createDeposit), createCustomerDeposit);
router.get("/customer-payments/analytics", limiter, getCollectionAnalytics);

router.get("/customer-payments", limiter, listCollections);
router.post("/customer-payments", limiter, validate(customerCollectionSchemas.createCollectionRequest), createCollectionRequest);
router.get("/customer-payments/:collectionId", limiter, getCollection);
router.post("/customer-payments/:collectionId/collect", limiter, validate(customerCollectionSchemas.collectPayment), collectPayment);
router.post("/customer-payments/:collectionId/dispute", limiter, validate(customerCollectionSchemas.dispute), disputeCollection);
router.post("/customer-payments/:collectionId/write-off", limiter, validate(customerCollectionSchemas.writeOff), writeOffCollection);
router.post("/customer-payments/:collectionId/cancel", limiter, validate(customerCollectionSchemas.cancel), cancelCollection);
router.post("/customer-payments/:collectionId/close", limiter, closeCollection);
router.post("/customer-payments/:collectionId/installments", limiter, validate(customerCollectionSchemas.createInstallmentPlan), createInstallmentPlan);
router.post("/customer-payments/:collectionId/payment-link", limiter, generatePaymentLink);
router.post("/customer-payments/:collectionId/send-reminder", limiter, validate(customerCollectionSchemas.sendReminder), sendReminder);
router.get("/customer-payments/:collectionId/reminders", limiter, listCollectionReminders);

// Enterprise Multi-Currency & Foreign Exchange — docs/05-api/07-finance-api.md
// Part 19. Static routes registered BEFORE the dynamic
// "/currencies/:currencyId" routes below — same static-before-dynamic
// ordering used repeatedly this session.
router.get("/currencies/convert", limiter, convertCurrency);
router.get("/currencies/exposure", limiter, getCurrencyExposure);
router.post("/currencies/revalue", limiter, validate(currencySchemas.runRevaluation), runRevaluation);
router.get("/currencies/revaluations", limiter, listRevaluations);

router.get("/exchange-rates", limiter, listExchangeRates);
router.post("/exchange-rates", limiter, validate(currencySchemas.createExchangeRate), createExchangeRate);
router.post("/exchange-rates/import", limiter, validate(currencySchemas.importRates), importExchangeRates);

router.get("/currencies", limiter, listCurrencies);
router.post("/currencies", limiter, validate(currencySchemas.createCurrency), createCurrency);
router.get("/currencies/:currencyId", limiter, getCurrency);
router.post("/currencies/:currencyId/activate", limiter, activateCurrency);
router.post("/currencies/:currencyId/suspend", limiter, validate(currencySchemas.suspend), suspendCurrency);
router.post("/currencies/:currencyId/archive", limiter, archiveCurrency);

// Enterprise Tax Engine — docs/05-api/07-finance-api.md Part 20. "A real
// ERP never hardcodes tax logic. It uses a centralized Tax Engine."
// Static routes registered BEFORE the dynamic "/tax-rules/:taxRuleId"
// routes below — same static-before-dynamic ordering used repeatedly
// this session.
router.post("/tax/calculate", limiter, validate(taxSchemas.calculateTax), calculateTax);
router.post("/tax/withholding/calculate", limiter, validate(taxSchemas.calculateWithholding), calculateWithholdingTax);
router.get("/tax/reports", limiter, listTaxReports);
router.post("/tax/reports", limiter, generateTaxReport);

router.get("/tax-exemptions", limiter, listExemptions);
router.post("/tax-exemptions", limiter, validate(taxSchemas.createExemption), createExemption);
router.post("/tax-exemptions/:exemptionId/revoke", limiter, validate(taxSchemas.revokeExemption), revokeExemption);

router.get("/tax-rules", limiter, listTaxRules);
router.post("/tax-rules", limiter, validate(taxSchemas.createTaxRule), createTaxRule);
router.get("/tax-rules/:taxRuleId", limiter, getTaxRule);
router.post("/tax-rules/:taxRuleId/approve", limiter, approveTaxRule);
router.post("/tax-rules/:taxRuleId/archive", limiter, archiveTaxRule);

// Enterprise Discount & Pricing Engine — docs/05-api/07-finance-api.md
// Part 21. "The ERP should never let individual modules calculate
// discounts independently. Instead, every module should ask a
// centralized Pricing & Discount Engine." Static routes registered
// BEFORE the dynamic "/pricing-rules/:ruleId" routes below — same
// static-before-dynamic ordering used repeatedly this session.
router.post("/pricing/calculate", limiter, validate(pricingSchemas.calculatePrice), calculatePrice);

router.get("/coupons", limiter, listCoupons);
router.post("/coupons", limiter, validate(pricingSchemas.createCoupon), createCoupon);
router.post("/coupons/:couponId/revoke", limiter, validate(pricingSchemas.revokeCoupon), revokeCoupon);

router.get("/price-lists", limiter, listPriceLists);
router.post("/price-lists", limiter, validate(pricingSchemas.createPriceList), createPriceList);
router.get("/price-lists/:priceListId/entries", limiter, listPriceListEntries);
router.post("/price-lists/:priceListId/entries", limiter, validate(pricingSchemas.upsertPriceListEntry), upsertPriceListEntry);

router.get("/pricing-rules", limiter, listPricingRules);
router.post("/pricing-rules", limiter, validate(pricingSchemas.createPricingRule), createPricingRule);
router.get("/pricing-rules/:ruleId", limiter, getPricingRule);
router.post("/pricing-rules/:ruleId/approve", limiter, approvePricingRule);
router.post("/pricing-rules/:ruleId/archive", limiter, archivePricingRule);

// Enterprise Financial Approval Workflow — docs/05-api/07-finance-api.md
// Part 22. "The better approach is a centralized Approval Platform."
// Static routes registered BEFORE the dynamic "/approval-workflows/:definitionId"
// routes below — same static-before-dynamic ordering used repeatedly
// this session.
router.post("/approvals/start", limiter, validate(approvalWorkflowSchemas.startApproval), startApproval);
router.get("/approvals", limiter, listApprovalRequests);
router.get("/approvals/:approvalId", limiter, getApprovalRequest);
router.post("/approvals/:approvalId/decision", limiter, validate(approvalWorkflowSchemas.recordDecision), recordDecision);
router.post("/approvals/:approvalId/cancel", limiter, validate(approvalWorkflowSchemas.cancelApproval), cancelApprovalRequest);

router.get("/approval-delegations", limiter, listDelegations);
router.post("/approval-delegations", limiter, validate(approvalWorkflowSchemas.createDelegation), createDelegation);
router.post("/approval-delegations/:delegationId/revoke", limiter, revokeDelegation);

router.get("/approval-workflows", limiter, listWorkflowDefinitions);
router.post("/approval-workflows", limiter, validate(approvalWorkflowSchemas.createWorkflowDefinition), createWorkflowDefinition);
router.get("/approval-workflows/:definitionId", limiter, getWorkflowDefinition);
router.post("/approval-workflows/:definitionId/approve", limiter, approveWorkflowDefinition);
router.post("/approval-workflows/:definitionId/archive", limiter, archiveWorkflowDefinition);

// Enterprise Settlement Engine — docs/05-api/07-finance-api.md Part 23.
// "A payment is when money is authorized or captured. A settlement is
// when the money is actually transferred and finalized." Static routes
// registered BEFORE the dynamic "/settlements/:settlementId" routes
// below — same static-before-dynamic ordering used repeatedly this
// session.
router.post("/settlements/reconcile", limiter, validate(settlementSchemas.reconcile), reconcileSettlements);
router.get("/settlements/gateway-report", limiter, fetchGatewaySettlementReport);

router.get("/settlement-batches", limiter, listBatches);
router.post("/settlement-batches", limiter, validate(settlementSchemas.createBatch), createBatch);
router.get("/settlement-batches/:batchId", limiter, getBatch);
router.post("/settlement-batches/:batchId/send", limiter, validate(settlementSchemas.sendBatch), sendBatch);
router.post("/settlement-batches/:batchId/complete", limiter, completeBatch);

router.get("/settlements", limiter, listSettlements);
router.post("/settlements", limiter, validate(settlementSchemas.createSettlement), createSettlement);
router.get("/settlements/:settlementId", limiter, getSettlement);
router.post("/settlements/:settlementId/cancel", limiter, validate(settlementSchemas.cancelSettlement), cancelSettlement);
router.post("/settlements/:settlementId/complete", limiter, completeSettlement);
router.post("/settlements/:settlementId/adjustments", limiter, validate(settlementSchemas.createAdjustment), createSettlementAdjustment);

// Enterprise Financial Reporting — docs/05-api/07-finance-api.md Part 24.
// "The reporting platform should never calculate business transactions
// directly. Instead, it should read from the General Ledger." Static
// routes registered BEFORE the dynamic "/financial-reports/:reportId"
// routes below — same static-before-dynamic ordering used repeatedly
// this session.
router.get("/report-schedules", limiter, listSchedules);
router.post("/report-schedules", limiter, validate(financialReportSchemas.createSchedule), createSchedule);
router.post("/report-schedules/:scheduleId/cancel", limiter, cancelSchedule);

router.post("/financial-reports/generate", limiter, validate(financialReportSchemas.generateReport), generateReport);
router.get("/financial-reports", limiter, listReports);
router.get("/financial-reports/:reportId", limiter, getFinancialReport);
router.get("/financial-reports/:reportId/drill-down", limiter, drillDownReport);
router.post("/financial-reports/:reportId/export", limiter, validate(financialReportSchemas.exportReport), exportReport);
router.post("/financial-reports/:reportId/archive", limiter, archiveReport);
router.post("/financial-reports/:reportId/cancel", limiter, cancelReport);

// Enterprise Financial Dashboard — docs/05-api/07-finance-api.md Part 25.
// "A report answers 'What happened?' A dashboard answers 'What is
// happening right now?'" Static routes registered BEFORE the dynamic
// "/dashboard-alerts/:id" and "/dashboard-preferences/:dashboardType"
// routes below — same static-before-dynamic ordering used throughout.
router.get("/financial-dashboard/executive", limiter, getFinancialExecutiveDashboard);
router.get("/financial-dashboard/cfo", limiter, getFinancialCFODashboard);
router.get("/financial-dashboard/treasury", limiter, getFinancialTreasuryDashboard);
router.get("/financial-dashboard/accounts-receivable", limiter, getFinancialARDashboard);
router.get("/financial-dashboard/accounts-payable", limiter, getFinancialAPDashboard);
router.get("/financial-dashboard/revenue", limiter, getFinancialRevenueDashboard);
router.get("/financial-dashboard/expense", limiter, getFinancialExpenseDashboard);
router.get("/financial-dashboard/cash-flow", limiter, getFinancialCashFlowDashboard);
router.get("/financial-dashboard/tax", limiter, getFinancialTaxDashboard);
router.get("/financial-dashboard/custom", limiter, getFinancialCustomDashboard);
router.get("/financial-dashboard/kpis", limiter, getFinancialDashboardKPIs);
router.get("/financial-dashboard/trends", limiter, getFinancialDashboardTrends);
router.get("/financial-dashboard/drill-through", limiter, drillThroughDashboard);
// Financial Analytics Platform Enhancements — Part 29.
router.get("/financial-dashboard/ceo", limiter, getFinancialCEODashboard);
router.get("/financial-dashboard/board", limiter, getFinancialBoardDashboard);
router.get("/financial-dashboard/department", limiter, getFinancialDepartmentDashboard);
router.post("/financial-dashboard/refresh", limiter, refreshFinancialDashboard);

router.get("/dashboard-alerts", limiter, listDashboardAlerts);
router.post("/dashboard-alerts/:id/acknowledge", limiter, validate(financialDashboardSchemas.acknowledgeAlert), acknowledgeDashboardAlert);

router.get("/dashboard-preferences/:dashboardType", limiter, getDashboardPreferences);
router.put("/dashboard-preferences/:dashboardType", limiter, validate(financialDashboardSchemas.savePreferences), saveDashboardPreferences);

// Enterprise Financial Analytics — docs/05-api/07-finance-api.md Part 26.
// "Reports describe. Dashboards monitor. Analytics explains, predicts,
// and helps optimize." Static "/financial-analytics/run" registered
// BEFORE the dynamic "/financial-analytics/:analysisId" routes below —
// same static-before-dynamic ordering used throughout.
router.post("/financial-analytics/run", limiter, validate(financialAnalyticsSchemas.runAnalysis), runAnalysis);
router.get("/financial-analytics", limiter, listAnalytics);
router.get("/financial-analytics/:analysisId", limiter, getFinancialAnalysis);
router.post("/financial-analytics/:analysisId/cancel", limiter, cancelAnalysis);
router.post("/financial-analytics/:analysisId/archive", limiter, archiveAnalysis);

// Enterprise Audit & Compliance — docs/05-api/07-finance-api.md Part 27.
// "Who, what, when, where, why, how, before value, after value, approval
// chain, and whether the action complied with organizational or
// regulatory policies." Static routes registered BEFORE the dynamic
// "/audit-events/:eventId" routes below — same static-before-dynamic
// ordering used throughout.
router.get("/audit-events/verify-integrity", limiter, verifyIntegrity);
router.get("/audit-events/role-conflicts", limiter, checkRoleConflicts);
router.get("/audit-events/investigation/timeline", limiter, getEntityTimeline);
router.get("/audit-events/investigation/user-activity", limiter, getUserActivity);
router.get("/audit-events/investigation/correlation", limiter, getCorrelatedEvents);
router.post("/audit-events/export", limiter, validate(auditComplianceSchemas.exportEvidence), exportEvidence);
router.get("/audit-events/segregation-of-duties/:entityType/:entityId", limiter, checkSegregationOfDuties);

router.get("/audit-events", limiter, listEvents);
router.post("/audit-events", limiter, validate(auditComplianceSchemas.recordEvent), recordEvent);
router.get("/audit-events/:eventId", limiter, getFinancialAuditEvent);
router.post("/audit-events/:eventId/legal-hold", limiter, validate(auditComplianceSchemas.setLegalHold), setLegalHold);

router.get("/compliance-policies", limiter, listPolicies);
router.post("/compliance-policies", limiter, validate(auditComplianceSchemas.createPolicy), createPolicy);
router.post("/compliance-policies/:policyId/status", limiter, validate(auditComplianceSchemas.updatePolicyStatus), updatePolicyStatus);

export default router;
