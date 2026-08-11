import BaseDeliveryAdapter from "./BaseDeliveryAdapter.js";

let twilioClient = null;
let twilioInitAttempted = false;

// Lazy singleton — same "only construct once, only when needed" pattern as
// services/gateways/StripeGatewayAdapter.js's Stripe client.
const getTwilioClient = async () => {
  if (twilioInitAttempted) return twilioClient;
  twilioInitAttempted = true;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;

  const twilio = (await import("twilio")).default;
  twilioClient = twilio(accountSid, authToken);
  return twilioClient;
};

/**
 * Real WhatsApp delivery via the Twilio WhatsApp Business API (the
 * `twilio` npm package, actual Messages API calls) — gated on
 * TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_WHATSAPP_FROM. Throws no
 * fake success when unconfigured; returns "NotConfigured" honestly.
 */
class WhatsAppDeliveryAdapter extends BaseDeliveryAdapter {
  constructor() {
    super("WhatsApp");
  }

  async send({ to, body }) {
    if (!to) return { status: "Failed", providerResponse: null, failureReason: "No WhatsApp-capable phone number available for this recipient." };

    const client = await getTwilioClient();
    const from = process.env.TWILIO_WHATSAPP_FROM;
    if (!client || !from) return { status: "NotConfigured", providerResponse: null, failureReason: "Twilio WhatsApp is not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_WHATSAPP_FROM)." };

    try {
      const message = await client.messages.create({
        from: `whatsapp:${from}`,
        to: `whatsapp:${to}`,
        body
      });
      return { status: "Sent", providerResponse: { sid: message.sid, status: message.status }, failureReason: null };
    } catch (error) {
      return { status: "Failed", providerResponse: null, failureReason: error.message };
    }
  }

  async checkHealth() {
    const client = await getTwilioClient();
    if (!client || !process.env.TWILIO_WHATSAPP_FROM) return { channel: "WhatsApp", status: "NOT_CONFIGURED" };
    return { channel: "WhatsApp", status: "UP" };
  }
}

export default WhatsAppDeliveryAdapter;
