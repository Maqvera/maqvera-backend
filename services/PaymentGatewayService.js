import TenantModel from "../models/Tenantmodel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { createStripeConnectStateToken, verifyStripeConnectStateToken } from "../utils/authTokens.js";
import logger from "../utils/logger.js";

// Lazy singleton — same real pattern `services/gateways/StripeGatewayAdapter.js`
// already established (mirrors `utils/cacheManager.js`'s own lazy-Redis-connect
// idiom): only ever constructed once, only when actually needed, so a
// tenant that never touches payment-gateway connection never pays the
// require() cost. Deliberately a small, local copy rather than reaching
// into `StripeGatewayAdapter`'s own private client — that module is a
// `BaseGatewayAdapter` implementation (payment operations), not a shared
// Stripe-client provider; both use the exact same `STRIPE_SECRET_KEY`.
let stripeClient = null;
let stripeInitAttempted = false;

export const getStripeClient = async () => {
  if (stripeInitAttempted) return stripeClient;
  stripeInitAttempted = true;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;

  const Stripe = (await import("stripe")).default;
  stripeClient = new Stripe(secretKey);
  return stripeClient;
};

const requireStripeClient = async () => {
  const client = await getStripeClient();
  if (!client) throw new Error("Stripe is not configured — set STRIPE_SECRET_KEY to use payment gateway integration.");
  return client;
};

const requireConnectClientId = () => {
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!clientId) throw new Error("Stripe Connect is not configured — set STRIPE_CONNECT_CLIENT_ID.");
  return clientId;
};

const maskAccountId = (accountId) => {
  if (!accountId || accountId.length <= 8) return accountId;
  return `${accountId.slice(0, 4)}***${accountId.slice(-4)}`;
};

/**
 * Per-Tenant Payment Gateway Integration — real Stripe Connect OAuth so
 * each agency's own Stripe account (not a Maqvera-owned one) becomes the
 * destination for that agency's own customers' payments. Distinct from
 * `services/gateways/StripeGatewayAdapter.js` (plain, single-account
 * Stripe — Finance's own customer-payment collection, and the Enterprise
 * Subscription Platform's own agency-pays-Maqvera billing) — this service
 * is the Connect (multi-account) side, never confused with that one.
 */
class PaymentGatewayService {
  /** Real Stripe Connect OAuth URL — `state` is a short-lived signed JWT embedding tenantId (utils/authTokens.js), so the callback can't be spoofed into linking the wrong tenant's account. */
  static async getStripeOAuthUrl(tenantId) {
    await requireStripeClient(); // fail honestly now if Stripe itself isn't configured at all, not deep inside the OAuth round-trip
    const clientId = requireConnectClientId();
    const state = createStripeConnectStateToken(tenantId);
    const params = new URLSearchParams({ response_type: "code", client_id: clientId, scope: "read_write", state });
    return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
  }

  /** Real Stripe OAuth token exchange — the connected account id (`stripe_user_id`) is upserted onto `TenantModel.paymentGateways`, never stored anywhere else. */
  static async handleOAuthCallback(code, state) {
    const { tenantId } = verifyStripeConnectStateToken(state);
    const client = await requireStripeClient();

    const tokenResponse = await client.oauth.token({ grant_type: "authorization_code", code });
    const accountId = tokenResponse.stripe_user_id;
    if (!accountId) throw new Error("Stripe did not return a connected account id.");

    const tenant = await TenantModel.findOne({ tenantKey: tenantId });
    if (!tenant) throw new Error("Tenant not found.");

    // App-layer rule (not a schema index, so disconnected history rows can
    // coexist): at most one CONNECTED gateway per provider.
    const connectedOther = tenant.paymentGateways.find((g) => g.provider === "stripe" && g.status === "connected" && g.accountId !== accountId);
    if (connectedOther) throw new Error("This tenant already has a different connected Stripe account. Disconnect it first.");

    const existingEntry = tenant.paymentGateways.find((g) => g.provider === "stripe" && g.accountId === accountId);
    const now = new Date();
    if (existingEntry) {
      existingEntry.status = "connected";
      existingEntry.connectedAt = now;
      existingEntry.disconnectedAt = null;
    } else {
      tenant.paymentGateways.push({ provider: "stripe", accountId, status: "connected", connectedAt: now });
    }
    await tenant.save();

    await AuditLogModel.create({ action: "payment_gateway.connected", module: "Payments", resource: "Tenant", resourceId: tenantId, userId: null, tenantId, details: { provider: "stripe", accountId } });
    publishEvent("PaymentGatewayConnected", { tenantId, provider: "stripe", accountId });
    logger.info(`Tenant ${tenantId} connected a Stripe account.`, { tenantId, accountId });

    return { tenantId, provider: "stripe", accountId, status: "connected" };
  }

