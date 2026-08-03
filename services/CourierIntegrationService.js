/** ENV-configured courier adapter. No external request is made unless a provider is configured. */
class CourierIntegrationService {
  static async createShipment({ dispatchNumber, courierCompany, trackingNumber, expectedDelivery, passportId }) {
    const baseUrl = process.env.COURIER_API_BASE_URL;
    const apiKey = process.env.COURIER_API_KEY;
    if (!baseUrl || !apiKey) return { trackingNumber, providerReference: null, integrationStatus: "not_configured" };
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/shipments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ dispatchNumber, courierCompany, trackingNumber, expectedDelivery, passportId })
    });
    if (!response.ok) throw new Error(`Courier shipment creation failed (${response.status}).`);
    const payload = await response.json();
    return { trackingNumber: payload.trackingNumber || trackingNumber, providerReference: payload.id || null, integrationStatus: "created" };
  }
}
export default CourierIntegrationService;
