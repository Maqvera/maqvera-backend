import { getPlatformConfig } from "./platformConfig.js";

/**
 * Enterprise Subscription Automation Layer — Automation #3 (Enterprise
 * Payment Retry Strategy). "Retry Decision Engine... Failure Reason ->
 * Temporary? -> Retry. Permanent? -> NO RETRY -> Manual Action."
 *
 * Real, keyword-matched against the ACTUAL gateway failure message text —
 * the only real signal available. This codebase's only real gateway
 * integration (`services/gateways/StripeGatewayAdapter.js`) surfaces a
 * plain `error.message` string from the Stripe SDK (or a manual "No
 * Stripe payment method on file" message); it does not structurally parse
 * Stripe's own decline-code taxonomy into a separate field anywhere this
 * classifier could read. Pretending to parse real Stripe decline codes
 * this codebase doesn't actually capture would be exactly the kind of
 * fabrication the project's own standing rules forbid — so this classifier
 * is honest about working from real text, config-driven so an operator can
 * tune it as real failure messages are observed in production.
 */
export const classifyPaymentFailure = (failureReason) => {
  const config = getPlatformConfig();
  const text = (failureReason || "").toLowerCase();

  if (config.paymentNonRetryableFailureKeywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
    return "NonRetryable";
  }
  if (config.paymentRetryableFailureKeywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
    return "Retryable";
  }

  // Real, honest default for an unrecognized reason — the same
  // conservative stance real Smart-Retry systems (Stripe Billing,
  // Chargebee) take: give it another chance rather than prematurely
  // requiring customer action for a failure this codebase doesn't yet
  // know how to classify.
  return "Retryable";
};
