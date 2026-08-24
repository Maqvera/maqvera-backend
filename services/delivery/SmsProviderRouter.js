import ProviderRouter from "./ProviderRouter.js";
import SmsDeliveryAdapter from "./SmsDeliveryAdapter.js";
import VonageSmsDeliveryAdapter from "./VonageSmsDeliveryAdapter.js";
import AwsSnsSmsDeliveryAdapter from "./AwsSnsSmsDeliveryAdapter.js";
import LocalTelecomSmsDeliveryAdapter from "./LocalTelecomSmsDeliveryAdapter.js";

/**
 * SMS Multi-Provider Router with Automatic Failover.
 * Chains providers in priority order: Twilio -> Vonage -> AWS SNS -> Local Telecom Gateway.
 * Emits 'ProviderSwitched' domain event whenever failover occurs.
 *
 * Part 13 fix: the failover algorithm this file pioneered is now the shared
 * generic engine (ProviderRouter.js) every channel uses — `smsProviderRouter`
 * below is exported so services/delivery/index.js can reuse this exact SAME
 * multi-provider chain for the generic Communication Platform "SMS" channel
 * too, instead of that path only ever reaching the single Twilio-only
 * SmsDeliveryAdapter it used before.
 */
export const smsProviderRouter = new ProviderRouter("SMS", [
  { name: "Twilio", instance: new SmsDeliveryAdapter() },
  { name: "Vonage", instance: new VonageSmsDeliveryAdapter() },
  { name: "AWS SNS", instance: new AwsSnsSmsDeliveryAdapter() },
  { name: "Local Telecom", instance: new LocalTelecomSmsDeliveryAdapter() }
]);

class SmsProviderRouter {
  /**
   * Dispatch SMS with automatic provider failover chain. Kept as the exact
   * call shape services/SmsPlatformService.js already depends on.
   */
  async sendSms({ tenantId, messageId, to, body, recipient, templateData, preferredProvider = null }) {
    return smsProviderRouter.send({ tenantId, messageId, to, body, recipient, templateData, preferredProvider: preferredProvider || "Twilio" });
  }
}

export default new SmsProviderRouter();
