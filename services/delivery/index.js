import EmailDeliveryAdapter from "./EmailDeliveryAdapter.js";
import WhatsAppDeliveryAdapter from "./WhatsAppDeliveryAdapter.js";
import SmsDeliveryAdapter from "./SmsDeliveryAdapter.js";
import WebhookDeliveryAdapter from "./WebhookDeliveryAdapter.js";

// Print needs no delivery action (the PDF itself is the printable
// artifact — there is no printer integration to call). Customer Portal and
// Mobile App have no such surface anywhere in this codebase to deliver
// to. Requesting either is still honestly recorded as "NotConfigured" in
// deliveryHistory (see ReceiptService), never silently dropped or faked.
const ADAPTERS = {
  Email: new EmailDeliveryAdapter(),
  WhatsApp: new WhatsAppDeliveryAdapter(),
  SMS: new SmsDeliveryAdapter(),
  Webhook: new WebhookDeliveryAdapter()
};

/** Returns the adapter for `method`, or null if it has no delivery action (Print) or no real surface yet (CustomerPortal/MobileApp). */
export const getDeliveryAdapter = (method) => ADAPTERS[method] || null;

export default getDeliveryAdapter;
