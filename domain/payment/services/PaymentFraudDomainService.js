// Payment Module Internal Domain Model (Improvement 16) — Domain Service.
// "Business behaviour spanning multiple entities/inputs, not owned by any
// one of them" — a risk score isn't a property of the Payment aggregate
// alone, it's computed FROM pre-gathered signals (duplicate/velocity
// counts the caller already looked up) and doesn't belong on the aggregate
// itself. Canonical definition — moved from services/PaymentService.js
// (Improvement 16). PaymentService re-exports both functions unchanged so
// every existing import site (services/CustomerCollectionService.js,
// tests/paymentService.test.js) keeps working unchanged. Deliberately pure
// — no DB access here; services/PaymentService.js#_runFraudCheck remains
// the real DB-backed wrapper that gathers the counts and calls this.

/** Rule-based (not AI) fraud signal — "Duplicate Payment, Velocity Check, Amount Threshold." */
export const computeFraudRiskScore = ({ isDuplicate, velocityCount, velocityMax, amount, amountThreshold }) => {
  const flags = [];
  let riskScore = 0;
  if (isDuplicate) { flags.push("DuplicatePayment"); riskScore += 40; }
  if (velocityCount > velocityMax) { flags.push("VelocityExceeded"); riskScore += 30; }
  if (amount >= amountThreshold) { flags.push("AmountThresholdExceeded"); riskScore += 30; }
  return { riskScore: Math.min(riskScore, 100), flags };
};

/** "Risk Score, Fraud Status." Deterministic bands over computeFraudRiskScore's own output — never a fabricated ML classification. */
export const deriveFraudStatus = (riskScore, { reviewThreshold, flagThreshold }) => {
  if (riskScore >= flagThreshold) return "Flagged";
  if (riskScore >= reviewThreshold) return "Review";
  return "Clear";
};
