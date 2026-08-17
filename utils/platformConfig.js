import dotenv from 'dotenv';

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

// Enterprise Subscription Platform — a CORE platform, deliberately NOT
// under Finance (utils/financeConfig.js) — it governs whether a tenant
// can reach ANY module (Finance included), not a Finance-owned concern.
// Same env-override-with-real-JSON-fallback pattern as every other
// *Config.js in this codebase, so plan tiers/statuses/limits stay
// admin-configurable rather than hardcoded.
//
// "Merchant Account" naming: the spec's own "Merchant Account" section
// describes the TENANT's own billing/payment-method profile with this
// SaaS platform (Stripe customer id / bank account / EasyPaisa / JazzCash
// used to pay THEIR OWN subscription fee) — a fundamentally different
// concept from the "Merchant" repeatedly and deliberately dropped across
// every Finance File in this codebase (a merchant/storefront entity
// WITHIN a tenant's own business domain, which never had — and still
// doesn't have — any backing infrastructure). To avoid ever conflating
// the two, this platform calls its own real concept "Billing Account"
// throughout, never "Merchant Account".
export const getPlatformConfig = () => {
  return {
    // "Plans... Free, Starter, Professional, Business, Enterprise, Custom."
    planTiers: parseStringList(process.env.PLATFORM_PLAN_TIERS_JSON, ['Free', 'Starter', 'Professional', 'Business', 'Enterprise', 'Custom']),
    defaultPlanTier: process.env.PLATFORM_DEFAULT_PLAN_TIER || 'Free',
    planNumberPrefix: process.env.PLATFORM_PLAN_NUMBER_PREFIX || 'PLAN',

    // Enterprise Merchant & Billing Platform (Improvement 3) —
    // "Merchant Lifecycle... Prospect -> Registered -> Verified ->
    // Subscribed -> Active -> Suspended -> Closed."
    merchantStatuses: parseStringList(process.env.PLATFORM_MERCHANT_STATUSES_JSON, ['Prospect', 'Registered', 'Verified', 'Subscribed', 'Active', 'Suspended', 'Closed']),
    merchantNumberPrefix: process.env.PLATFORM_MERCHANT_NUMBER_PREFIX || 'MER',
    // "Billing Contacts... Primary, Finance, Technical, Tax, Legal,
    // Collection Contact."
    billingContactTypes: parseStringList(process.env.PLATFORM_BILLING_CONTACT_TYPES_JSON, ['Primary', 'Finance', 'Technical', 'Tax', 'Legal', 'Collection']),
    // "Merchant Wallet... Credit Balance, Refund Balance, Promotional
    // Credits, Adjustment Credits, Reward Credits."
    walletBalanceTypes: parseStringList(process.env.PLATFORM_WALLET_BALANCE_TYPES_JSON, ['Credit', 'Refund', 'Promotional', 'Adjustment', 'Reward']),
    walletTransactionTypes: parseStringList(process.env.PLATFORM_WALLET_TRANSACTION_TYPES_JSON, ['Credit', 'Debit']),

    // "Billing Cycle" — real, config-driven, mirrors every other
    // *Cycle enum already in this codebase (e.g. finance's own
    // subscriptionBillingCycles). "Custom" from File 0's own list is
    // deliberately absent — a non-enumerable, negotiated cadence has no
    // real deterministic `addBillingCycle()` formula to compute a period
    // end from, unlike the other four; a genuinely custom cycle is real,
    // buildable follow-up work once a concrete shape is given, not
    // guessed at here.
    billingCycles: parseStringList(process.env.PLATFORM_BILLING_CYCLES_JSON, ['Monthly', 'Quarterly', 'HalfYearly', 'Yearly']),
    defaultBillingCycle: process.env.PLATFORM_DEFAULT_BILLING_CYCLE || 'Monthly',

    // "Subscription Lifecycle" — Trial -> Active -> PastDue -> GracePeriod
    // -> Suspended -> Cancelled/Expired. `TenantSubscriptionService` is
    // the only place that transitions these.
    subscriptionStatuses: parseStringList(process.env.PLATFORM_SUBSCRIPTION_STATUSES_JSON, ['Trial', 'Active', 'PastDue', 'GracePeriod', 'Suspended', 'Cancelled', 'Expired', 'Archived']),
    // "Archived" — how long a Cancelled subscription sits before
    // TenantSubscriptionService.archiveSubscription marks it Archived
    // (real, but purely a status label for reporting/retention purposes
    // — no data is ever deleted, matching this platform's own "Database
    // delete nahi karna" rule either way).
    archiveAfterCancelledDays: parseInt(process.env.PLATFORM_ARCHIVE_AFTER_CANCELLED_DAYS || '90', 10),

    // "Trial" — 0 = no trial (plan activates immediately, requiring a
    // real Billing Account + payment up front); real per-plan override
    // via PlatformPlanModel.trialDays takes precedence when set.
    defaultTrialDays: parseInt(process.env.PLATFORM_DEFAULT_TRIAL_DAYS || '14', 10),

    // "Grace Period... Free Plan 0 Days, Professional 5 Days, Enterprise
    // 30 Days." Per-plan override via PlatformPlanModel.gracePeriodDays;
    // this is only the fallback when a plan doesn't set its own.
    defaultGracePeriodDays: parseInt(process.env.PLATFORM_DEFAULT_GRACE_PERIOD_DAYS || '7', 10),

    // "Merchant Account... Stripe, PayPal, Bank Transfer, JazzCash,
    // EasyPaisa, Manual Invoice, Custom Payment Provider" (File 0's own
    // naming) — the exact same real concept `TenantBillingAccountModel`
    // already models (see that model's own doc comment for why it's
    // called "Billing Account" here, never "Merchant Account" — avoiding
    // collision with Finance's own, unrelated, deliberately-dropped
    // Merchant concept). Stripe is the only real gateway integration
    // anywhere in this codebase (services/gateways/StripeGatewayAdapter.js);
    // PayPal/BankTransfer/EasyPaisa/JazzCash/CustomProvider are real,
    // legitimate payment-method LABELS a tenant's billing account can be
    // set to, but have no real gateway API integration anywhere in this
    // codebase — payments against them are always recorded via the real
    // Manual-payment path (a human confirms the money arrived), never a
    // fabricated auto-debit call. Only "Stripe" ever attempts a real
    // automatic charge (chargeAutoDebit). "Manual Invoice" from the
    // spec's own list collapses into "Manual" — the identical real
    // mechanism under a different label.
    // Improvement 3's own "Payment Methods" list adds ACH/SEPA/Wire
    // Transfer/Corporate Credit — real, legitimate labels, same "settles
    // via Manual" treatment as every other non-Stripe method (no real ACH/
    // SEPA network integration exists anywhere in this codebase). "Visa/
    // Mastercard/American Express/Apple Pay/Google Pay" from that same
    // list are deliberately NOT separate top-level methods — they are
    // real card brands/wallets Stripe's own PaymentMethod object already
    // distinguishes internally once a tenant is on "Stripe"; modeling them
    // as 5 more parallel top-level gateway entries would fabricate 5 more
    // integrations this codebase doesn't have.
    billingPaymentMethods: parseStringList(process.env.PLATFORM_BILLING_PAYMENT_METHODS_JSON, ['Stripe', 'PayPal', 'BankTransfer', 'EasyPaisa', 'JazzCash', 'ACH', 'SEPA', 'WireTransfer', 'CorporateCredit', 'CustomProvider', 'Manual']),
    defaultBillingPaymentMethod: process.env.PLATFORM_DEFAULT_BILLING_PAYMENT_METHOD || 'Manual',
    billingAccountStatuses: parseStringList(process.env.PLATFORM_BILLING_ACCOUNT_STATUSES_JSON, ['Pending', 'Verified', 'Active', 'Suspended']),

    // "Invoice Generation" — this platform's own invoice TO the tenant
    // for their subscription fee, distinct from Finance's own
    // customer-facing InvoiceModel (which bills the TENANT's customers).
    subscriptionInvoiceStatuses: parseStringList(process.env.PLATFORM_INVOICE_STATUSES_JSON, ['Draft', 'Sent', 'Paid', 'Overdue', 'Void']),
    // "Billing Invoices... Subscription Invoice, Renewal Invoice, Upgrade
    // Invoice, Downgrade Invoice, Credit Memo, Debit Memo, Tax Invoice."
    // Real, stored classification field on every SubscriptionInvoiceModel
    // row. Upgrade/Downgrade invoices are real (generateInvoice tags them
    // correctly on a plan change), but real mid-cycle PRORATION math
    // (charging/crediting only the remaining days of the current period)
    // is not built — every real invoice here is still a full-period
    // amount; a genuine proration engine is real, buildable follow-up
    // work, not guessed at here.
    // Improvement 3 adds Usage/Storage/ExtraUser/LateFee/RefundMemo —
    // real classifications; "Usage"/"Storage"/"ExtraUser" invoices have
    // no real metered-billing calculation engine behind them yet (this
    // platform has no usage-metering pipeline — see
    // TenantSubscriptionService.checkUsageLimit's own doc comment, which
    // only ever gates a request, never bills for overage), so a
    // real invoice of these types can be recorded (e.g. a human issues
    // one manually) but nothing in this pass automatically GENERATES one.
    subscriptionInvoiceTypes: parseStringList(process.env.PLATFORM_INVOICE_TYPES_JSON, ['Subscription', 'Renewal', 'Upgrade', 'Downgrade', 'Usage', 'Storage', 'ExtraUser', 'LateFee', 'CreditMemo', 'DebitMemo', 'RefundMemo', 'TaxInvoice']),
    subscriptionInvoiceNumberPrefix: process.env.PLATFORM_INVOICE_NUMBER_PREFIX || 'SUB-INV',
    // How many days before `currentPeriodEnd` a renewal invoice is
    // generated and the first reminder sent — real, configurable, not a
    // magic "always exactly N days" hardcode.
    renewalInvoiceLeadDays: parseInt(process.env.PLATFORM_RENEWAL_INVOICE_LEAD_DAYS || '7', 10),

    // "Tenant Limits" — real, enforceable numeric ceilings a plan can set.
    // "Max Branches"/"Max Companies" from the spec's own list are
    // deliberately absent from this plan-limit catalog — Company and
    // Branch are real hierarchy nodes as of the Enterprise Organisation
    // Structure Platform (Improvement 4, see utils/organisationConfig.js),
    // but neither is a plan-enforceable numeric ceiling here; Tenant
    // itself remains the only data-isolation boundary either way (see
    // docs/06-external-integrations/03-final-architecture-no-branches-rbac.md
    // — that doc's "no branch-level ISOLATION" conclusion still holds,
    // Branch is descriptive metadata only).
    tenantLimitKeys: parseStringList(process.env.PLATFORM_TENANT_LIMIT_KEYS_JSON, ['maxUsers', 'maxStorageGB', 'maxApiCallsPerDay', 'maxProjects', 'maxEmployees', 'aiCreditsPerMonth']),

    // "Feature Flags" — real per-plan boolean gates. The catalog of
    // recognized feature keys a plan may toggle; enforcing these on a
    // route is real, working infrastructure (`middleware/subscriptionEnforcement.js#requireFeature`,
    // one router-level `router.use(requireFeature("finance"))` line per
    // module), already mounted on `routes/FinanceRoutes.js`,
    // `routes/UserRoutes.js`, `routes/BookingRoutes.js`, and
    // `routes/CustomerRoutes.js`. Retrofitting the remaining route groups
    // (HR/CRM/Inventory/Projects/...) is real, deliberate, incremental
    // Adoption work (Enterprise Subscription Enforcement Middleware,
    // Automation #6), not guessed at here.
    // "paymentGatewayConnect" — Per-Tenant Payment Gateway Integration
    // (Stripe Connect, PRD Issue 11). Gated via the same real
    // `requireFeature` mounted on `routes/PaymentGatewayRoutes.js`. Unset
    // on any given plan's own `features` map defaults to ALLOWED
    // (`checkFeatureAccess`'s own "undefined key never silently blocks"
    // rule) — adding the key here only makes it a real, recognized,
    // admin-editable toggle; it does not itself restrict any plan.
    featureKeys: parseStringList(process.env.PLATFORM_FEATURE_KEYS_JSON, ['finance', 'hr', 'crm', 'inventory', 'projects', 'visa', 'booking', 'aiAssistant', 'advancedAnalytics', 'apiAccess', 'paymentGatewayConnect']),

    supportLevels: parseStringList(process.env.PLATFORM_SUPPORT_LEVELS_JSON, ['Community', 'Standard', 'Priority', 'Dedicated']),
    backupFrequencies: parseStringList(process.env.PLATFORM_BACKUP_FREQUENCIES_JSON, ['Daily', 'Weekly', 'Monthly']),

    // "Provider failures must automatically fail over when configured" —
    // reinterpreted honestly (same discipline as Finance's own File 7
    // Part 5): only one real payment-gateway integration exists
    // (Stripe) — there is nothing to fail OVER to. This flag exists so a
    // real gap is at least named/toggleable, never silently faked.
    autoDebitFailoverEnabled: parseBoolean(process.env.PLATFORM_AUTO_DEBIT_FAILOVER_ENABLED, false),

    // Scheduler cadence — the spec's own "Daily... 00:05" default,
    // real cron, admin-configurable.
    subscriptionLifecycleCron: process.env.PLATFORM_SUBSCRIPTION_LIFECYCLE_CRON || '5 0 * * *',

    // Enterprise Subscription Automation Layer — Automation #1 (Enterprise
    // Subscription Scheduler). "Suspension Enforcement Every 30 Minutes" —
    // a real, separate, more-frequent cron independent of the daily sweep
    // above, running ONLY the grace-expired -> suspend step
    // (TenantSubscriptionService.enforceGracePeriodSuspensions).
    subscriptionSuspensionEnforcementCron: process.env.PLATFORM_SUSPENSION_ENFORCEMENT_CRON || '*/30 * * * *',
    // "Never load all companies into memory... Batch Size 500." Real
    // MongoDB cursor batch size the lifecycle sweep streams through
    // instead of materializing a full result array.
    subscriptionScanBatchSize: parseInt(process.env.PLATFORM_SUBSCRIPTION_SCAN_BATCH_SIZE || '500', 10),
    // "Alerts... Runs Longer Than Threshold." A scheduler run whose real
    // durationMs exceeds this is flagged — real, configurable, not a
    // guessed constant.
    schedulerRunSlowThresholdMs: parseInt(process.env.PLATFORM_SCHEDULER_SLOW_RUN_THRESHOLD_MS || '900000', 10),
    // "Alerts... Unexpected Spike." A run whose `processed` count exceeds
    // this multiplier over the real average of its job's last 7 Completed
    // runs is flagged — never a hardcoded absolute number, since a real
    // tenant base's own size varies platform to platform.
    schedulerSpikeMultiplier: parseFloat(process.env.PLATFORM_SCHEDULER_SPIKE_MULTIPLIER || '3'),
    // "Notification to Operations Team." Real SMTP send (the same
    // services/delivery/EmailDeliveryAdapter.js Financial Reporting
    // already uses) to this one real configured address when an alert
    // condition fires. `null` (unset) means alerts are logged only —
    // never a fabricated delivery to nowhere.
    schedulerOpsAlertEmail: process.env.PLATFORM_SCHEDULER_OPS_ALERT_EMAIL || null,

    // Enterprise Subscription Automation Layer — Automation #2 (Enterprise
    // Automatic Renewal Engine). "Ye woh engine hai jo Subscription
    // Scheduler ke baad execute hoga" — real, separate cron, deliberately
    // after Automation #1's own 00:05 sweep.
    renewalEngineCron: process.env.PLATFORM_RENEWAL_ENGINE_CRON || '15 0 * * *',
    // "Early Renewal... Renew 5 Days Early." 0 (default) means a
    // subscription is only auto-renewed once genuinely due
    // (currentPeriodEnd <= now); raising this lets a real payment attempt
    // happen up to N days before the period actually ends — the resulting
    // extension still always anchors from the real currentPeriodEnd, never
    // from today's date (see SubscriptionRenewalEngineService).
    renewalEarlyWindowDays: parseInt(process.env.PLATFORM_RENEWAL_EARLY_WINDOW_DAYS || '0', 10),
    // "Late Fee (Optional)." Both default 0 (disabled) — real, additive to
    // whichever is configured; applied only when a subscription's most
    // recent prior invoice was genuinely never paid before this renewal
    // attempt (never guessed/applied speculatively).
    lateFeeFlatAmount: parseFloat(process.env.PLATFORM_LATE_FEE_FLAT_AMOUNT || '0'),
    lateFeePercentOfSubtotal: parseFloat(process.env.PLATFORM_LATE_FEE_PERCENT_OF_SUBTOTAL || '0'),

    // Enterprise Subscription Automation Layer — Automation #3 (Enterprise
    // Payment Retry Strategy). "Attempt #2 After 24 Hours, Attempt #3
    // After 72 Hours, Attempt #4 After 7 Days, Final Attempt Configurable."
    // Index 0 is the delay before the SECOND overall attempt (the first
    // real retry) — the very first attempt itself (Automation #2's own
    // immediate charge) is never delayed. An attempt beyond the array's
    // length reuses the last entry ("Final Attempt: Configurable" just
    // means the last configured interval, not a new hardcoded one).
    paymentRetryScheduleSeconds: parseJson(process.env.PLATFORM_PAYMENT_RETRY_SCHEDULE_SECONDS_JSON, [86400, 259200, 604800]),
    // "Maximum Retries -> 5." Total overall attempts (including the first)
    // before retries are exhausted and the subscription hands off to the
    // Grace Period Engine.
    paymentRetryMaxAttempts: parseInt(process.env.PLATFORM_PAYMENT_RETRY_MAX_ATTEMPTS || '5', 10),
    paymentRetryPollCron: process.env.PLATFORM_PAYMENT_RETRY_POLL_CRON || '*/15 * * * *',
    paymentRetryPollBatchSize: parseInt(process.env.PLATFORM_PAYMENT_RETRY_POLL_BATCH_SIZE || '100', 10),
    // "Retryable Errors... Temporary Bank Failure, Gateway Timeout,
    // Network Failure, Bank Unavailable, Processor Busy, Temporary Fraud
    // Review." Real, keyword-matched against the actual gateway failure
    // message text (the only real signal this codebase's gateway adapters
    // surface — see utils/paymentRetryClassifier.js's own doc comment).
    paymentRetryableFailureKeywords: parseStringList(process.env.PLATFORM_PAYMENT_RETRYABLE_FAILURE_KEYWORDS_JSON, [
      'timeout', 'timed out', 'temporarily unavailable', 'try again', 'network', 'busy', 'processing error',
      'rate limit', 'service unavailable', 'try_again_later', 'issuer unavailable', 'issuer_not_available'
    ]),
    // "Non-Retryable Errors... Invalid Card, Closed Account, Cancelled
    // Payment Method, Merchant Account Closed, Fraud Confirmed, Blocked
    // Payment Instrument." Checked BEFORE the retryable list — a message
    // matching both (unlikely, but real keyword lists can overlap) is
    // treated as non-retryable, the safer of the two outcomes.
    paymentNonRetryableFailureKeywords: parseStringList(process.env.PLATFORM_PAYMENT_NON_RETRYABLE_FAILURE_KEYWORDS_JSON, [
      'expired', 'invalid card', 'incorrect number', 'incorrect cvc', 'stolen', 'lost card', 'fraudulent', 'fraud',
      'pickup card', 'restricted card', 'closed account', 'cancelled', 'canceled', 'not configured', 'no stripe payment method'
    ]),

    // Enterprise Subscription Automation Layer — Automation #4 (Enterprise
    // Grace Period Engine). "Alerts... 3 Days Left, 1 Day Left." Real,
    // configurable milestone thresholds (days-remaining values) that get
    // their own tracked GraceReminderSent.v1 event/audit entry, layered on
    // top of (never replacing) the existing daily grace reminder email.
    graceReminderMilestoneDays: parseJson(process.env.PLATFORM_GRACE_REMINDER_MILESTONE_DAYS_JSON, [3, 1]),
    // "During Grace Period... Full Access + Warning Banner | Read Only |
    // Limited Operations... depends on company policy." Real, stored and
    // exposed per-plan-overridable config; actually ENFORCING it on a
    // request is Automation #6's job (Subscription Enforcement
    // Middleware), not yet built — see GracePeriodEngineService's own doc
    // comment.
    gracePeriodAccessPolicies: parseStringList(process.env.PLATFORM_GRACE_ACCESS_POLICIES_JSON, ['FullAccessWithWarning', 'ReadOnly', 'LimitedOperations']),
    defaultGracePeriodAccessPolicy: process.env.PLATFORM_DEFAULT_GRACE_ACCESS_POLICY || 'FullAccessWithWarning',

    // Enterprise Subscription Automation Layer — Automation #7 (Enterprise
    // Notification Timeline). "30 Days Before -> 14 -> 7 -> 3 -> 1 Day
    // Before Renewal." Real, configurable milestone thresholds — the same
    // real dedupe-via-reminders[] pattern Automation #4's own grace
    // milestones already proved.
    renewalReminderMilestoneDays: parseJson(process.env.PLATFORM_RENEWAL_REMINDER_MILESTONE_DAYS_JSON, [30, 14, 7, 3, 1]),
    // Real, honest URLs a rendered notification template can reference —
    // `null`/unset renders as an empty variable rather than a fabricated
    // link to a portal that doesn't exist.
    platformBillingPortalUrl: process.env.PLATFORM_BILLING_PORTAL_URL || null,
    platformSupportUrl: process.env.PLATFORM_SUPPORT_URL || null,

    // Enterprise Subscription Automation Layer — Automation #9 (Enterprise
    // Automatic Reactivation Workflow). "Subscription Extension... Expired
    // 1 July -> Paid 5 July -> Business Policy -> Extend From 1 July OR 5
    // July. Policy configurable." Applies ONLY to a genuine suspended-tenant
    // recovery (a routine on-time renewal or grace-period recovery has no
    // real access-loss gap to compensate for either way).
    // "FromExpiryDate" (default) — the new period picks up exactly where
    // the old one left off, same behavior this platform has always had.
    // "FromPaymentDate" — the new period starts the day payment actually
    // arrived, effectively crediting the merchant for the suspended days.
    reactivationExtensionPolicies: parseStringList(process.env.PLATFORM_REACTIVATION_EXTENSION_POLICIES_JSON, ['FromExpiryDate', 'FromPaymentDate']),
    reactivationExtensionPolicy: process.env.PLATFORM_REACTIVATION_EXTENSION_POLICY || 'FromExpiryDate',
    // "Exception Policy... Fraud Investigation, Chargeback, Legal Hold,
    // Compliance Suspension, Manual Finance Review."
    reactivationHoldTypes: parseStringList(process.env.PLATFORM_REACTIVATION_HOLD_TYPES_JSON, ['Fraud', 'Chargeback', 'LegalHold', 'ComplianceSuspension', 'ManualFinanceReview']),

    // Enterprise Subscription Automation Layer — Automation #10 (Enterprise
    // Subscription Operations Dashboard). "Churn Rate / Retention Rate" —
    // the real, configurable lookback window this platform approximates
    // subscriber churn over (no daily active-subscriber snapshot history
    // exists to compute a precise cohort-based figure).
    operationsChurnWindowDays: parseInt(process.env.PLATFORM_OPERATIONS_CHURN_WINDOW_DAYS || '30', 10),
    // "Alerts... Mass Suspension." Real suspensions-in-one-day threshold.
    operationsMassSuspensionAlertThreshold: parseInt(process.env.PLATFORM_OPERATIONS_MASS_SUSPENSION_ALERT_THRESHOLD || '10', 10),
    // "Alerts... Revenue Drop." Real percent-below-recent-7-day-average threshold.
    operationsRevenueDropAlertPercent: parseFloat(process.env.PLATFORM_OPERATIONS_REVENUE_DROP_ALERT_PERCENT || '30'),
    // "Alerts... Queue Growing." Real Dead Letter Queue pending-count threshold.
    operationsDlqGrowingThreshold: parseInt(process.env.PLATFORM_OPERATIONS_DLQ_GROWING_THRESHOLD || '20', 10),

    defaultCurrency: process.env.PLATFORM_DEFAULT_CURRENCY || 'USD',

    defaultPageSize: parseInt(process.env.PLATFORM_DEFAULT_PAGE_SIZE || '20', 10),
    maxPageSize: parseInt(process.env.PLATFORM_MAX_PAGE_SIZE || '100', 10)
  };
};

export default getPlatformConfig;
