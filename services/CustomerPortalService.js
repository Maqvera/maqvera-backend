import CustomerPortalTokenModel from "../models/CustomerPortalTokenModel.js";
import CustomerModel from "../models/CustomerModel.js";
import CustomerCollectionModel from "../models/CustomerCollectionModel.js";
import ReceiptModel from "../models/ReceiptModel.js";
import WalletModel from "../models/WalletModel.js";
import CustomerCreditModel from "../models/CustomerCreditModel.js";
import SubscriptionModel from "../models/SubscriptionModel.js";
import ReceiptQrService from "./ReceiptQrService.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Enterprise Customer Payments — Finance Module Part 18 Part 4. "Customer
 * Self-Service Portal... View Outstanding Invoices, View Payment History,
 * Download Receipts, Manage Subscription, Renew Membership, View Wallet,
 * View Deposits." Deliberately READ-ONLY and GET-only, resolved by the
 * same unguessable-token pattern Part 18's own payment link already
 * established — see CustomerCollectionService.getCollectionByToken's own
 * doc comment for exactly why: this codebase has no real customer-facing
 * authentication surface, so an unauthenticated write endpoint here would
 * be a genuine "anyone holding the link can act as this customer" hole.
 * "Pay Online," "Manage Payment Methods," and "Raise Payment Dispute"
 * from the spec are NOT implemented here for the same reason — they stay
 * behind the authenticated staff API (`POST .../collect`, etc.), honestly
 * deferred rather than faked.
 */
class CustomerPortalService {
  /** POST /api/v1/customers/{customerId}/portal-token — staff-initiated, generates the real link a customer is then given (email/SMS) out of band. */
  static async generatePortalToken(customerId, tenantId, userId) {
    const config = getFinanceConfig();
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");

    const token = ReceiptQrService.generateVerificationToken();
    const expiresAt = new Date(Date.now() + config.customerPortalTokenExpiryHours * 60 * 60 * 1000);
    const url = `${config.receiptVerificationBaseUrl.replace(/\/$/, "")}/api/v1/customer-portal/${token}`;

    const record = await CustomerPortalTokenModel.create({ tenantId, customerId, token, expiresAt, createdBy: userId || null });

    await AuditLogModel.create({ action: "finance.customerportal.generate_token", module: "Finance", resource: "CustomerPortalToken", resourceId: record._id.toString(), userId: userId || null, tenantId, details: { customerId: customerId.toString(), expiresAt } });

    return { token, url, expiresAt };
  }

  /**
   * GET /api/v1/customer-portal/{token} — public, unauthenticated, scoped
   * entirely to this one token's own customer. Same minimal/safe-fields
   * discipline as `getCollectionByToken`/`ReceiptService.verifyByToken` —
   * no tenantId or internal cross-customer data ever leaked.
   */
  static async getPortalDataByToken(token) {
    const record = await CustomerPortalTokenModel.findOne({ token });
    if (!record) throw new Error("Portal link not found.");
    if (record.expiresAt < new Date()) throw new Error("Portal link has expired.");

    record.viewCount += 1;
    await record.save();

    const { tenantId, customerId } = record;
    const [customer, outstandingCollections, recentReceipts, wallets, credits, subscriptions] = await Promise.all([
      CustomerModel.findOne({ _id: customerId, tenantId }).select("firstName lastName companyName email").lean(),
      CustomerCollectionModel.find({ tenantId, customerId, status: { $nin: ["Collected", "Written Off", "Cancelled", "Closed"] } })
        .select("collectionNumber collectionSource totalAmount collectedAmount currency status paymentDueDate").sort({ paymentDueDate: 1 }).limit(50).lean(),
      ReceiptModel.find({ tenantId, partyType: "customer", partyId: customerId }).select("receiptNumber amount currency issueDate status pdf.url").sort({ issueDate: -1 }).limit(20).lean(),
      WalletModel.find({ tenantId, customerId, status: { $ne: "Closed" } }).select("walletNumber walletType currency balance status").lean(),
      CustomerCreditModel.find({ tenantId, customerId, status: "Active" }).select("amount remainingAmount currency source createdAt").sort({ createdAt: -1 }).lean(),
      SubscriptionModel.find({ tenantId, customerId, status: { $ne: "Terminated" } }).select("subscriptionNumber planType planName membershipTier billingCycle amount currency status currentPeriodEnd nextBillingDate").lean()
    ]);

    if (!customer) throw new Error("Customer not found.");

    return {
      customer: { name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.companyName || "Customer", email: customer.email },
      outstandingInvoices: outstandingCollections.map((c) => ({
        collectionNumber: c.collectionNumber, source: c.collectionSource, totalAmount: c.totalAmount, currency: c.currency,
        remainingBalance: roundCurrency(c.totalAmount - c.collectedAmount), status: c.status, dueDate: c.paymentDueDate
      })),
      paymentHistory: recentReceipts.map((r) => ({ receiptNumber: r.receiptNumber, amount: r.amount, currency: r.currency, issueDate: r.issueDate, status: r.status, receiptUrl: r.pdf?.url || null })),
      wallets: wallets.map((w) => ({ walletNumber: w.walletNumber, walletType: w.walletType, currency: w.currency, balance: w.balance, status: w.status })),
      deposits: credits.map((c) => ({ amount: c.amount, remainingAmount: c.remainingAmount, currency: c.currency, source: c.source, grantedAt: c.createdAt })),
      subscriptions: subscriptions.map((s) => ({
        subscriptionNumber: s.subscriptionNumber, planType: s.planType, planName: s.planName, membershipTier: s.membershipTier,
        billingCycle: s.billingCycle, amount: s.amount, currency: s.currency, status: s.status, currentPeriodEnd: s.currentPeriodEnd, nextBillingDate: s.nextBillingDate
      }))
    };
  }
}

export default CustomerPortalService;
