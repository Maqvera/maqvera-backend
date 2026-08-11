/**
 * Base Receipt Delivery Adapter Interface
 * All delivery channel adapters (Email, WhatsApp, SMS, Webhook, ...) must
 * implement this contract. Mirrors services/gateways/BaseGatewayAdapter.js's
 * own pattern for the same reason: new channels implement the same
 * interface, application code never depends on a specific provider's shape.
 */
class BaseDeliveryAdapter {
  constructor(channelName) {
    this.channelName = channelName;
  }

  /**
   * Sends the receipt through this channel.
   * `params`: { to, subject, body, attachment: { filename, buffer, contentType }, receiptNumber, verificationUrl, webhookUrl }
   * Returns { status: "Sent"|"Failed"|"NotConfigured", providerResponse, failureReason }.
   */
  async send(params) {
    throw new Error(`send() not implemented in ${this.channelName}`);
  }

  async checkHealth() {
    return { channel: this.channelName, status: "UP" };
  }
}

export default BaseDeliveryAdapter;
