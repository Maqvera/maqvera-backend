// Payment Module Internal Domain Model (Improvement 16) — Domain Policy.
// "Who can approve? Maximum amount?"-style encapsulated business rule —
// here, "which gateway actually processes this payment when the caller
// doesn't say." Canonical definition — moved from services/PaymentService.js
// (Improvement 16: business rules belong in the Domain Layer). PaymentService
// re-exports `resolveGateway` unchanged so every existing import site
// (services/PaymentIntentService.js, tests/paymentService.test.js) keeps
// working unchanged.

// Methods that settle without an external API call — everything else
// defaults to the tenant's configured default gateway. A wallet/store-
// credit purchase spends an already-real, already-verified internal
// balance, never an external gateway call — genuinely manual for the same
// reason Cash/Cheque/Bank Transfer are.
const MANUAL_ONLY_METHODS = new Set(["Cash", "Cheque", "Bank Transfer", "Wallet", "Store Credit"]);

export const resolveGateway = (paymentMethod, requestedGateway, defaultGateway) => {
  if (requestedGateway) return requestedGateway;
  if (MANUAL_ONLY_METHODS.has(paymentMethod)) return "Manual";
  return defaultGateway;
};

export { MANUAL_ONLY_METHODS };
