import path from "path";
import PackageModel from "../models/PackageModel.js";
import FlyerModel from "../models/FlyerModel.js";
import HotelCatalogModel from "../models/HotelCatalogModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import CurrencyService from "./CurrencyService.js";
import { renderHtmlToPdfBuffer, renderHtmlToImageBuffer, TEMPLATES_DIR } from "./HtmlPdfRenderer.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { resolveTenantBranding } from "../utils/tenantBranding.js";
import { publishEvent } from "../utils/eventBus.js";
import { getPackagePricingConfig } from "../utils/packagePricingConfig.js";

const TEMPLATE_PATHS = {
  Standard: path.join(TEMPLATES_DIR, "packages", "flyer.html")
};

// PRD §60 "Multi-Language Flyers" — a simple label dictionary is enough for
// MVP (not a full i18n framework, per the PRD's own "do not over-build"
// spirit). Numbers/prices stay locale-formatted by currency, never by
// language — see generateFlyer's own displayCurrency handling (PRD §61).
const FLYER_STRINGS = {
  en: { itinerary: "Itinerary", packagePrice: "Package Price", perPerson: "per person", includes: "Includes", bookNow: "Book Now", nights: "Nights", checkIn: "Check-in", checkOut: "Check-out" },
  ur: { itinerary: "سفری منصوبہ", packagePrice: "پیکج قیمت", perPerson: "فی شخص", includes: "شامل ہے", bookNow: "ابھی بک کریں", nights: "راتیں", checkIn: "چیک ان", checkOut: "چیک آؤٹ" },
  ar: { itinerary: "خط سير الرحلة", packagePrice: "سعر الباقة", perPerson: "للشخص الواحد", includes: "يشمل", bookNow: "احجز الآن", nights: "ليالي", checkIn: "تسجيل الدخول", checkOut: "تسجيل الخروج" }
};
const RTL_LANGUAGES = new Set(["ur", "ar"]);

// PRD §56 — flyer shows hotel images/description/amenities alongside the
// itinerary. A hotel record created before these fields existed simply has
// none of them set, so every value here is guarded with `|| null`/`|| []`
// rather than leaking `undefined` into the template. Exported as a pure
// function (no DB/Chromium) so tests/packageHotelCatalog.test.js can cover
// the "hotel has none of the new fields" case directly.
export const buildFlyerSegmentData = (segment, hotel) => ({
  city: segment.city, hotelName: hotel?.name || null,
  hotelImage: (hotel?.images && hotel.images[0]) || null,
  hotelDescription: hotel?.description || null,
  hotelAmenities: hotel?.amenities || [],
  hotelCheckInTime: hotel?.checkInTime || null,
  hotelCheckOutTime: hotel?.checkOutTime || null,
  checkIn: segment.checkIn, checkOut: segment.checkOut,
  nights: Math.max(0, Math.round((new Date(segment.checkOut) - new Date(segment.checkIn)) / 86400000))
});

/**
 * Package Pricing Engine — PRD §55-§62 "Package Flyer Generator". Renders
 * the package's own last-calculated `roomWisePriceMatrix` (never a second
 * price calculation) through the same Handlebars+headless-Chromium
 * pipeline every other document in this codebase uses
 * (services/HtmlPdfRenderer.js), as either an image (PNG/JPG, via the new
 * renderHtmlToImageBuffer) or a PDF. "Only available occupancies appear"
 * (PRD §57) falls out naturally — the matrix itself only ever contains
 * room types every segment's hotel actually has an active rate for.
 */
