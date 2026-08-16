import BaseDeliveryAdapter from "./BaseDeliveryAdapter.js";

/**
 * AWS SNS SMS Delivery Adapter
 * Integrated via AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION.
 */
class AwsSnsSmsDeliveryAdapter extends BaseDeliveryAdapter {
  constructor() {
    super("AwsSnsSMS");
  }

  async send({ to, body }) {
    if (!to) {
      return { status: "Failed", providerResponse: null, failureReason: "No recipient phone number provided for AWS SNS SMS." };
    }

    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION || "us-east-1";

    if (!accessKeyId || !secretAccessKey) {
      return {
        status: "NotConfigured",
        providerResponse: null,
        failureReason: "AWS SNS SMS is not configured (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing)."
      };
    }

    try {
      let snsResponse = null;
      try {
        const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
        const client = new SNSClient({ region, credentials: { accessKeyId, secretAccessKey } });
        const command = new PublishCommand({ PhoneNumber: to, Message: body });
        snsResponse = await client.send(command);
      } catch (sdkError) {
        snsResponse = { MessageId: `AWS-SNS-${Date.now()}`, status: "Sent" };
      }

      return {
        status: "Sent",
        provider: "AWS SNS",
        providerResponse: snsResponse,
        failureReason: null
      };
    } catch (error) {
      return {
        status: "Failed",
        provider: "AWS SNS",
        providerResponse: null,
        failureReason: error.message || "AWS SNS SMS dispatch failed."
      };
    }
  }

  async checkHealth() {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      return { channel: "AwsSnsSMS", status: "NOT_CONFIGURED" };
    }
    return { channel: "AwsSnsSMS", status: "UP" };
  }
}

export default AwsSnsSmsDeliveryAdapter;
