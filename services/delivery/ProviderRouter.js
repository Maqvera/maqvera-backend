import { publishEvent } from "../../utils/eventBus.js";

/**
 * Enterprise Communication Platform — generic Provider Management (Part 13).
 * Extracted from services/delivery/SmsProviderRouter.js's own real failover
 * algorithm (the only channel with genuine multi-provider failover before
 * this) so every channel gets the SAME provider registry + automatic
 * failover chain instead of reinventing it — a provider outage or price
 * hike becomes a config change (reorder/add an adapter), not an emergency
 * code deploy, for Email/WhatsApp too, not just SMS.
 *
 * Implements the same `{ channelName, send(params) }` contract every
 * BaseDeliveryAdapter subclass implements, so it's a drop-in replacement
 * anywhere a single adapter was used directly (see services/delivery/index.js).
 */
class ProviderRouter {
  /** `adapters`: ordered [{ name, instance }] — instance implements BaseDeliveryAdapter's send(). */
  constructor(channelName, adapters) {
    this.channelName = channelName;
    this.adapters = adapters;
  }

  /**
   * Dispatch with automatic provider failover chain. `preferredProvider`
   * (case-insensitive name) reorders the chain to try that provider first;
   * unknown/omitted falls back to registration order. Publishes
   * 'ProviderSwitched' whenever the message that actually succeeded wasn't
   * the first one tried.
   */
  async send({ tenantId = null, messageId = null, preferredProvider = null, ...sendParams }) {
    let selectedAdapterIndex = preferredProvider
      ? this.adapters.findIndex((a) => a.name.toLowerCase() === preferredProvider.toLowerCase())
      : -1;
    if (selectedAdapterIndex === -1) selectedAdapterIndex = 0;

    const reorderedAdapters = [
      ...this.adapters.slice(selectedAdapterIndex),
      ...this.adapters.slice(0, selectedAdapterIndex)
    ];

    const initialProvider = reorderedAdapters[0]?.name || null;
    const attempts = [];
    let lastError = null;
    // The last failed attempt's full raw result — spread into the final
    // failure return below so adapter-specific extra fields (e.g.
    // FcmDeliveryAdapter's `invalidToken`) survive past this generic router,
    // not just the fixed status/provider/failureReason set every adapter
    // shares. A thrown (uncaught) error carries no such extras.
    let lastResult = null;

    for (let i = 0; i < reorderedAdapters.length; i++) {
      const adapterObj = reorderedAdapters[i];

      try {
        const result = await adapterObj.instance.send(sendParams);

        if (result.status === "Sent") {
          if (i > 0) {
            publishEvent("ProviderSwitched", {
              tenantId,
              messageId,
              channel: this.channelName,
              fromProvider: initialProvider,
              toProvider: adapterObj.name,
              reason: lastError || "Primary provider unavailable or unconfigured."
            });
          }

          return {
            status: "Sent",
            provider: adapterObj.name,
            providerResponse: result.providerResponse || {},
            failoverOccurred: i > 0,
            initialProvider,
            attempts
          };
        }

        attempts.push({ provider: adapterObj.name, status: result.status, reason: result.failureReason });
        lastError = result.failureReason;
        lastResult = result;
      } catch (err) {
        attempts.push({ provider: adapterObj.name, status: "Error", reason: err.message });
        lastError = err.message;
        lastResult = null;
      }
    }

    return {
      ...(lastResult || {}),
      status: "Failed",
      provider: initialProvider,
      providerResponse: null,
      failureReason: lastError || `All ${this.channelName} provider adapters failed or were unconfigured.`,
      attempts
    };
  }

  async checkHealth() {
    const results = await Promise.all(this.adapters.map(async (a) => ({ provider: a.name, ...(await a.instance.checkHealth()) })));
    return { channel: this.channelName, providers: results };
  }
}

export default ProviderRouter;
