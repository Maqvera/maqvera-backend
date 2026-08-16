import BaseDeliveryAdapter from "./BaseDeliveryAdapter.js";

/**
 * Real webhook delivery — a genuine HTTP POST (Node's built-in global
 * fetch) to a caller-supplied URL. No SDK/credentials needed, so it's
 * "configured" whenever the caller actually provides `webhookUrl` on the
 * request; this codebase has no tenant-level default webhook URL to fall
 * back to, so omitting it is treated as this channel simply not being set
 * up for that request.
 */
class WebhookDeliveryAdapter extends BaseDeliveryAdapter {
  constructor() {
    super("Webhook");
  }

  async send({ webhookUrl, receiptNumber, verificationUrl, body }) {
    if (!webhookUrl) {
      return { status: "NotConfigured", providerResponse: null, failureReason: "No webhookUrl was provided on the receipt request." };
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "ReceiptGenerated", receiptNumber, verificationUrl, message: body })
      });
      if (!response.ok) {
        return { status: "Failed", providerResponse: { statusCode: response.status }, failureReason: `Webhook endpoint responded with HTTP ${response.status}.` };
      }
      return { status: "Sent", providerResponse: { statusCode: response.status }, failureReason: null };
    } catch (error) {
      return { status: "Failed", providerResponse: null, failureReason: error.message };
    }
  }
}

export default WebhookDeliveryAdapter;
