import PaymentIntentModel from "../models/PaymentIntentModel.js";
import CustomerModel from "../models/CustomerModel.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { resolveGateway } from "./PaymentService.js";
import { getGatewayAdapter } from "./gateways/index.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import { publishEvent } from "../utils/eventBus.js";

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly.
// ---------------------------------------------------------------------------

/** A Payment Intent still in one of these states can be collected against — Captured/Refunded/Disputed/Chargeback/Cancelled/Expired cannot start a fresh authorize+capture. */
export const isIntentConsumable = (status) => ["Created", "Pending", "Waiting Customer", "Authorized"].includes(status);

/**
 * "Intent Not Expired." Deliberately scoped to BEFORE any real money has
 * moved under this intent (`collectedAmount === 0`) — once at least one
 * successful partial capture has landed, the Collection itself (not the
 * ephemeral Intent that merely kicked it off) is the authoritative record
 * of what's still outstanding; expiry no longer retroactively blocks
 * collecting the remaining real balance.
 */
export const isIntentExpired = (intent, collectedAmount, now = new Date()) => {
  if (collectedAmount > 0) return false;
  return !!(intent.expiresAt && new Date(intent.expiresAt) < now);
};

/**
 * Enterprise Customer Payments — Finance Module Part 18 Part 2 (API
 * Contracts Refactoring). "Collection Request -> Payment Intent -> Payment
 * Provider Selection -> Risk Validation -> ... -> Payment Execution."
 * This service owns only the Payment Intent step — the pre-money-movement
 * record `POST /customer-payments` creates. It never moves money itself
 * (that stays Part 7's PaymentModel/PaymentService, orchestrated from Part
 * 3 of this refactor); it never publishes the domain event either — the
 * caller (CustomerCollectionService, which also owns the paired
 * collection/allocation-strategy record) publishes exactly one
 * `CustomerPaymentRequested` event per request, same as before this Part.
 */
