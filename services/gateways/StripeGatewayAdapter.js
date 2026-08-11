import BaseGatewayAdapter from "./BaseGatewayAdapter.js";

const roundToTwo = (value) => Math.round((Number(value) || 0) * 100) / 100;

let stripeClient = null;
let stripeInitAttempted = false;

// Lazy singleton — mirrors utils/cacheManager.js's lazy-Redis-connect
// pattern: only ever constructed once, and only when actually needed, so a
// tenant that never uses Stripe never pays the require() cost or needs the
// package installed with a live key.
const getStripeClient = async () => {
  if (stripeInitAttempted) return stripeClient;
  stripeInitAttempted = true;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;

  const Stripe = (await import("stripe")).default;
  stripeClient = new Stripe(secretKey);
  return stripeClient;
};

/**
 * Real Stripe integration (the `stripe` npm package, actual PaymentIntent
 * API calls) — gated on STRIPE_SECRET_KEY. When unconfigured, every method
 * throws a clear, honest error rather than fabricating a fake success —
 * this module never simulates a payment gateway response.
 */
class StripeGatewayAdapter extends BaseGatewayAdapter {
  constructor() {
    super("Stripe");
  }

  async _requireClient() {
    const client = await getStripeClient();
    if (!client) throw new Error("Stripe gateway is not configured — set STRIPE_SECRET_KEY to process payments through Stripe.");
    return client;
  }

  /** Creates a PaymentIntent with manual capture — the "Authorized" step. */
  async authorize({ amount, currency, reference, paymentMethodId }) {
    const client = await this._requireClient();
    try {
      const intent = await client.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency: (currency || "usd").toLowerCase(),
        capture_method: "manual",
        description: reference || undefined,
        payment_method: paymentMethodId || undefined,
        confirm: !!paymentMethodId
      });
      const authorized = intent.status === "requires_capture" || intent.status === "requires_confirmation" || intent.status === "requires_payment_method";
      return {
        status: authorized ? "Authorized" : "Failed",
        transactionId: intent.id,
        rawResponse: intent,
        failureReason: authorized ? null : `Unexpected Stripe PaymentIntent status: ${intent.status}`
      };
    } catch (error) {
      return { status: "Failed", transactionId: null, rawResponse: error.raw || null, failureReason: error.message };
    }
  }

  /** Captures a previously authorized PaymentIntent. */
  async capture({ gatewayDetails }) {
    const client = await this._requireClient();
    if (!gatewayDetails?.transactionId) throw new Error("No Stripe PaymentIntent id to capture.");
    try {
      const intent = await client.paymentIntents.capture(gatewayDetails.transactionId);
      const captured = intent.status === "succeeded";
      return {
        status: captured ? "Captured" : "Failed",
        transactionId: intent.id,
        rawResponse: intent,
        failureReason: captured ? null : `Unexpected Stripe PaymentIntent status after capture: ${intent.status}`
      };
    } catch (error) {
      return { status: "Failed", transactionId: gatewayDetails.transactionId, rawResponse: error.raw || null, failureReason: error.message };
    }
  }

  async void({ gatewayDetails }) {
    const client = await this._requireClient();
    if (!gatewayDetails?.transactionId) throw new Error("No Stripe PaymentIntent id to cancel.");
    try {
      const intent = await client.paymentIntents.cancel(gatewayDetails.transactionId);
      return { status: intent.status === "canceled" ? "Voided" : "Failed", rawResponse: intent, failureReason: null };
    } catch (error) {
      return { status: "Failed", rawResponse: error.raw || null, failureReason: error.message };
    }
  }

  async refund({ gatewayDetails, amount }) {
    const client = await this._requireClient();
    if (!gatewayDetails?.transactionId) throw new Error("No Stripe PaymentIntent id to refund.");
    try {
      const refund = await client.refunds.create({
        payment_intent: gatewayDetails.transactionId,
        amount: amount ? Math.round(amount * 100) : undefined
      });
      const refunded = refund.status === "succeeded" || refund.status === "pending";
      return {
        status: refunded ? "Refunded" : "Failed",
        transactionId: refund.id,
        rawResponse: refund,
        failureReason: refunded ? null : `Unexpected Stripe refund status: ${refund.status}`
      };
    } catch (error) {
      return { status: "Failed", transactionId: null, rawResponse: error.raw || null, failureReason: error.message };
    }
  }

  /**
   * Real Stripe Payouts API call — "Gateway Reports" for Settlement
   * Reconciliation (Finance Module Part 23). Never fabricated: throws
   * when Stripe isn't configured, same as every other method here.
   */
  async fetchSettlementReport({ arrivalDateAfter = null, arrivalDateBefore = null, limit = 100 } = {}) {
    const client = await this._requireClient();
    const listParams = { limit };
    if (arrivalDateAfter || arrivalDateBefore) {
      listParams.arrival_date = {};
      if (arrivalDateAfter) listParams.arrival_date.gte = Math.floor(new Date(arrivalDateAfter).getTime() / 1000);
      if (arrivalDateBefore) listParams.arrival_date.lte = Math.floor(new Date(arrivalDateBefore).getTime() / 1000);
    }
    const payoutsList = await client.payouts.list(listParams);
    const payouts = [];
    for (const payout of payoutsList.data) {
      const balanceTransactions = await client.balanceTransactions.list({ payout: payout.id, limit: 100 });
      payouts.push({
        id: payout.id,
        amount: roundToTwo(payout.amount / 100),
        currency: (payout.currency || "usd").toUpperCase(),
        arrivalDate: new Date(payout.arrival_date * 1000),
        status: payout.status,
        transactionIds: balanceTransactions.data.map((tx) => tx.source).filter(Boolean)
      });
    }
    return { payouts };
  }

  async checkHealth() {
    const client = await getStripeClient();
    if (!client) return { gateway: "Stripe", status: "NOT_CONFIGURED" };
    try {
      await client.balance.retrieve();
      return { gateway: "Stripe", status: "UP" };
    } catch (error) {
      return { gateway: "Stripe", status: "DOWN", error: error.message };
    }
  }
}

export default StripeGatewayAdapter;
