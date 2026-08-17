/**
 * Base Payment Gateway Adapter Interface
 * All payment gateway adapters (Manual, Stripe, PayPal, etc.) must
 * implement this contract. Mirrors services/gds/BaseGdsAdapter.js's own
 * pattern for the same reason: new gateways implement the same interface,
 * application code never depends on a specific provider's shape.
 */
class BaseGatewayAdapter {
  constructor(gatewayName) {
    this.gatewayName = gatewayName;
  }

  /**
   * Authorizes (reserves) funds without capturing them.
   * Returns { status: "Authorized"|"Failed", transactionId, rawResponse, failureReason }.
   */
  async authorize(paymentParams) {
    throw new Error(`authorize() not implemented in ${this.gatewayName}`);
  }

  /**
   * Captures previously authorized funds (or authorizes+captures in one
   * step for gateways/methods that don't separate the two, e.g. Manual).
   * Returns { status: "Captured"|"Failed", transactionId, rawResponse, failureReason }.
   */
  async capture(paymentParams) {
    throw new Error(`capture() not implemented in ${this.gatewayName}`);
  }

  /**
   * Voids an authorized-but-not-yet-captured payment.
   * Returns { status: "Voided"|"Failed", rawResponse, failureReason }.
   */
  async void(paymentParams) {
    throw new Error(`void() not implemented in ${this.gatewayName}`);
  }

  /**
   * Refunds a captured payment, in full or in part.
   * Returns { status: "Refunded"|"Failed", transactionId, rawResponse, failureReason }.
   */
  async refund(paymentParams) {
    throw new Error(`refund() not implemented in ${this.gatewayName}`);
  }

  /**
   * "Settlement Reconciliation... Gateway Reports." Finance Module Part
   * 23 — fetches the gateway's own real record of what it has actually
   * paid out (a payout/settlement batch), for `SettlementService` to
   * reconcile against. Returns
   * `{ payouts: [{ id, amount, currency, arrivalDate, status, transactionIds }] }`.
   * Default: not implemented (most gateways need a real, gateway-specific
   * report call — see StripeGatewayAdapter for the one real
   * implementation this pass).
   */
  async fetchSettlementReport(params) {
    throw new Error(`fetchSettlementReport() not implemented in ${this.gatewayName}`);
  }

  async checkHealth() {
    return { gateway: this.gatewayName, status: "UP" };
  }

  /**
   * Enterprise Subscription Platform's own Billing Account setup — creates
   * a real customer/payer profile with the gateway. Default: not
   * implemented (Manual has no real customer concept to create).
   * Returns `{ customerId, rawResponse }`.
   */
  async createCustomer(params) {
    throw new Error(`createCustomer() not implemented in ${this.gatewayName}`);
  }

  /**
   * "Payment Intent -> Payment Provider Selection -> ... -> Payment
   * Execution" (Finance Module Part 18 Part 2). Creates a hosted/
   * client-confirmable session BEFORE any funds move — the real
   * pre-authorization step some gateways (Stripe) expose as their own
   * "PaymentIntent" concept. Default: not applicable — a gateway that
   * settles directly (Manual: Cash/Cheque/Bank Transfer) genuinely has no
   * session to create, so this returns `{ applicable: false }` rather than
   * throwing (unlike authorize/capture/void/refund, which are hard
   * requirements once a gateway is selected, a session is optional
   * per-gateway).
   * Returns `{ applicable, sessionId, url, clientSecret, status, rawResponse }`.
   */
  async createSession(paymentParams) {
    return { applicable: false, sessionId: null, url: null, clientSecret: null, status: null, rawResponse: null };
  }
}

export default BaseGatewayAdapter;
