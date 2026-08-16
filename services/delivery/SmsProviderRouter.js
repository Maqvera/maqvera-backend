import SmsDeliveryAdapter from "./SmsDeliveryAdapter.js";
import VonageSmsDeliveryAdapter from "./VonageSmsDeliveryAdapter.js";
import AwsSnsSmsDeliveryAdapter from "./AwsSnsSmsDeliveryAdapter.js";
import LocalTelecomSmsDeliveryAdapter from "./LocalTelecomSmsDeliveryAdapter.js";
import { publishEvent } from "../../utils/eventBus.js";

/**
 * SMS Multi-Provider Router with Automatic Failover.
 * Chains providers in priority order: Twilio -> Vonage -> AWS SNS -> Local Telecom Gateway.
 * Emits 'ProviderSwitched' domain event whenever failover occurs.
 */
class SmsProviderRouter {
  constructor() {
    this.adapters = [
      { name: "Twilio", instance: new SmsDeliveryAdapter() },
      { name: "Vonage", instance: new VonageSmsDeliveryAdapter() },
      { name: "AWS SNS", instance: new AwsSnsSmsDeliveryAdapter() },
      { name: "Local Telecom", instance: new LocalTelecomSmsDeliveryAdapter() }
    ];
  }

  /**
   * Dispatch SMS with automatic provider failover chain
   */
  async sendSms({ tenantId, messageId, to, body, recipient, templateData, preferredProvider = null }) {
    let primaryProviderName = preferredProvider || "Twilio";
    let attempts = [];
    let lastError = null;
    let selectedAdapterIndex = this.adapters.findIndex(a => a.name.toLowerCase() === primaryProviderName.toLowerCase());
    if (selectedAdapterIndex === -1) selectedAdapterIndex = 0;

    const reorderedAdapters = [
      ...this.adapters.slice(selectedAdapterIndex),
      ...this.adapters.slice(0, selectedAdapterIndex)
    ];

    let initialProvider = reorderedAdapters[0].name;

    for (let i = 0; i < reorderedAdapters.length; i++) {
      const adapterObj = reorderedAdapters[i];
      const providerName = adapterObj.name;

      try {
        const result = await adapterObj.instance.send({ to, body, recipient, templateData });

        if (result.status === "Sent") {
          // Check if provider failover occurred
          if (i > 0) {
            publishEvent("ProviderSwitched", {
              tenantId,
              messageId,
              channel: "SMS",
              fromProvider: initialProvider,
              toProvider: providerName,
              reason: lastError || "Primary provider unavailable or unconfigured."
            });
          }

          return {
            status: "Sent",
            provider: providerName,
            providerResponse: result.providerResponse || {},
            failoverOccurred: i > 0,
            initialProvider,
            attempts
          };
        }

        // Record failed attempt for failover logging
        attempts.push({ provider: providerName, status: result.status, reason: result.failureReason });
        lastError = result.failureReason;
      } catch (err) {
        attempts.push({ provider: providerName, status: "Error", reason: err.message });
        lastError = err.message;
      }
    }

    return {
      status: "Failed",
      provider: initialProvider,
      providerResponse: null,
      failureReason: lastError || "All SMS provider adapters failed or were unconfigured.",
      attempts
    };
  }
}

export default new SmsProviderRouter();