class PaymentIntentService {
  static async generateReference(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "paymentIntentNumber", year);
    return `${config.paymentIntentNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  /**
   * Validate Customer -> Validate Currency -> Validate Payment Method ->
   * Validate Payment Provider -> Create Payment Intent -> Generate Payment
   * Reference. "Validate Merchant"/"Validate Company"/"Validate Branch"/
   * "Subscription Active" from the spec are not real checks here: no
   * Merchant/Subscription module exists in this codebase to validate
   * against (merchantId/storeId/subscriptionId are recorded honestly as
   * informational only — see PaymentIntentModel's own doc comment), and
   * Company/Branch have no isolation dimension in this codebase at all
   * (see the standing master instructions §3 / docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
   */
  static async createIntent(data, tenantId, userId) {
    const config = getFinanceConfig();
    const {
      customerId, merchantId = null, storeId = null, subscriptionId = null,
      collectionSource, sourceDocumentId = null, currency, amount,
      paymentMethod = null, paymentProvider = null, paymentDate = null,
      returnUrl = null, cancelUrl = null, metadata = null, correlationId = null
    } = data;

    if (!customerId || !collectionSource || !currency || !amount) {
      throw new Error("customerId, collectionSource, currency, and amount are required.");
    }
    if (!config.collectionSources.includes(collectionSource)) throw new Error(`Invalid collectionSource "${collectionSource}".`);
    // Case-insensitive — see the matching Joi schema's own doc comment
    // (middleware/validateRequest.js customerCollectionSchemas) for why.
    if (!config.supportedCurrencies.some((c) => c.toLowerCase() === String(currency).toLowerCase())) throw new Error(`Currency "${currency}" is not supported.`);
    // Payment method is optional (see PaymentIntentModel's own doc
    // comment) — only validated against the catalog when the caller
    // actually supplied one.
    if (paymentMethod && !config.paymentMethods.includes(paymentMethod)) throw new Error(`Invalid paymentMethod "${paymentMethod}".`);

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");
    const customerName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.companyName || "Customer";

    const gateway = resolveGateway(paymentMethod, paymentProvider, config.defaultGateway);
    if (!config.gateways.includes(gateway)) throw new Error(`Invalid paymentProvider "${gateway}".`);
    const adapter = getGatewayAdapter(gateway);
    if (!adapter) throw new Error(`Payment provider "${gateway}" is not yet supported — no adapter is implemented for it (services/gateways/).`);

    const paymentReference = await PaymentIntentService.generateReference(tenantId);
    const expiresAt = new Date(Date.now() + config.paymentIntentExpiryMinutes * 60 * 1000);

    // "Payment Provider Selection -> ... -> Payment Execution." Creating a
    // gateway session here is genuinely real (Stripe: an actual
    // unconfirmed PaymentIntent via the Stripe API) for providers that
    // support one, and an honest no-op (`applicable:false`) for Manual and
    // any provider without a real session concept — never fabricated.
    let status = config.defaultPaymentIntentStatus;
    let failureReason = null;
    let gatewaySession = { sessionId: null, url: null, clientSecret: null, rawResponse: null };
    try {
      const session = await adapter.createSession({ amount, currency, reference: paymentReference, expiresAt });
      if (session.applicable) {
        gatewaySession = { sessionId: session.sessionId, url: session.url, clientSecret: session.clientSecret, rawResponse: session.rawResponse };
        if (session.status === "Failed" || session.failureReason) {
          status = "Failed";
          failureReason = session.failureReason || "Gateway session creation failed.";
        } else {
          status = "Pending";
        }
      }
    } catch (error) {
      status = "Failed";
      failureReason = error.message;
    }

    const intent = new PaymentIntentModel({
      tenantId, paymentReference, customerId, customerName, merchantId, storeId, subscriptionId,
      collectionSource, sourceDocumentId, currency, amount, paymentMethod, paymentProvider: gateway,
      status, failureReason, gatewaySession, expiresAt, paymentDate: paymentDate ? new Date(paymentDate) : null,
      returnUrl, cancelUrl, metadata, correlationId,
      timeline: [{ event: "PaymentIntentCreated", description: `Payment intent created for ${amount} ${currency} via ${gateway} (${collectionSource}).`, performedBy: userId || null }],
      createdBy: userId || null
    });
    await intent.save();

    await AuditLogModel.create({ action: "finance.paymentintent.create", module: "Finance", resource: "PaymentIntent", resourceId: intent._id.toString(), userId: userId || null, tenantId, details: { paymentReference, amount, currency, collectionSource, gateway, status } });
    // Part 18 Part 5's own Domain Events list — distinct from
    // `CustomerPaymentRequested` (published by the orchestrating
    // CustomerCollectionService), this is specifically "a Payment Intent
    // now exists."
    publishEvent("PaymentIntentCreated", { tenantId, paymentIntentId: intent._id.toString(), customerId: customerId.toString(), amount, currency, collectionSource, gateway, status, correlationId, performedBy: userId || null });

    return intent;
  }

  static async linkCollection(intentId, collectionId, tenantId) {
    await PaymentIntentModel.updateOne({ _id: intentId, tenantId }, { $set: { collectionId } });
  }

  static async getIntentById(intentId, tenantId) {
    const intent = await PaymentIntentModel.findOne({ _id: intentId, tenantId }).lean();
    if (!intent) throw new Error("Payment intent not found.");
    return intent;
  }

  // ---- Status transitions — Part 18 Part 3's own Payment Intent
  // Lifecycle. Each is a thin, honest status+timeline update driven by a
  // real outcome the caller (CustomerCollectionService) already observed
  // from PaymentService — this service never decides those outcomes
  // itself.

  static async markAuthorized(intentId, paymentId, tenantId, authenticationMetadata = null) {
    const update = { status: "Authorized", paymentId, $push: { timeline: { event: "PaymentAuthorized", description: "Payment authorized, awaiting capture.", performedAt: new Date() } } };
    if (authenticationMetadata) update.authenticationMetadata = authenticationMetadata;
    await PaymentIntentModel.updateOne({ _id: intentId, tenantId }, update);
  }

  static async markCaptured(intentId, paymentId, tenantId) {
    await PaymentIntentModel.updateOne(
      { _id: intentId, tenantId },
      { status: "Captured", paymentId, $push: { timeline: { event: "PaymentCaptured", description: "Payment captured.", performedAt: new Date() } } }
    );
  }

  static async markFailed(intentId, tenantId, failureReason) {
    await PaymentIntentModel.updateOne(
      { _id: intentId, tenantId },
      { status: "Failed", failureReason, $push: { timeline: { event: "PaymentFailed", description: failureReason || "Payment failed.", performedAt: new Date() } } }
    );
  }

  static async markExpired(intentId, tenantId) {
    await PaymentIntentModel.updateOne(
      { _id: intentId, tenantId, status: { $in: ["Created", "Pending", "Waiting Customer"] } },
      { status: "Expired", $push: { timeline: { event: "PaymentExpired", description: "Payment intent expired before capture.", performedAt: new Date() } } }
    );
  }
}

export default PaymentIntentService;
