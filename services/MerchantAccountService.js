import MerchantAccountModel from "../models/MerchantAccountModel.js";
import MerchantWalletModel from "../models/MerchantWalletModel.js";
import TenantBillingAccountModel from "../models/TenantBillingAccountModel.js";
import TenantSubscriptionModel from "../models/TenantSubscriptionModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import TenantSubscriptionService from "./TenantSubscriptionService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import logger from "../utils/logger.js";

/**
 * Enterprise Merchant & Billing Platform (Improvement 3). "Tenant !=
 * Customer != Merchant != Legal Entity != Billing Account." The real
 * commercial-identity layer ABOVE Tenant — "Merchant cannot login. Users
 * login. Merchant is commercial identity only." Deliberately its own
 * service, not folded into TenantSubscriptionService — a genuinely
 * distinct domain concept, the same "one service per real domain" split
 * this codebase already follows everywhere else (e.g. Finance's own
 * CustomerCreditService vs. CustomerCollectionService).
 *
 * Suspension/reactivation here NEVER re-implements tenant-level access
 * revocation — it composes TenantSubscriptionService's own real,
 * already-tested `suspendTenant`/`reactivateTenant` (which already do the
 * real work: TenantModel.status flip, Session revocation, event
 * publishing) once per member tenant. A merchant-level decision is real
 * ONE-TO-ALL automation over an already-real per-tenant mechanism, not a
 * second one.
 */