  /** Real Stripe OAuth deauthorize. A Stripe-side failure (already revoked from Stripe's own dashboard, network hiccup) never traps the tenant in "connected" forever — logged, but the local disconnect still proceeds. */
  static async disconnectGateway(tenantId, provider, userId = "system") {
    const tenant = await TenantModel.findOne({ tenantKey: tenantId });
    if (!tenant) throw new Error("Tenant not found.");

    const entry = tenant.paymentGateways.find((g) => g.provider === provider && g.status === "connected");
    if (!entry) throw new Error(`No connected ${provider} gateway found for this tenant.`);

    if (provider === "stripe") {
      try {
        const client = await requireStripeClient();
        const clientId = requireConnectClientId();
        await client.oauth.deauthorize({ client_id: clientId, stripe_user_id: entry.accountId });
      } catch (error) {
        logger.error(`Stripe deauthorize call failed for tenant ${tenantId}.`, { error: error.message });
      }
    }

    entry.status = "disconnected";
    entry.disconnectedAt = new Date();
    await tenant.save();

    await AuditLogModel.create({ action: "payment_gateway.disconnected", module: "Payments", resource: "Tenant", resourceId: tenantId, userId: userId === "system" ? null : userId, tenantId, details: { provider, accountId: entry.accountId } });
    publishEvent("PaymentGatewayDisconnected", { tenantId, provider, accountId: entry.accountId, performedBy: userId });
    logger.info(`Tenant ${tenantId} disconnected a ${provider} account.`, { tenantId });

    return { tenantId, provider, status: "disconnected" };
  }

  /** Real gateway list — `accountId` masked (e.g. `acct_***c123`), never the raw id, matching "never return the raw ID to the frontend beyond what's needed to display Connected: Stripe ✓." */
  static async listGateways(tenantId) {
    const tenant = await TenantModel.findOne({ tenantKey: tenantId }).select("paymentGateways").lean();
    if (!tenant) throw new Error("Tenant not found.");
    return (tenant.paymentGateways || []).map((g) => ({
      provider: g.provider,
      accountId: maskAccountId(g.accountId),
      status: g.status,
      chargesEnabled: g.chargesEnabled,
      payoutsEnabled: g.payoutsEnabled,
      connectedAt: g.connectedAt,
      disconnectedAt: g.disconnectedAt
    }));
  }

  /** `account.updated` webhook handler support — syncs real Stripe Connect capability flags back onto the matching gateway entry. Resolves the owning tenant by `accountId`, the same real lookup the webhook controller itself uses for event routing. */
  static async syncAccountCapabilities(accountId, { chargesEnabled, payoutsEnabled }) {
    const tenant = await TenantModel.findOne({ "paymentGateways.accountId": accountId });
    if (!tenant) return null;
    const entry = tenant.paymentGateways.find((g) => g.accountId === accountId);
    if (!entry) return null;
    entry.chargesEnabled = !!chargesEnabled;
    entry.payoutsEnabled = !!payoutsEnabled;
    await tenant.save();
    return tenant.tenantKey;
  }

  /**
   * "Customer WhatsApp par baat karta hai... phir payment link." Real
   * Stripe Checkout Session, using **destination charges**
   * (`transfer_data.destination` + `on_behalf_of`) rather than the older
   * `Stripe-Account` header approach — the standard Stripe Connect
   * marketplace/SaaS pattern: this platform stays the "platform of
   * record" for Stripe's own fee/reporting purposes while the actual
   * funds route directly to the agency's own connected account, never
   * touching a Maqvera-owned balance. `payment_intent_data.metadata`
   * (NOT the Checkout Session's own top-level `metadata`, which does not
   * propagate onto the resulting PaymentIntent/Charge) is what
   * Issue 5/6's webhook handler later reads to correlate the event back
   * to this real booking — Stripe's own documented behavior copies a
   * PaymentIntent's metadata onto its resulting Charge, so `charge.refunded`
   * resolves the same `bookingId` with no extra bookkeeping needed here.
   */
  static async createCheckoutSession({ tenantId, bookingId, bookingReference, amount, currency }) {
    if (!amount || amount <= 0) throw new Error("A positive amount is required to create a checkout session.");

    const tenant = await TenantModel.findOne({ tenantKey: tenantId }).select("paymentGateways").lean();
    const gateway = (tenant?.paymentGateways || []).find((g) => g.provider === "stripe" && g.status === "connected");
    if (!gateway) throw new Error("Agency has not connected a payment account yet.");
    if (!gateway.chargesEnabled) throw new Error("Agency's connected Stripe account cannot accept charges yet — onboarding may still be incomplete.");

    const client = await requireStripeClient();
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

    const session = await client.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: (currency || "usd").toLowerCase(),
          product_data: { name: `Booking ${bookingReference || bookingId}` },
          unit_amount: Math.round(amount * 100)
        },
        quantity: 1
      }],
      payment_intent_data: {
        transfer_data: { destination: gateway.accountId },
        on_behalf_of: gateway.accountId,
        metadata: { bookingId: String(bookingId), tenantId }
      },
      success_url: `${frontendUrl}/bookings/${bookingId}/payment?status=success`,
      cancel_url: `${frontendUrl}/bookings/${bookingId}/payment?status=cancelled`
    });

    return { url: session.url, sessionId: session.id };
  }
}

export default PaymentGatewayService;
