import PackageModel from "../models/PackageModel.js";
import CustomerModel from "../models/CustomerModel.js";
import HotelCatalogModel from "../models/HotelCatalogModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import WhatsAppPlatformService from "./WhatsAppPlatformService.js";
import { resolveTenantBranding } from "../utils/tenantBranding.js";

const formatDateShort = (date) => new Date(date).toISOString().slice(0, 10);
const formatMoney = (value) => (Number(value) || 0).toLocaleString();

/**
 * PRD §66 "WhatsApp Package Message" — pure text-template builder, no DB
 * access, unit-testable directly (tests/packageWhatsAppMessageService.test.js).
 */
export const buildWhatsAppMessage = ({ packageName, destination, dateRange, hotelNames, rooms, sellingCurrency, includedComponents = [], contactPhone = null }) => {
  const lines = [`*${packageName || "Travel Package"}*`, ""];
  if (destination) lines.push(`📍 ${destination}`);
  if (dateRange) lines.push(`📅 ${dateRange}`);
  if (hotelNames) lines.push(`🏨 ${hotelNames}`);
  if (includedComponents.includes("Flight")) lines.push("✈️ Flights included");
  if (includedComponents.includes("Transport")) lines.push("🚐 Transport included");

  lines.push("", "*Prices*", "");
  for (const room of rooms || []) lines.push(`${room.roomTypeName}: ${formatMoney(room.finalPricePerPerson)} ${sellingCurrency} / person`);

  if (includedComponents.length > 0) {
    lines.push("", "*Includes:*", "");
    for (const component of includedComponents) lines.push(`✓ ${component}`);
  }

  lines.push("", `📲 WhatsApp ${contactPhone || "us"} now to book.`);
  return lines.join("\n");
};

/**
 * Package Pricing Engine — PRD §66/§100. Sends via the dedicated Enterprise
 * WhatsApp Platform (WhatsAppPlatformService.sendWhatsApp) rather than
 * owning its own WhatsApp dispatch logic — Package is a CONSUMER of the
 * platform, matching every other module's relationship to the Communication
 * Platform (Part 1 principle).
 *
 * IMPORTANT: the message is generated fresh from the package's own current
 * calculated price matrix every time (not a fixed template shape), so it is
 * sent as free-form content — which means WhatsAppPlatformService will
 * refuse it (a real, enforced error, not a soft warning) unless the
 * recipient has an OPEN 24-hour WhatsApp conversation window (i.e. they
 * messaged the business within the last 24h). This is the correct behavior
 * per Meta's WhatsApp Business policy: a business-initiated free-form
 * message outside that window is a policy violation that risks account
 * suspension. There is no inbound-WhatsApp-webhook receiver in this
 * codebase yet to ever open a window, so today this will fail for most
 * recipients — closing that gap needs either (a) a real inbound webhook, or
 * (b) converting this message to a Meta-approved template. Both are
 * deliberately out of scope here; this call site is honestly left failing
 * rather than silently bypassing the policy check.
 */
class PackageWhatsAppMessageService {
  static async sendPackageMessage(packageId, data, tenantId, userId) {
    const { phone = null, roomTypeIds = null } = data;

    const pkg = await PackageModel.findOne({ _id: packageId, tenantId }).lean();
    if (!pkg) throw new Error("Package not found.");
    if (!pkg.roomWisePriceMatrix || pkg.roomWisePriceMatrix.length === 0) throw new Error("Package has no calculated price matrix — calculate the package first.");

    const rooms = Array.isArray(roomTypeIds) && roomTypeIds.length > 0
      ? pkg.roomWisePriceMatrix.filter((r) => roomTypeIds.some((id) => id.toString() === r.roomTypeId.toString()))
      : pkg.roomWisePriceMatrix;
    if (rooms.length === 0) throw new Error("None of the requested roomTypeIds are part of this package's calculated price matrix.");

    let resolvedPhone = phone;
    if (!resolvedPhone && pkg.customerId) {
      const customer = await CustomerModel.findOne({ _id: pkg.customerId, tenantId }).lean();
      resolvedPhone = customer?.phone || null;
    }
    if (!resolvedPhone) throw new Error("No phone number available — supply one, or set a customer with a phone on file on the package.");

    const [company, hotels] = await Promise.all([
      resolveTenantBranding(tenantId),
      HotelCatalogModel.find({ _id: { $in: [...new Set(pkg.segments.map((s) => s.hotelCatalogId?.toString()).filter(Boolean))] } }).lean()
    ]);

    const includedComponents = [];
    const has = (key) => rooms.some((r) => r[key] > 0);
    if (has("hotelCostPerPerson")) includedComponents.push("Hotel");
    if (has("transportCostPerPerson")) includedComponents.push("Transport");
    if (has("flightCostPerPerson")) includedComponents.push("Flight");
    if (has("visaCostPerPerson")) includedComponents.push("Visa");
    if (has("servicesCostPerPerson")) includedComponents.push("Services");

    const message = buildWhatsAppMessage({
      packageName: pkg.name,
      destination: [...new Set(pkg.segments.map((s) => s.city))].join(", "),
      dateRange: `${formatDateShort(pkg.travelStartDate)} - ${formatDateShort(pkg.travelEndDate)}`,
      hotelNames: hotels.map((h) => h.name).join(", "),
      rooms, sellingCurrency: pkg.sellingCurrency, includedComponents, contactPhone: company?.phone || null
    });

    const result = await WhatsAppPlatformService.sendWhatsApp({
      tenantId, sourceModule: "PackagePricing", phone: resolvedPhone, content: message, priority: "Normal", userId: userId || null
    });

    await AuditLogModel.create({ action: "package.pricing.send_whatsapp_message", module: "PackagePricing", resource: "Package", resourceId: pkg._id.toString(), userId: userId || null, tenantId, details: { phone: resolvedPhone } });
    return result;
  }
}

export default PackageWhatsAppMessageService;
