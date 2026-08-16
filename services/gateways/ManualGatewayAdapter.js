import BaseGatewayAdapter from "./BaseGatewayAdapter.js";

/**
 * Manual gateway — Cash, Cheque, Bank Transfer: money that moved outside
 * any API (handed over, deposited, wired) and is simply being recorded.
 * This is genuinely real, not a stub: there is no external call to make
 * for these methods, so "authorize" and "capture" both just confirm the
 * recording immediately. Void/refund are bookkeeping-only too — there's no
 * external transaction to reverse.
 */
class ManualGatewayAdapter extends BaseGatewayAdapter {
  constructor() {
    super("Manual");
  }

  async authorize(paymentParams) {
    return { status: "Authorized", transactionId: null, rawResponse: null, failureReason: null };
  }

  async capture(paymentParams) {
    return { status: "Captured", transactionId: null, rawResponse: null, failureReason: null };
  }

  async void(paymentParams) {
    return { status: "Voided", rawResponse: null, failureReason: null };
  }

  async refund(paymentParams) {
    return { status: "Refunded", transactionId: null, rawResponse: null, failureReason: null };
  }

  /** No external payout report exists for cash/cheque/manual bank transfer — there is nothing outside this ERP's own records to fetch. */
  async fetchSettlementReport() {
    return { payouts: [] };
  }
}

export default ManualGatewayAdapter;
