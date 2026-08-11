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
}

export default BaseGatewayAdapter;
