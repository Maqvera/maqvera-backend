import BaseDeliveryAdapter from "./BaseDeliveryAdapter.js";

let twilioClient = null;
let twilioInitAttempted = false;

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
 * Real SMS delivery via Twilio (same account/credentials as WhatsApp —
 * only the "from" number and message envelope differ) — gated on
 * TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_SMS_FROM.
 */
class SmsDeliveryAdapter extends BaseDeliveryAdapter {
  constructor() {
    super("SMS");
  }

  async send({ to, body }) {
    if (!to) return { status: "Failed", providerResponse: null, failureReason: "No phone number available for this recipient." };

    const client = await getTwilioClient();
    const from = process.env.TWILIO_SMS_FROM;
    if (!client || !from) return { status: "NotConfigured", providerResponse: null, failureReason: "Twilio SMS is not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_SMS_FROM)." };

    try {
      const message = await client.messages.create({ from, to, body });
      return { status: "Sent", providerResponse: { sid: message.sid, status: message.status }, failureReason: null };
    } catch (error) {
      return { status: "Failed", providerResponse: null, failureReason: error.message };
    }
  }

  async checkHealth() {
    const client = await getTwilioClient();
    if (!client || !process.env.TWILIO_SMS_FROM) return { channel: "SMS", status: "NOT_CONFIGURED" };
    return { channel: "SMS", status: "UP" };
  }
}

export default SmsDeliveryAdapter;
