import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { requireFeature, subscriptionResponseHeaders } from "../middleware/subscriptionEnforcement.js";
import { enterpriseRateLimit } from "../middleware/rateLimiter.js";
import idempotency from "../middleware/idempotency.js";
import validate, { accountSchemas, journalSchemas, receivableSchemas, paymentSchemas, payableSchemas, vendorSchemas, receiptSchemas, invoiceSchemas, creditNoteSchemas, debitNoteSchemas, refundSchemas, chargebackSchemas, bankAccountSchemas, bankReconciliationSchemas, cashManagementSchemas, expenseSchemas, vendorPaymentSchemas, customerCollectionSchemas, currencySchemas, taxSchemas, pricingSchemas, approvalWorkflowSchemas, settlementSchemas, financialReportSchemas, financialDashboardSchemas, financialAnalyticsSchemas, auditComplianceSchemas, planningSchemas, treasurySchemas, governanceSchemas, financePlatformSchemas, walletSchemas, subscriptionSchemas, collectionCampaignSchemas, webhookSchemas } from "../middleware/validateRequest.js";
import { processFinancialRequest, getPlatformArchitecture, getPlatformHealthStatus } from "../controllers/FinancePlatformOrchestrationController.js";

import {
  createBudget,
  listBudgets,
  getBudget,
  updateBudget,
  submitBudget,
  approveBudget,
  publishBudget,
  createBudgetRevision,
  getBudgetRevisions,
  generateForecast,
  listForecasts,
  getForecast,
  calculateVariance,
  listVariances,
  getVariance,
  createScenario,
  listScenarios,
  getScenario,
  evaluateScenario,
  getPlanningDashboard
} from "../controllers/EnterprisePlanningController.js";
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deactivateAccount,
  reactivateAccount,
  suspendAccount,
  archiveAccount,
  mergeAccounts,
  listAccountTemplates,
  getAccountTemplate,
  createAccountTemplate,
  applyAccountTemplate
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
  reverseJournal,
  correctJournal,
  getJournalHistory,
  listJournalTemplates,
  getJournalTemplate,
  createJournalTemplate,
  applyJournalTemplate,
  createRecurringJournal,
  listRecurringJournals,
  getRecurringJournal,
  pauseRecurringJournal,
  resumeRecurringJournal,
  cancelRecurringJournal,
  createJournalBatch,
  listJournalBatches,
  getJournalBatch,
  createRevenueRecognitionJournal,
  searchJournals,
  getJournalStatistics,
  uploadJournalAttachmentFile,
  addJournalAttachment,
  uploadJournalImportFile,
  previewJournalImport,
  importJournals,
  archiveJournal,
  restoreJournal
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
  refundPayment,
  retryPayment
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
  exportExpenses,
  bulkApproveExpenses,
  bulkRejectExpenses,
  bulkTagExpenses,
  bulkArchiveExpenses,
  bulkCommentExpenses,
  bulkAssignReviewerExpenses,
  bulkRecalculateExpenseBudgets,
  bulkRevalidateExpensePolicies,
  uploadReceipt,
  verifyExpenseReceipt,
  correctReceiptOcr,
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
  captureCollectionPayment,
  disputeCollection,
  writeOffCollection,
  cancelCollection,
  closeCollection,
  createInstallmentPlan,
  rescheduleInstallment,
  cancelInstallmentPlan,
  settleInstallmentPlanEarly,
  generatePaymentLink,
  viewCollectionByToken,
  sendReminder,
  listCollectionReminders,
  createCustomerDeposit,
  allocatePayment,
  listCustomerCredits,
  getCustomerRiskScore,
  uploadCollectionAttachmentFile,
  uploadCollectionAttachment,
  listCollectionAttachments,
  addCollectionComment,
  listCollectionComments,
  addCollectionTimelineEntry,
  regeneratePaymentLink,
  allocateAdvance,
  reopenCollection,
  getCollectionAuditTrail,
  getCollectionHistory
} from "../controllers/CustomerCollectionController.js";
import {
  createWallet,
  listWallets,
  getWallet,
  listWalletTransactions,
  topUpWallet,
  purchaseWithWallet,
  refundToWallet,
  transferWallet,
  withdrawWallet,
  suspendWallet,
  reactivateWallet,
  closeWallet
} from "../controllers/WalletController.js";
import {
  createSubscription,
  listSubscriptions,
  getSubscription,
  runSubscriptionBillingCycle,
  recordSubscriptionUsage,
  changeSubscriptionPlan,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  terminateSubscription
} from "../controllers/SubscriptionController.js";
import {
  createCampaign,
  listCampaigns,
  getCampaign,
  previewCampaignTargets,
  runCampaign,
  cancelCampaign
} from "../controllers/CollectionCampaignController.js";
import {
  generateCustomerPortalToken,
  viewCustomerPortalByToken
} from "../controllers/CustomerPortalController.js";
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
  getWebhookSubscription,
  rotateWebhookSecret,
  suspendWebhookSubscription,
  reactivateWebhookSubscription,
  disableWebhookSubscription,
  listWebhookDeliveries,
  replayWebhookDelivery,
  getWebhookMonitoringSummary
} from "../controllers/WebhookController.js";
import {
  createCurrency,
  listCurrencies,
  getCurrency,
  submitCurrencyForApproval,
  approveCurrencyDefinition,
  activateCurrency,
  suspendCurrency,
  archiveCurrency,
  deprecateCurrency,
  createExchangeRate,
  approveExchangeRate,
  rejectExchangeRate,
  listExchangeRates,
  getExchangeRate,
  importExchangeRates,
  convertCurrency,
  convertCurrencyViaApi,
  runRevaluation,
  listRevaluations,
  getCurrencyExposure,
  getCurrencyDashboard,
  listConversions
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
  refreshAnalytics,
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
import {
  calculateCashPosition,
  getCashPosition,
  getTreasuryDashboard,
  syncBankBalances,
  generateLiquidityForecast,
  listLiquidityForecasts,
  createInvestment,
  listInvestments,
  getInvestmentById,
  updateInvestmentStatus,
  recordDebt,
  listDebts,
  getDebtById,
  updateDebtStatus,
  calculateFXExposure,
  getFXExposures,
  evaluateTreasuryRisks,
  getTreasuryRisks
} from "../controllers/TreasuryController.js";
import {
  evaluateGovernance,
  listPolicies as listGovernancePolicies,
  createPolicy as createGovernancePolicy,
  listSoDRules,
  createSoDRule,
  listEvidencePackages,
  getEvidenceById,
  listFraudRules,
  createFraudRule,
  getGovernanceDashboard
} from "../controllers/FinancialGovernanceController.js";

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

// Customer Self-Service Portal — docs/05-api/07-finance-api.md Part 18
// Part 4. Same public-token-as-access-control convention as the two
// routes above; GET-only (see CustomerPortalService's own doc comment for
// why). Do not move this below the router.use() line.
router.get("/customer-portal/:token", limiter, viewCustomerPortalByToken);

// Finance data is tenant-owned (customer/company financial records) — never
// public, matching every other tenant-scoped route group in this codebase.
router.use(authenticateAccessToken);
// Enterprise Subscription Platform — "Refactor Pattern 1... Finance
// Enabled? No -> 403." The real, router-level "every endpoint" feature
// gate — every route below already went through authenticateAccessToken's
// own real-time subscription-status check; this is the additional
// per-module Feature Entitlement layer (see middleware/subscriptionEnforcement.js's
// own doc comment for why this is the correct retrofit shape, not
// hundreds of individual per-route edits). No-op for any tenant with no
// subscription row.
router.use(requireFeature("finance"));
router.use(subscriptionResponseHeaders);
// Enterprise Subscription Enforcement Middleware (Automation #6) — "API
// Rate Limiting Integration... Plan -> Requests/Minute." Real,
// plan-tier-aware (utils/rateLimiter.js#resolveLimit now consults the
// tenant's own PlatformPlanModel.limits.maxApiCallsPerDay), distributed,
// MongoDB-backed (Improvement 13). This is `enterpriseRateLimit`'s own
// FIRST real mount onto any business route in this codebase — proof of
// the pattern on this one flagship module; the same one-line mount onto
// every other tenant-scoped router is real, deliberate, incremental
// Adoption work, not claimed complete here.
router.use(enterpriseRateLimit({ scope: "Tenant" }));

// Chart of Accounts — docs/05-api/07-finance-api.md Part 2, extended Part 36.
router.get("/accounts", limiter, listAccounts);
router.post("/accounts", limiter, validate(accountSchemas.createAccount), createAccount);
router.get("/accounts/:accountId", limiter, getAccount);
router.patch("/accounts/:accountId", limiter, validate(accountSchemas.updateAccount), updateAccount);
router.delete("/accounts/:accountId", limiter, deactivateAccount);
router.post("/accounts/:accountId/reactivate", limiter, reactivateAccount);
router.post("/accounts/:accountId/suspend", limiter, validate(accountSchemas.suspendAccount), suspendAccount);
router.post("/accounts/:accountId/archive", limiter, archiveAccount);
router.post("/accounts/:accountId/merge", limiter, validate(accountSchemas.mergeAccounts), mergeAccounts);

// Chart of Account Templates — Part 36. Static routes registered before the
// dynamic /account-templates/:templateId route.
router.get("/account-templates", limiter, listAccountTemplates);
router.post("/account-templates", limiter, validate(accountSchemas.createTemplate), createAccountTemplate);
router.post("/account-templates/:templateId/apply", limiter, applyAccountTemplate);
router.get("/account-templates/:templateId", limiter, getAccountTemplate);

// General Journal — docs/05-api/07-finance-api.md Part 3.
router.get("/journals", limiter, listJournals);
// "Idempotency Key" (File 2, Journal Platform Part 1) — closes the real,
// pre-existing gap Part 28/33 already flagged (IdempotencyKeyModel +
// middleware/idempotency.js existed but were unused by any Finance
// service). Opt-in via the Idempotency-Key header, same real pattern
// already proven on TravelPlanRoutes/IncidentRoutes/AmadeusIntegrationRoutes
// — never made hard-required, matching this codebase's only existing use
// of this middleware.
router.post("/journals", limiter, idempotency(), validate(journalSchemas.createJournal), createJournal);

// File 2, Journal Platform Part 3 (Part 40) — static /journals/* paths
// registered before the dynamic /journals/:journalId GET route below, so
// Express never mistakes "search"/"statistics" for a journalId. Bulk/
// Template/Recurring here are real, thin aliases onto the exact same
// controllers already mounted at /journal-batches, /journal-templates,
// /recurring-journals (Part 39) — same capability, matching this Part's
// own literal endpoint-path contract. Intercompany/Merchant Settlement/
// Reprocess are not aliased — no backing capability (Intercompany/
// Merchant) or no distinct behavior (Reprocess === calling
// POST /journals/:journalId/post again) to alias onto; see
// docs/05-api/07-finance-api.md Part 40's own "explicitly out of scope" note.
router.get("/journals/search", limiter, searchJournals);
router.get("/journals/statistics", limiter, getJournalStatistics);
router.post("/journals/bulk", limiter, idempotency(), validate(journalSchemas.createJournalBatch), createJournalBatch);
router.post("/journals/templates", limiter, validate(journalSchemas.createJournalTemplate), createJournalTemplate);
router.post("/journals/recurring", limiter, validate(journalSchemas.createRecurringJournal), createRecurringJournal);
router.post("/journals/revenue-recognition", limiter, idempotency(), validate(journalSchemas.createJournal), createRevenueRecognitionJournal);
router.post("/journals/import/preview", limiter, uploadJournalImportFile, previewJournalImport);
router.post("/journals/import", limiter, idempotency(), uploadJournalImportFile, importJournals);

router.get("/journals/:journalId", limiter, getJournal);
router.patch("/journals/:journalId", limiter, validate(journalSchemas.updateJournal), updateJournal);
router.post("/journals/:journalId/approve", limiter, approveJournal);
router.post("/journals/:journalId/reject", limiter, validate(journalSchemas.rejectJournal), rejectJournal);
router.post("/journals/:journalId/cancel", limiter, cancelJournal);
router.post("/journals/:journalId/post", limiter, postJournal);
router.post("/journals/:journalId/reverse", limiter, validate(journalSchemas.reverseJournal), reverseJournal);

// File 2, Journal Platform Part 2 — docs/05-api/07-finance-api.md Part 39.
router.post("/journals/:journalId/correct", limiter, validate(journalSchemas.correctJournal), correctJournal);
router.get("/journals/:journalId/history", limiter, getJournalHistory);
router.post("/journals/:journalId/attachments", limiter, uploadJournalAttachmentFile, addJournalAttachment);

// File 2, Journal Platform Part 4 — docs/05-api/07-finance-api.md Part 41.
router.post("/journals/:journalId/archive", limiter, archiveJournal);
router.post("/journals/:journalId/restore", limiter, restoreJournal);

// Journal Templates — static paths registered before any dynamic
// /journal-templates/:templateId path.
router.get("/journal-templates", limiter, listJournalTemplates);
router.post("/journal-templates", limiter, validate(journalSchemas.createJournalTemplate), createJournalTemplate);
router.post("/journal-templates/:templateId/apply", limiter, idempotency(), validate(journalSchemas.applyJournalTemplate), applyJournalTemplate);
router.get("/journal-templates/:templateId", limiter, getJournalTemplate);

// Recurring Journals.
router.get("/recurring-journals", limiter, listRecurringJournals);
router.post("/recurring-journals", limiter, validate(journalSchemas.createRecurringJournal), createRecurringJournal);
router.get("/recurring-journals/:recurringJournalId", limiter, getRecurringJournal);
router.post("/recurring-journals/:recurringJournalId/pause", limiter, pauseRecurringJournal);
router.post("/recurring-journals/:recurringJournalId/resume", limiter, resumeRecurringJournal);
router.post("/recurring-journals/:recurringJournalId/cancel", limiter, cancelRecurringJournal);

// Journal Batches.
router.get("/journal-batches", limiter, listJournalBatches);
router.post("/journal-batches", limiter, idempotency(), validate(journalSchemas.createJournalBatch), createJournalBatch);
router.get("/journal-batches/:batchId", limiter, getJournalBatch);

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

/**
 * Enterprise OpenAPI / Swagger Standard (Improvement 15) — the flagship,
 * fully-documented endpoint proving the real per-endpoint JSDoc pattern
 * (`swagger-jsdoc` already scans `./routes/*.js` — see
 * config/swaggerConfig.js's own `apis` option). Every field/status/error
 * below reflects this route's REAL validation (`middleware/validateRequest.js#paymentSchemas.createPayment`)
 * and REAL controller behavior (`controllers/PaymentController.js#createPayment`)
 * — not a guessed shape. See docs/07-enterprise-standards/15-openapi-sdk.md
 * "Adoption" for why this is one representative endpoint, not all ~300+
 * Finance/Enterprise-Standards routes in this pass.
 *
 * @swagger
 * /payments:
 *   post:
 *     tags: [Finance — Payments]
 *     summary: Record a payment against a customer or vendor
 *     description: >
 *       Records a real payment, running it through the configured gateway
 *       adapter when `gateway` is a live processor (e.g. `Stripe`) or
 *       recording it directly when `gateway` is `Manual`/omitted. Emits
 *       `PaymentAuthorized`/`PaymentCaptured`/`PaymentFailed` domain
 *       events (Enterprise Event Versioning Standard) and, for any tenant
 *       subscribed to them, a signed webhook delivery (Enterprise Webhook
 *       Standard). Idempotent when called with an `Idempotency-Key` header
 *       (Enterprise Idempotency Standard) — a retried request with the
 *       same key returns the original result rather than creating a
 *       second payment.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         schema: { type: string }
 *         description: Recommended for any client that might retry this call — see the Enterprise Idempotency Standard.
 *       - in: header
 *         name: Correlation-ID
 *         schema: { type: string }
 *         description: Propagated onto every domain event, audit entry, and error response this call produces.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, currency, paymentMethod]
 *             properties:
 *               paymentType: { type: string, example: Customer, description: "Config-driven — Customer, Vendor, Employee, Refund, Advance, Deposit." }
 *               partyType: { type: string, enum: [customer, vendor] }
 *               partyId: { type: string, description: "MongoDB ObjectId of the customer/vendor this payment applies to." }
 *               amount: { type: number, example: 1500.00, description: "Must be greater than 0." }
 *               currency: { type: string, example: USD, description: "Must be one of this tenant's supported currencies." }
 *               paymentMethod: { type: string, example: "Credit Card", description: "Config-driven — Cash, Bank Transfer, Cheque, Credit Card, Wallet, and more." }
 *               gateway: { type: string, example: Stripe, description: "Config-driven — Manual, Stripe, PayPal, and more. Omit or 'Manual' for a directly-recorded payment." }
 *               gatewayPaymentMethodId: { type: string, description: "Real gateway token (e.g. a Stripe PaymentMethod id) — required for a live gateway." }
 *               reference: { type: string, example: "INV-2026-00042" }
 *               transactionDate: { type: string, format: date-time }
 *     responses:
 *       201:
 *         description: Payment recorded/authorized successfully.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         paymentNumber: { type: string, example: "PAY-2026-000123" }
 *                         status: { type: string, example: Completed }
 *                         amount: { type: number, example: 1500.00 }
 *                         currency: { type: string, example: USD }
 *       402:
 *         description: The payment gateway declined the request — a real, terminal business outcome, not a thrown error.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data: { type: object, properties: { status: { type: string, example: Failed } } }
 *       400:
 *         description: Validation failed (missing/invalid amount, currency, or paymentMethod).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       403:
 *         description: No tenant context, or the caller's role lacks the `finance.payment.create` permission.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *     x-rate-limit:
 *       note: "Not yet mounted on this route — see docs/07-enterprise-standards/13-rate-limiting.md Adoption. Once mounted, responses carry the headers below."
 *       headers:
 *         X-RateLimit-Limit: { $ref: '#/components/headers/RateLimitLimit' }
 *         X-RateLimit-Remaining: { $ref: '#/components/headers/RateLimitRemaining' }
 *     x-code-samples:
 *       - lang: cURL
 *         source: |
 *           curl -X POST https://api.example.com/api/v1/payments \
 *             -H "Authorization: Bearer $ACCESS_TOKEN" \
 *             -H "Content-Type: application/json" \
 *             -H "Idempotency-Key: $(uuidgen)" \
 *             -d '{"amount":1500.00,"currency":"USD","paymentMethod":"Credit Card","partyType":"customer","partyId":"64f1ab29c4e1234567890abc"}'
 *       - lang: JavaScript
 *         source: |
 *           const res = await fetch("https://api.example.com/api/v1/payments", {
 *             method: "POST",
 *             headers: {
 *               Authorization: `Bearer ${accessToken}`,
 *               "Content-Type": "application/json",
 *               "Idempotency-Key": crypto.randomUUID()
 *             },
 *             body: JSON.stringify({ amount: 1500.00, currency: "USD", paymentMethod: "Credit Card", partyType: "customer", partyId })
 *           });
 *           const { data: payment } = await res.json();
 */
router.post("/payments", limiter, validate(paymentSchemas.createPayment), createPayment);
router.get("/payments/:paymentId", limiter, getPayment);
router.post("/payments/:paymentId/allocate", limiter, validate(paymentSchemas.allocate), allocatePaymentGeneric);
router.post("/payments/:paymentId/void", limiter, validate(paymentSchemas.void), voidPayment);
router.post("/payments/:paymentId/refund", limiter, validate(paymentSchemas.refund), refundPayment);
// Part 18 Part 5 — "Manual Retry" (Payment Retry Engine). Idempotency-Key
// reused so a double-click can't create two retry payments.
router.post("/payments/:paymentId/retry", limiter, idempotency(), retryPayment);

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
// Enterprise Expense Management Refactor Part 3/4 — bulk/export routes are
// registered BEFORE the `:expenseId` routes below; Express matches routes
// in registration order, and `/expenses/bulk/approve` would otherwise be
// captured by `/expenses/:expenseId/approve` with expenseId="bulk".
router.get("/expenses/export", limiter, exportExpenses);
router.post("/expenses/bulk/approve", limiter, validate(expenseSchemas.bulkApprove), bulkApproveExpenses);
router.post("/expenses/bulk/reject", limiter, validate(expenseSchemas.bulkReject), bulkRejectExpenses);
router.post("/expenses/bulk/tag", limiter, validate(expenseSchemas.bulkTag), bulkTagExpenses);
router.post("/expenses/bulk/archive", limiter, validate(expenseSchemas.bulkIds), bulkArchiveExpenses);
router.post("/expenses/bulk/comment", limiter, validate(expenseSchemas.bulkComment), bulkCommentExpenses);
router.post("/expenses/bulk/assign-reviewer", limiter, validate(expenseSchemas.bulkAssignReviewer), bulkAssignReviewerExpenses);
router.post("/expenses/bulk/recalculate-budget", limiter, validate(expenseSchemas.bulkIds), bulkRecalculateExpenseBudgets);
router.post("/expenses/bulk/revalidate-policy", limiter, validate(expenseSchemas.bulkIds), bulkRevalidateExpensePolicies);
router.get("/expenses/:expenseId", limiter, getExpense);
router.patch("/expenses/:expenseId", limiter, validate(expenseSchemas.updateExpense), updateExpense);
router.post("/expenses/:expenseId/receipts", limiter, uploadReceiptFile, uploadReceipt);
router.post("/expenses/:expenseId/receipts/:attachmentId/verify", limiter, validate(expenseSchemas.verifyReceipt), verifyExpenseReceipt);
router.post("/expenses/:expenseId/receipts/:attachmentId/correct-ocr", limiter, validate(expenseSchemas.correctOcr), correctReceiptOcr);
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
// Payment Allocation Engine / Customer Credit Balance / Customer Credit
// Risk Scoring (Part 18 continuation). `/customer-payments/customers/...`
// keeps the risk-score route inside this Finance-owned path prefix rather
// than a bare `/customers/...` that could collide with CustomerRoutes.js's
// own routing (this is a Finance computation over Customer data, Finance
// does not own Customer per Part 1's own boundary).
router.get("/customer-credits", limiter, listCustomerCredits);
router.get("/customer-payments/customers/:customerId/risk-score", limiter, getCustomerRiskScore);
router.post("/customer-payments/:paymentId/allocate", limiter, validate(customerCollectionSchemas.allocatePayment), allocatePayment);

router.get("/customer-payments", limiter, listCollections);
// Part 18 Part 2 — "Idempotency-Key... Duplicate requests -> Return
// Existing Payment -> Never create duplicate payments." Reuses the
// already-real, generic middleware/idempotency.js (same as journals/
// incidents/travel plans above) rather than a parallel implementation.
router.post("/customer-payments", limiter, idempotency(), validate(customerCollectionSchemas.createCollectionRequest), createCollectionRequest);
router.get("/customer-payments/:collectionId", limiter, getCollection);
// Part 18 Part 3 — Idempotency-Key reused here too (same generic
// middleware/idempotency.js), since a collect/capture retry must never
// double-charge.
router.post("/customer-payments/:collectionId/collect", limiter, idempotency(), validate(customerCollectionSchemas.collectPayment), collectPayment);
router.post("/customer-payments/:collectionId/capture", limiter, idempotency(), validate(customerCollectionSchemas.captureAuthorizedPayment), captureCollectionPayment);
router.post("/customer-payments/:collectionId/dispute", limiter, validate(customerCollectionSchemas.dispute), disputeCollection);
router.post("/customer-payments/:collectionId/write-off", limiter, validate(customerCollectionSchemas.writeOff), writeOffCollection);
router.post("/customer-payments/:collectionId/cancel", limiter, validate(customerCollectionSchemas.cancel), cancelCollection);
router.post("/customer-payments/:collectionId/close", limiter, closeCollection);
router.post("/customer-payments/:collectionId/installments", limiter, validate(customerCollectionSchemas.createInstallmentPlan), createInstallmentPlan);
// Part 18 Part 4 — Installment Rescheduling/Cancellation/Early Settlement.
router.post("/customer-payments/:collectionId/installments/:installmentNumber/reschedule", limiter, validate(customerCollectionSchemas.rescheduleInstallment), rescheduleInstallment);
router.post("/customer-payments/:collectionId/installments/cancel", limiter, validate(customerCollectionSchemas.cancelInstallmentPlan), cancelInstallmentPlan);
router.post("/customer-payments/:collectionId/installments/settle-early", limiter, settleInstallmentPlanEarly);
router.post("/customer-payments/:collectionId/payment-link", limiter, generatePaymentLink);
router.post("/customer-payments/:collectionId/send-reminder", limiter, validate(customerCollectionSchemas.sendReminder), sendReminder);
router.get("/customer-payments/:collectionId/reminders", limiter, listCollectionReminders);

// File 6 Part 5 — API Enhancements (attachments, comments, timeline,
// advance allocation, reopen, audit/history). "Reminders/send" and
// "writeoff" below are deliberate route ALIASES onto the exact same
// pre-existing handlers as send-reminder/write-off above (no duplicated
// logic) — added so both this Part's own literal endpoint contract and
// the original hyphenated routes keep working for any existing caller.
router.post("/customer-payments/:collectionId/attachments", limiter, uploadCollectionAttachmentFile, uploadCollectionAttachment);
router.get("/customer-payments/:collectionId/attachments", limiter, listCollectionAttachments);
router.post("/customer-payments/:collectionId/comments", limiter, validate(customerCollectionSchemas.addComment), addCollectionComment);
router.get("/customer-payments/:collectionId/comments", limiter, listCollectionComments);
router.post("/customer-payments/:collectionId/timeline", limiter, validate(customerCollectionSchemas.addTimelineEntry), addCollectionTimelineEntry);
router.post("/customer-payments/:collectionId/reminders/send", limiter, validate(customerCollectionSchemas.sendReminder), sendReminder);
router.post("/customer-payments/:collectionId/payment-link/regenerate", limiter, idempotency(), regeneratePaymentLink);
router.post("/customer-payments/:collectionId/allocate-advance", limiter, idempotency(), allocateAdvance);
router.post("/customer-payments/:collectionId/writeoff", limiter, validate(customerCollectionSchemas.writeOff), writeOffCollection);
router.post("/customer-payments/:collectionId/reopen", limiter, validate(customerCollectionSchemas.reopen), reopenCollection);
router.get("/customer-payments/:collectionId/audit", limiter, getCollectionAuditTrail);
router.get("/customer-payments/:collectionId/history", limiter, getCollectionHistory);

// Enterprise Customer Payments — Customer Self-Service Portal (Part 18
// Part 4). Only token generation is authenticated (staff-initiated); the
// token view itself is public — see the router.use(authenticateAccessToken)
// section above.
router.post("/customers/:customerId/portal-token", limiter, generateCustomerPortalToken);

// Enterprise Customer Payments — Wallet Support (Part 18 Part 4). Static
// routes registered BEFORE the dynamic "/wallets/:walletId" routes below —
// same static-before-dynamic ordering used repeatedly this session.
router.get("/wallets", limiter, listWallets);
router.post("/wallets", limiter, validate(walletSchemas.createWallet), createWallet);
router.get("/wallets/:walletId", limiter, getWallet);
router.get("/wallets/:walletId/transactions", limiter, listWalletTransactions);
router.post("/wallets/:walletId/topup", limiter, idempotency(), validate(walletSchemas.topUp), topUpWallet);
router.post("/wallets/:walletId/purchase", limiter, idempotency(), validate(walletSchemas.purchase), purchaseWithWallet);
router.post("/wallets/:walletId/refund", limiter, validate(walletSchemas.refund), refundToWallet);
router.post("/wallets/:walletId/transfer", limiter, idempotency(), validate(walletSchemas.transfer), transferWallet);
router.post("/wallets/:walletId/withdraw", limiter, validate(walletSchemas.withdraw), withdrawWallet);
router.post("/wallets/:walletId/suspend", limiter, validate(walletSchemas.suspend), suspendWallet);
router.post("/wallets/:walletId/reactivate", limiter, reactivateWallet);
router.post("/wallets/:walletId/close", limiter, closeWallet);

// Enterprise Customer Payments — Subscription + Membership Billing (Part
// 18 Part 4). One real platform covers both (`planType`) — see
// SubscriptionModel's own doc comment.
router.get("/subscriptions", limiter, listSubscriptions);
router.post("/subscriptions", limiter, validate(subscriptionSchemas.createSubscription), createSubscription);
router.get("/subscriptions/:subscriptionId", limiter, getSubscription);
router.post("/subscriptions/:subscriptionId/bill", limiter, idempotency(), runSubscriptionBillingCycle);
router.post("/subscriptions/:subscriptionId/usage", limiter, validate(subscriptionSchemas.recordUsage), recordSubscriptionUsage);
router.post("/subscriptions/:subscriptionId/change-plan", limiter, validate(subscriptionSchemas.changePlan), changeSubscriptionPlan);
router.post("/subscriptions/:subscriptionId/pause", limiter, validate(subscriptionSchemas.pause), pauseSubscription);
router.post("/subscriptions/:subscriptionId/resume", limiter, resumeSubscription);
router.post("/subscriptions/:subscriptionId/cancel", limiter, validate(subscriptionSchemas.cancel), cancelSubscription);
router.post("/subscriptions/:subscriptionId/terminate", limiter, validate(subscriptionSchemas.terminate), terminateSubscription);

// Enterprise Customer Payments — Collection Campaigns (Part 18 Part 4).
router.get("/collection-campaigns", limiter, listCampaigns);
router.post("/collection-campaigns", limiter, validate(collectionCampaignSchemas.createCampaign), createCampaign);
router.get("/collection-campaigns/:campaignId", limiter, getCampaign);
router.get("/collection-campaigns/:campaignId/preview", limiter, previewCampaignTargets);
router.post("/collection-campaigns/:campaignId/run", limiter, runCampaign);
router.post("/collection-campaigns/:campaignId/cancel", limiter, cancelCampaign);

// Enterprise Customer Payments — Webhook Platform (Part 18 Part 5). Static
// routes registered BEFORE the dynamic "/webhook-subscriptions/:subscriptionId"
// routes below — same static-before-dynamic ordering used repeatedly this
// session.
router.get("/webhook-subscriptions", limiter, listWebhookSubscriptions);
router.post("/webhook-subscriptions", limiter, validate(webhookSchemas.createSubscription), createWebhookSubscription);
// Enterprise Webhook Standard (Improvement 14). Static, before the
// dynamic "/webhook-subscriptions/:subscriptionId" route below.
router.get("/webhook-subscriptions/monitoring/summary", limiter, getWebhookMonitoringSummary);
router.get("/webhook-subscriptions/:subscriptionId", limiter, getWebhookSubscription);
router.post("/webhook-subscriptions/:subscriptionId/rotate-secret", limiter, rotateWebhookSecret);
router.post("/webhook-subscriptions/:subscriptionId/suspend", limiter, validate(webhookSchemas.updateStatus), suspendWebhookSubscription);
router.post("/webhook-subscriptions/:subscriptionId/reactivate", limiter, validate(webhookSchemas.updateStatus), reactivateWebhookSubscription);
router.post("/webhook-subscriptions/:subscriptionId/disable", limiter, validate(webhookSchemas.updateStatus), disableWebhookSubscription);
router.get("/webhook-subscriptions/:subscriptionId/deliveries", limiter, listWebhookDeliveries);
router.post("/webhook-deliveries/:deliveryId/replay", limiter, replayWebhookDelivery);

// Enterprise Multi-Currency & Foreign Exchange — docs/05-api/07-finance-api.md
// Part 19. Static routes registered BEFORE the dynamic
// "/currencies/:currencyId" routes below — same static-before-dynamic
// ordering used repeatedly this session.
router.get("/currencies/convert", limiter, convertCurrency);
// File 7 Part 3 — "POST /api/v1/currency/convert" (singular, distinct
// base path from every other /currencies route above/below).
router.post("/currency/convert", limiter, idempotency(), validate(currencySchemas.convert), convertCurrencyViaApi);
router.get("/currencies/exposure", limiter, getCurrencyExposure);
// File 7 Part 4 — "Read Models" dashboard.
router.get("/currencies/dashboard", limiter, getCurrencyDashboard);
router.post("/currencies/revalue", limiter, validate(currencySchemas.runRevaluation), runRevaluation);
router.get("/currencies/revaluations", limiter, listRevaluations);
router.get("/currencies/conversions", limiter, listConversions);

router.get("/exchange-rates", limiter, listExchangeRates);
// File 4 Part 2 — "Idempotency-Key... Duplicate submissions -> Return
// Existing Exchange Rate -> Never create duplicate records." Reuses the
// already-real, generic middleware/idempotency.js.
router.post("/exchange-rates", limiter, idempotency(), validate(currencySchemas.createExchangeRate), createExchangeRate);
router.post("/exchange-rates/import", limiter, validate(currencySchemas.importRates), importExchangeRates);
router.post("/exchange-rates/:exchangeRateId/approve", limiter, approveExchangeRate);
router.post("/exchange-rates/:exchangeRateId/reject", limiter, validate(currencySchemas.rejectExchangeRate), rejectExchangeRate);
// File 7 Part 2 — "GET /exchange-rates/{rateId}" (Rate Details, Historical
// Versions, Audit/Approval History, Usage Statistics).
router.get("/exchange-rates/:exchangeRateId", limiter, getExchangeRate);

router.get("/currencies", limiter, listCurrencies);
router.post("/currencies", limiter, idempotency(), validate(currencySchemas.createCurrency), createCurrency);
router.get("/currencies/:currencyId", limiter, getCurrency);
router.post("/currencies/:currencyId/submit", limiter, submitCurrencyForApproval);
router.post("/currencies/:currencyId/approve", limiter, approveCurrencyDefinition);
router.post("/currencies/:currencyId/activate", limiter, activateCurrency);
router.post("/currencies/:currencyId/suspend", limiter, validate(currencySchemas.suspend), suspendCurrency);
router.post("/currencies/:currencyId/archive", limiter, archiveCurrency);
router.post("/currencies/:currencyId/deprecate", limiter, deprecateCurrency);

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
router.post("/financial-analytics/refresh", limiter, validate(financialAnalyticsSchemas.refreshAnalytics), refreshAnalytics);
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

// Enterprise Budgeting & Forecasting Platform — Part 17 (EPM).
// Centralized financial planning, budgeting, forecasting, variance analysis,
// scenario modeling, and executive planning dashboards across the ERP.
// Static routes registered BEFORE dynamic routes throughout.

// Planning Dashboard
router.get("/planning-dashboards", limiter, getPlanningDashboard);

// Budget Endpoints
router.post("/budgets", limiter, validate(planningSchemas.createBudget), createBudget);
router.get("/budgets", limiter, listBudgets);
router.get("/budgets/:budgetId/versions", limiter, getBudgetRevisions);
router.get("/budgets/:budgetId", limiter, getBudget);
router.put("/budgets/:budgetId", limiter, validate(planningSchemas.updateBudget), updateBudget);
router.post("/budgets/:budgetId/submit", limiter, submitBudget);
router.post("/budgets/:budgetId/approve", limiter, validate(planningSchemas.approveBudget), approveBudget);
router.post("/budgets/:budgetId/publish", limiter, publishBudget);
router.post("/budgets/:budgetId/versions", limiter, validate(planningSchemas.createRevision), createBudgetRevision);

// Forecast Endpoints
router.post("/forecasts", limiter, validate(planningSchemas.generateForecast), generateForecast);
router.get("/forecasts", limiter, listForecasts);
router.get("/forecasts/:forecastId", limiter, getForecast);

// Variance Endpoints
router.post("/variances/calculate", limiter, validate(planningSchemas.calculateVariance), calculateVariance);
router.get("/variances", limiter, listVariances);
router.get("/variances/:varianceId", limiter, getVariance);

// Scenario Endpoints
router.post("/scenarios", limiter, validate(planningSchemas.createScenario), createScenario);
router.get("/scenarios", limiter, listScenarios);
router.post("/scenarios/:scenarioId/evaluate", limiter, evaluateScenario);
router.get("/scenarios/:scenarioId", limiter, getScenario);

// Enterprise Treasury Management Platform — Part 18 (TMS).
// Centralized cash position, liquidity forecasting, bank connectivity,
// investment management, debt administration, foreign exchange (FX), and treasury risk controls.
// Static routes registered BEFORE dynamic routes.

// Cash Position
router.post("/treasury/cash-position", limiter, validate(treasurySchemas.calculateCashPosition), calculateCashPosition);
router.get("/treasury/cash-position", limiter, getCashPosition);

// Treasury Dashboard
router.get("/treasury/dashboard", limiter, getTreasuryDashboard);

// Bank Sync
router.post("/treasury/bank-sync", limiter, validate(treasurySchemas.syncBankBalances), syncBankBalances);

// Liquidity Management & Forecast
router.post("/treasury/liquidity-forecast", limiter, validate(treasurySchemas.generateLiquidityForecast), generateLiquidityForecast);
router.get("/treasury/liquidity-forecast", limiter, listLiquidityForecasts);

// Investment Management
router.post("/treasury/investments", limiter, validate(treasurySchemas.createInvestment), createInvestment);
router.get("/treasury/investments", limiter, listInvestments);
router.get("/treasury/investments/:investmentId", limiter, getInvestmentById);
router.patch("/treasury/investments/:investmentId/status", limiter, validate(treasurySchemas.updateInvestmentStatus), updateInvestmentStatus);

// Debt Management
router.post("/treasury/debts", limiter, validate(treasurySchemas.recordDebt), recordDebt);
router.get("/treasury/debts", limiter, listDebts);
router.get("/treasury/debts/:debtId", limiter, getDebtById);
router.patch("/treasury/debts/:debtId", limiter, validate(treasurySchemas.updateDebtStatus), updateDebtStatus);

// Foreign Exchange (FX) Management
router.post("/treasury/fx-exposure", limiter, validate(treasurySchemas.calculateFXExposure), calculateFXExposure);
router.get("/treasury/fx-exposure", limiter, getFXExposures);

// Treasury Risk Controls
router.post("/treasury/risk-assessment", limiter, validate(treasurySchemas.evaluateTreasuryRisks), evaluateTreasuryRisks);
router.get("/treasury/risk-assessment", limiter, getTreasuryRisks);

// Enterprise Financial Governance & Compliance Platform — Part 19.
// Governance policy evaluation, Segregation of Duties (SoD), internal controls,
// fraud detection rules, evidence packages, and executive compliance dashboards.
// Static routes registered BEFORE dynamic routes.

// Evaluation
router.post("/finance-governance/evaluate", limiter, validate(governanceSchemas.evaluateGovernance), evaluateGovernance);

// Policies
router.get("/finance-governance/policies", limiter, listGovernancePolicies);
router.post("/finance-governance/policies", limiter, validate(governanceSchemas.createPolicy), createGovernancePolicy);

// Segregation of Duties (SoD)
router.get("/finance-governance/sod-rules", limiter, listSoDRules);
router.post("/finance-governance/sod-rules", limiter, validate(governanceSchemas.createSoDRule), createSoDRule);

// Evidence Repository
router.get("/finance-governance/evidence", limiter, listEvidencePackages);
router.get("/finance-governance/evidence/:evidenceId", limiter, getEvidenceById);

// Fraud Detection Checks
router.get("/finance-governance/fraud-checks", limiter, listFraudRules);
router.post("/finance-governance/fraud-checks", limiter, validate(governanceSchemas.createFraudRule), createFraudRule);

// Governance Dashboard
router.get("/finance-governance/dashboard", limiter, getGovernanceDashboard);

// Master Enterprise Finance Platform Orchestration — Part 20.
router.post("/finance-platform/process-request", limiter, validate(financePlatformSchemas.processFinancialRequest), processFinancialRequest);
router.get("/finance-platform/architecture", limiter, getPlatformArchitecture);
router.get("/finance-platform/health", limiter, getPlatformHealthStatus);

export default router;