class PackageFlyerService {
  static async generateFlyer(packageId, data, tenantId, userId) {
    const config = getPackagePricingConfig();
    const { template = null, format = null, dimensionPreset = null, roomTypeIds = null, language = "en", displayCurrency = null } = data;
    const resolvedLanguage = FLYER_STRINGS[language] ? language : "en";

    const resolvedTemplate = template || config.defaultFlyerTemplate;
    if (!config.flyerTemplates.includes(resolvedTemplate)) throw new Error(`Invalid template "${resolvedTemplate}".`);
    const templatePath = TEMPLATE_PATHS[resolvedTemplate];
    if (!templatePath) throw new Error(`No template file registered for flyer template "${resolvedTemplate}".`);

    const resolvedFormat = format || config.defaultFlyerFormat;
    if (!config.flyerFormats.includes(resolvedFormat)) throw new Error(`Invalid format "${resolvedFormat}".`);
    const resolvedDimensionPreset = dimensionPreset || config.defaultFlyerDimensionPreset;
    const viewport = config.flyerDimensionPresets[resolvedDimensionPreset];
    if (!viewport) throw new Error(`Invalid dimensionPreset "${resolvedDimensionPreset}".`);

    const pkg = await PackageModel.findOne({ _id: packageId, tenantId }).lean();
    if (!pkg) throw new Error("Package not found.");
    if (!pkg.roomWisePriceMatrix || pkg.roomWisePriceMatrix.length === 0) throw new Error("Package has no calculated price matrix — calculate the package first.");

    const rooms = Array.isArray(roomTypeIds) && roomTypeIds.length > 0
      ? pkg.roomWisePriceMatrix.filter((r) => roomTypeIds.some((id) => id.toString() === r.roomTypeId.toString()))
      : pkg.roomWisePriceMatrix;
    if (rooms.length === 0) throw new Error("None of the requested roomTypeIds are part of this package's calculated price matrix.");

    const [company, hotels] = await Promise.all([
      resolveTenantBranding(tenantId),
      HotelCatalogModel.find({ _id: { $in: [...new Set(pkg.segments.map((s) => s.hotelCatalogId?.toString()).filter(Boolean))] } }).lean()
    ]);
    const hotelById = new Map(hotels.map((h) => [h._id.toString(), h]));

    // Union of included components across every rendered room row — a
    // flyer describes the package, not one specific occupancy's own mix.
    const includedComponents = [];
    const has = (key) => rooms.some((r) => r[key] > 0);
    if (has("hotelCostPerPerson")) includedComponents.push("Hotel");
    if (has("transportCostPerPerson")) includedComponents.push("Transport");
    if (has("flightCostPerPerson")) includedComponents.push("Flight");
    if (has("visaCostPerPerson")) includedComponents.push("Visa");
    if (has("servicesCostPerPerson")) includedComponents.push("Services");

    // PRD §61 "Multi-Currency Flyer" — render-time-only conversion; never
    // mutates the package's own stored roomWisePriceMatrix/sellingCurrency.
    const resolvedDisplayCurrency = displayCurrency ? displayCurrency.toUpperCase() : pkg.sellingCurrency;
    let displayFx = 1;
    if (resolvedDisplayCurrency !== pkg.sellingCurrency) {
      const conversion = await CurrencyService.getRate(tenantId, pkg.sellingCurrency, resolvedDisplayCurrency);
      displayFx = conversion.rate;
    }

    const templateData = {
      company: company || {},
      strings: FLYER_STRINGS[resolvedLanguage],
      dir: RTL_LANGUAGES.has(resolvedLanguage) ? "rtl" : "ltr",
      package: {
        name: pkg.name, travelStartDate: pkg.travelStartDate, travelEndDate: pkg.travelEndDate, sellingCurrency: resolvedDisplayCurrency,
        segments: pkg.segments.map((s) => buildFlyerSegmentData(s, hotelById.get(s.hotelCatalogId?.toString()) || null))
      },
      rooms: rooms.map((r) => ({ roomTypeName: r.roomTypeName, occupancy: r.occupancy, finalPricePerPerson: Math.round(r.finalPricePerPerson * displayFx * 100) / 100 })),
      includedComponents
    };

    const buffer = resolvedFormat === "PDF"
      ? await renderHtmlToPdfBuffer(templatePath, templateData)
      : await renderHtmlToImageBuffer(templatePath, templateData, { viewport, type: resolvedFormat === "JPG" ? "jpeg" : "png" });

    const extension = resolvedFormat === "JPG" ? "jpg" : resolvedFormat.toLowerCase();
    const stored = await storeDocumentPdf({ tenantId, folder: "package-flyers", filename: `${pkg._id}-${Date.now()}.${extension}`, buffer });

    const flyer = await FlyerModel.create({
      tenantId, packageId: pkg._id, template: resolvedTemplate, format: resolvedFormat, dimensionPreset: resolvedDimensionPreset,
      roomTypeIds: rooms.map((r) => r.roomTypeId), fileUrl: stored.url, language: resolvedLanguage,
      displayCurrency: resolvedDisplayCurrency !== pkg.sellingCurrency ? resolvedDisplayCurrency : null, generatedBy: userId || null
    });

    await AuditLogModel.create({ action: "package.pricing.generate_flyer", module: "PackagePricing", resource: "Flyer", resourceId: flyer._id.toString(), userId: userId || null, tenantId, details: { packageId: pkg._id.toString(), template: resolvedTemplate, format: resolvedFormat } });
    publishEvent("PackageFlyerGenerated", { tenantId, packageId: pkg._id.toString(), flyerId: flyer._id.toString(), performedBy: userId || null });

    return flyer.toJSON();
  }

  static async listFlyersForPackage(packageId, tenantId) {
    return FlyerModel.find({ tenantId, packageId }).sort({ createdAt: -1 }).lean();
  }
}

export default PackageFlyerService;
