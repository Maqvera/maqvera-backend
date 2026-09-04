import ProviderRouter from "./ProviderRouter.js";
import EmailDeliveryAdapter from "./EmailDeliveryAdapter.js";
import WhatsAppDeliveryAdapter from "./WhatsAppDeliveryAdapter.js";
import WebhookDeliveryAdapter from "./WebhookDeliveryAdapter.js";
import FcmDeliveryAdapter from "./FcmDeliveryAdapter.js";
import { smsProviderRouter } from "./SmsProviderRouter.js";

// Print needs no delivery action (the PDF itself is the printable
// artifact — there is no printer integration to call). Customer Portal and
// Mobile App have no such surface anywhere in this codebase to deliver
// to. Requesting either is still honestly recorded as "NotConfigured" in
// deliveryHistory (see ReceiptService), never silently dropped or faked.
//
// Part 13 fix: Email/WhatsApp now go through the same generic ProviderRouter
// SMS already proved out — a single adapter each today, but adding a second
// real provider (SendGrid/SES for Email, Meta Cloud/360dialog for WhatsApp)
// later is a config change to this list, not new plumbing in every calling
// service. SMS reuses the SAME multi-provider chain SmsPlatformService.js's
// own dedicated Part 3 path already uses — this generic dispatch path
// previously only ever reached the single Twilio-only SmsDeliveryAdapter,
// with no failover, unlike the Part 3 path. Webhook has no "provider" concept
// to route between (one URL per subscription), so it stays a raw adapter.
// Push (Part 5) — FCM covers Android + web push natively and can bridge to
// APNs for iOS through the same token-based send() call; a real second
// provider (raw APNs) is a config change to this list later, not new
// plumbing (start-with-FCM-only was the explicit Part 5 fix scope).
const ADAPTERS = {
  Email: new ProviderRouter("Email", [{ name: "Nodemailer SMTP", instance: new EmailDeliveryAdapter() }]),
  WhatsApp: new ProviderRouter("WhatsApp", [{ name: "Twilio WhatsApp", instance: new WhatsAppDeliveryAdapter() }]),
  SMS: smsProviderRouter,
  Push: new ProviderRouter("Push", [{ name: "FCM", instance: new FcmDeliveryAdapter() }]),
  Webhook: new WebhookDeliveryAdapter()
};

/** Returns the adapter for `method`, or null if it has no delivery action (Print) or no real surface yet (CustomerPortal/MobileApp). */
export const getDeliveryAdapter = (method) => ADAPTERS[method] || null;

export default getDeliveryAdapter;