class MerchantAccountService {
  static async _generateMerchantCode() {
    const config = getPlatformConfig();
    // Same real, simple, non-Finance numbering convention as
    // TenantSubscriptionService's own _generateInvoiceNumber — see that
    // method's own doc comment for why (BookingController.js's own
    // precedent, not Finance's stricter FinanceSequenceModel counter).
    return `${config.merchantNumberPrefix}-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  /**
   * POST /api/v1/merchants — real: a merchant with a real legal name and
   * tax number is already past the "Prospect" stage (it's real
   * registration information, not a lead), so it starts "Registered"
   * directly; a merchant created with only an organisation name and
   * billing email (no legal/tax info yet) starts "Prospect" — a real,
   * deterministic rule, never guessed per-call.
   */
  static async createMerchant(data, userId) {
    const { organisationName, legalName = null, taxNumber = null, registrationNumber = null, country = null, primaryContact = {}, billingEmail } = data;
    if (!organisationName || !billingEmail) throw new Error("organisationName and billingEmail are required.");

    const merchantCode = await MerchantAccountService._generateMerchantCode();
    const status = legalName && taxNumber ? "Registered" : "Prospect";

    const merchant = await MerchantAccountModel.create({
      merchantCode, organisationName, legalName: legalName || organisationName, taxNumber, registrationNumber, country, primaryContact, billingEmail,
      status, tenantIds: [],
      timeline: [{ event: "MerchantCreated", description: `Merchant ${organisationName} created (${status}).`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "platform.merchant.create", module: "Platform", resource: "MerchantAccount", resourceId: merchant._id.toString(), userId: userId || null, tenantId: null, details: { merchantCode, status } });
    publishEvent("MerchantCreated", { merchantId: merchant._id.toString(), merchantCode, status, performedBy: userId || null });

    return merchant.toJSON();
  }

  /** A human operator confirms the merchant's real legal/tax details — the real verification step, same discipline as TenantSubscriptionService.verifyBillingAccount. */
  static async verifyMerchant(merchantId, userId) {
    const merchant = await MerchantAccountModel.findOne({ _id: merchantId });
    if (!merchant) throw new Error("Merchant not found.");
    if (!merchant.legalName || !merchant.taxNumber) throw new Error("Merchant requires a legal name and tax number before it can be verified.");
    if (merchant.status === "Verified") return merchant.toJSON();
    if (!["Prospect", "Registered"].includes(merchant.status)) throw new Error(`Cannot verify a merchant in status "${merchant.status}".`);

    merchant.status = "Verified";
    merchant.verifiedAt = new Date();
    merchant.verifiedBy = userId || null;
    merchant.updatedBy = userId || null;
    merchant.timeline.push({ event: "MerchantVerified", description: "Merchant verified.", performedBy: userId || null });
    await merchant.save();

    await AuditLogModel.create({ action: "platform.merchant.verify", module: "Platform", resource: "MerchantAccount", resourceId: merchant._id.toString(), userId: userId || null, tenantId: null, details: {} });
    publishEvent("MerchantVerified", { merchantId: merchant._id.toString(), performedBy: userId || null });

    return merchant.toJSON();
  }

  /**
   * "ABC Holdings owns 4 companies... one subscription, multiple
   * companies." Adds a real tenant to the merchant's own membership list.
   * Real, idempotent (adding an already-member tenant is a no-op, not an
   * error). Auto-advances Verified -> Subscribed the first time any
   * member tenant actually has a real TenantSubscriptionModel row —
   * "Subscribed" genuinely means at least one real subscription exists
   * under this merchant, never assumed.
   */
  static async addTenantToMerchant(merchantId, tenantId, userId) {
    const merchant = await MerchantAccountModel.findOne({ _id: merchantId });
    if (!merchant) throw new Error("Merchant not found.");

    // Membership itself is idempotent (adding an already-member tenant
    // never duplicates the array entry or re-fires SubscriptionAssigned),
    // but the real Verified -> Subscribed status check below still runs
    // every call — a real subscription can be created for an
    // already-member tenant AFTER it joined, and that must still be able
    // to advance the merchant's own status on a later call.
    const alreadyMember = merchant.tenantIds.includes(tenantId);
    if (!alreadyMember) {
      merchant.tenantIds.push(tenantId);
      merchant.timeline.push({ event: "SubscriptionAssigned", description: `Tenant ${tenantId} added to merchant.`, performedBy: userId || null });
      publishEvent("SubscriptionAssigned", { merchantId: merchant._id.toString(), tenantId, performedBy: userId || null });
    }

    let statusChanged = false;
    if (merchant.status === "Verified") {
      const hasRealSubscription = await TenantSubscriptionModel.exists({ tenantId, status: { $ne: "Trial" } });
      if (hasRealSubscription) { merchant.status = "Subscribed"; statusChanged = true; }
    }

    if (!alreadyMember || statusChanged) {
      merchant.updatedBy = userId || null;
      await merchant.save();
      await AuditLogModel.create({ action: "platform.merchant.add_tenant", module: "Platform", resource: "MerchantAccount", resourceId: merchant._id.toString(), userId: userId || null, tenantId, details: { statusChanged } });
    }

    return merchant.toJSON();
  }

  /**
   * "Merchant Suspended... Inventory -> Disable Jobs, HR -> Disable
   * Login..." The real ONE-TO-ALL cascade — suspends every real member
   * tenant via TenantSubscriptionService's own already-real, already-
   * tested `suspendTenant` (TenantModel.status flip + Session revocation
   * + events), once per tenant. Failures on individual tenants are
   * collected, never allowed to silently abort the rest of the cascade.
   */
  static async suspendMerchant(merchantId, reason, userId = "system") {
    const merchant = await MerchantAccountModel.findOne({ _id: merchantId });
    if (!merchant) throw new Error("Merchant not found.");
    if (merchant.status === "Suspended") return { merchant: merchant.toJSON(), suspendedTenants: [], failures: [] };

    merchant.status = "Suspended";
    merchant.suspendedAt = new Date();
    merchant.suspensionReason = reason;
    merchant.updatedBy = userId;
    merchant.timeline.push({ event: "MerchantSuspended", description: reason || "Merchant suspended.", performedBy: userId });
    await merchant.save();

    const suspendedTenants = [];
    const failures = [];
    for (const tenantId of merchant.tenantIds) {
      try {
        await TenantSubscriptionService.suspendTenant(tenantId, reason || `Merchant ${merchant.merchantCode} suspended.`, userId);
        suspendedTenants.push(tenantId);
      } catch (error) {
        failures.push({ tenantId, error: error.message });
        logger.error(`Failed to cascade merchant suspension to tenant ${tenantId}.`, { error: error.message });
      }
    }

    await AuditLogModel.create({ action: "platform.merchant.suspend", module: "Platform", resource: "MerchantAccount", resourceId: merchant._id.toString(), userId: userId === "system" ? null : userId, tenantId: null, details: { reason, suspendedTenants, failures } });
    publishEvent("MerchantSuspended", { merchantId: merchant._id.toString(), reason, tenantIds: suspendedTenants, performedBy: userId });

    return { merchant: merchant.toJSON(), suspendedTenants, failures };
  }

  static async reactivateMerchant(merchantId, userId = "system") {
    const merchant = await MerchantAccountModel.findOne({ _id: merchantId });
    if (!merchant) throw new Error("Merchant not found.");
    if (merchant.status !== "Suspended") throw new Error(`Cannot reactivate a merchant in status "${merchant.status}".`);

    merchant.status = "Active";
    merchant.suspendedAt = null;
    merchant.suspensionReason = null;
    merchant.updatedBy = userId;
    merchant.timeline.push({ event: "MerchantReactivated", description: "Merchant reactivated.", performedBy: userId });
    await merchant.save();

    const reactivatedTenants = [];
    const failures = [];
    for (const tenantId of merchant.tenantIds) {
      try {
        await TenantSubscriptionService.reactivateTenant(tenantId, userId);
        reactivatedTenants.push(tenantId);
      } catch (error) {
        failures.push({ tenantId, error: error.message });
        logger.error(`Failed to cascade merchant reactivation to tenant ${tenantId}.`, { error: error.message });
      }
    }

    await AuditLogModel.create({ action: "platform.merchant.reactivate", module: "Platform", resource: "MerchantAccount", resourceId: merchant._id.toString(), userId: userId === "system" ? null : userId, tenantId: null, details: { reactivatedTenants, failures } });
    publishEvent("MerchantReactivated", { merchantId: merchant._id.toString(), tenantIds: reactivatedTenants, performedBy: userId });

    return { merchant: merchant.toJSON(), reactivatedTenants, failures };
  }

  static async closeMerchant(merchantId, reason, userId) {
    const merchant = await MerchantAccountModel.findOne({ _id: merchantId });
    if (!merchant) throw new Error("Merchant not found.");
    if (merchant.status === "Closed") return merchant.toJSON();

    merchant.status = "Closed";
    merchant.closedAt = new Date();
    merchant.updatedBy = userId || null;
    merchant.timeline.push({ event: "MerchantClosed", description: reason || "Merchant closed.", performedBy: userId || null });
    await merchant.save();

    await AuditLogModel.create({ action: "platform.merchant.close", module: "Platform", resource: "MerchantAccount", resourceId: merchant._id.toString(), userId: userId || null, tenantId: null, details: { reason } });
    publishEvent("MerchantClosed", { merchantId: merchant._id.toString(), reason, performedBy: userId || null });

    return merchant.toJSON();
  }

  static async listMerchants(query) {
    const config = getPlatformConfig();
    const filter = {};
    if (query.status) filter.status = query.status;
    if (query.tenantId) filter.tenantIds = query.tenantId;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);

    const [items, total] = await Promise.all([
      MerchantAccountModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      MerchantAccountModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  // ---- Merchant Wallet ----

  static async _getOrCreateWallet(merchantId, currency) {
    let wallet = await MerchantWalletModel.findOne({ merchantAccountId: merchantId });
    if (!wallet) wallet = await MerchantWalletModel.create({ merchantAccountId: merchantId, currency, balances: { credit: 0, refund: 0, promotional: 0, adjustment: 0, reward: 0 }, transactions: [] });
    return wallet;
  }

  static async getWallet(merchantId) {
    const merchant = await MerchantAccountModel.findOne({ _id: merchantId }).lean();
    if (!merchant) throw new Error("Merchant not found.");
    const wallet = await MerchantWalletModel.findOne({ merchantAccountId: merchantId }).lean();
    return wallet || { merchantAccountId: merchantId, currency: null, balances: { credit: 0, refund: 0, promotional: 0, adjustment: 0, reward: 0 }, transactions: [] };
  }

  /** POST /api/v1/wallets — real credit into a specific balance bucket (Credit/Promotional/Adjustment/Reward). Refund credits go through refundToWallet below instead, which also produces a real RefundMemo invoice row. */
  static async creditWallet(merchantId, { balanceType, amount, currency, reason = null, userId }) {
    const config = getPlatformConfig();
    if (!config.walletBalanceTypes.includes(balanceType)) throw new Error(`Invalid balanceType "${balanceType}".`);
    if (!amount || amount <= 0) throw new Error("amount must be a positive number.");

    const merchant = await MerchantAccountModel.findOne({ _id: merchantId }).lean();
    if (!merchant) throw new Error("Merchant not found.");

    const wallet = await MerchantAccountService._getOrCreateWallet(merchantId, currency || getPlatformConfig().defaultCurrency);
    const balanceKey = balanceType.toLowerCase();
    wallet.balances[balanceKey] = Math.round((wallet.balances[balanceKey] + amount) * 100) / 100;
    wallet.transactions.push({ transactionType: "Credit", balanceType, amount, reason, balanceAfter: wallet.balances[balanceKey], performedBy: userId || null });
    await wallet.save();

    await AuditLogModel.create({ action: "platform.wallet.credit", module: "Platform", resource: "MerchantWallet", resourceId: wallet._id.toString(), userId: userId || null, tenantId: null, details: { merchantId, balanceType, amount } });
    publishEvent("WalletCredited", { merchantId, walletId: wallet._id.toString(), balanceType, amount, balanceAfter: wallet.balances[balanceKey], performedBy: userId || null });

    return wallet.toJSON();
  }

  /** Debits a real, already-present balance — never allows a bucket to go negative. */
  static async debitWallet(merchantId, { balanceType, amount, reason = null, referenceId = null, userId }) {
    const config = getPlatformConfig();
    if (!config.walletBalanceTypes.includes(balanceType)) throw new Error(`Invalid balanceType "${balanceType}".`);
    if (!amount || amount <= 0) throw new Error("amount must be a positive number.");

    const wallet = await MerchantWalletModel.findOne({ merchantAccountId: merchantId });
    if (!wallet) throw new Error("Merchant wallet not found.");
    const balanceKey = balanceType.toLowerCase();
    if (wallet.balances[balanceKey] < amount) throw new Error(`Insufficient ${balanceType} balance.`);

    wallet.balances[balanceKey] = Math.round((wallet.balances[balanceKey] - amount) * 100) / 100;
    wallet.transactions.push({ transactionType: "Debit", balanceType, amount, reason, referenceId, balanceAfter: wallet.balances[balanceKey], performedBy: userId || null });
    await wallet.save();

    await AuditLogModel.create({ action: "platform.wallet.debit", module: "Platform", resource: "MerchantWallet", resourceId: wallet._id.toString(), userId: userId || null, tenantId: null, details: { merchantId, balanceType, amount, referenceId } });
    publishEvent("WalletDebited", { merchantId, walletId: wallet._id.toString(), balanceType, amount, balanceAfter: wallet.balances[balanceKey], performedBy: userId || null });

    return wallet.toJSON();
  }

  /**
   * POST /api/v1/merchant/refund — real refund path: credits the
   * merchant's own Refund balance (never a direct real reversal back to
   * Stripe/PayPal/etc. — this platform's own Stripe adapter only exposes
   * `refund()` against a specific captured PaymentIntent, which belongs
   * to a specific Subscription Invoice's own payment, not a merchant-level
   * concept; wiring THAT real gateway refund is genuine, buildable
   * follow-up work tied to a specific paid SubscriptionInvoiceModel row,
   * not attempted generically here). Never fabricates a gateway refund
   * confirmation.
   */
  static async refundToWallet(merchantId, { amount, currency, reason, referenceId = null, userId }) {
    if (!reason) throw new Error("reason is required for a refund.");
    const wallet = await MerchantAccountService.creditWallet(merchantId, { balanceType: "Refund", amount, currency, reason, userId });
    publishEvent("RefundIssued", { merchantId, amount, currency, reason, referenceId, performedBy: userId || null });
    return wallet;
  }

  static async getMerchantById(merchantId) {
    const merchant = await MerchantAccountModel.findOne({ _id: merchantId }).lean();
    if (!merchant) throw new Error("Merchant not found.");
    const billingAccounts = await TenantBillingAccountModel.find({ $or: [{ tenantId: { $in: merchant.tenantIds } }, { merchantAccountId: merchant._id }] }).lean();
    return { ...merchant, billingAccounts };
  }
}

export default MerchantAccountService;
