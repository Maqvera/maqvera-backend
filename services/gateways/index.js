import ManualGatewayAdapter from "./ManualGatewayAdapter.js";
import StripeGatewayAdapter from "./StripeGatewayAdapter.js";

const manualAdapter = new ManualGatewayAdapter();
const stripeAdapter = new StripeGatewayAdapter();

// Only Manual and Stripe are actually implemented this pass (see
// utils/financeConfig.js's `gateways` doc comment for why). Every other
// configured gateway value (PayPal, Square, AuthorizeNet, Adyen, Razorpay,
// Custom) resolves to `null` — PaymentService surfaces a clear
// "not yet supported" error rather than silently falling back to Manual,
// which would misrepresent how the money actually moved.
const ADAPTERS = {
  Manual: manualAdapter,
  Stripe: stripeAdapter
};

/** Returns the adapter for `gatewayName`, or null if not yet implemented. */
export const getGatewayAdapter = (gatewayName) => ADAPTERS[gatewayName] || null;

export default getGatewayAdapter;
