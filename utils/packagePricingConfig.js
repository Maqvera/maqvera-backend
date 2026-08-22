import dotenv from "dotenv";

dotenv.config();

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
};

const parseStringList = (value, fallback) => {
  const parsed = parseJson(value, fallback);
  if (!Array.isArray(parsed)) return fallback;
  return parsed.map((item) => `${item}`.trim()).filter(Boolean);
};

// Package Pricing Engine — config-driven enums (mirrors utils/financeConfig.js's
// env-override-with-JSON-fallback pattern). Nothing destination-, currency-,
// room-type-, or vehicle-specific is hardcoded here — see Golden Rules 1-4 in
// the Global Package Pricing Engine PRD. Room types and vehicles themselves are
// tenant-owned master data (RoomTypeModel/TransportVehicleModel), never an enum.
export const getPackagePricingConfig = () => ({
  // Hotel rate resolution priority (highest to lowest) — PRD §5. The actual
  // priority order is enforced in PackagePricingService.resolveHotelRate;
  // this list is the admin-visible/valid set of rateBasis values a rate row
  // may declare.
  hotelRateBasisTypes: parseStringList(process.env.HOTEL_RATE_BASIS_TYPES_JSON, ["ExactDate", "DateRange", "Season", "Weekend", "Weekday", "Standard"]),
  hotelRateBasisPriority: parseStringList(process.env.HOTEL_RATE_BASIS_PRIORITY_JSON, ["ExactDate", "DateRange", "Season", "Weekend", "Weekday", "Standard"]),
  // Shared rate-record lifecycle — hotel/transport/flight/visa/service rates
  // all use this same status set (PRD §5, §11): a missing rate must never be
  // treated as zero, and an expired/StopSale rate must never be silently used.
  rateStatuses: parseStringList(process.env.PACKAGE_RATE_STATUSES_JSON, ["Draft", "Verified", "Active", "OnRequest", "StopSale", "SoldOut", "Expired", "Archived"]),
  defaultRateStatus: process.env.DEFAULT_PACKAGE_RATE_STATUS || "Draft",
  usableRateStatuses: parseStringList(process.env.USABLE_PACKAGE_RATE_STATUSES_JSON, ["Active"]),
  // PRD §54/§78-79 — a rate in one of these statuses is real and resolvable
  // (a genuine, currently-relevant rate the agent should be told about) but
  // must never be silently priced as if it were Active; Draft/Expired/
  // Archived stay fully non-resolvable, same as a rate that doesn't exist.
  onRequestLikeStatuses: parseStringList(process.env.PACKAGE_ON_REQUEST_LIKE_STATUSES_JSON, ["OnRequest", "StopSale", "SoldOut"]),
  // PRD §23 "Extra Bed" — per night / per stay / per person.
  extraBedBasisTypes: parseStringList(process.env.PACKAGE_EXTRA_BED_BASIS_TYPES_JSON, ["PerNight", "PerStay", "PerPerson"]),
  defaultExtraBedBasis: process.env.DEFAULT_PACKAGE_EXTRA_BED_BASIS || "PerStay",

  // PRD §26/§110-111 — rate expiry alerts.
  rateExpiryWarningDays: Number(process.env.PACKAGE_RATE_EXPIRY_WARNING_DAYS) || 7,
  rateExpiryCron: process.env.PACKAGE_RATE_EXPIRY_CRON_SCHEDULE || "0 3 * * *",
  rateSourceTypes: parseStringList(process.env.PACKAGE_RATE_SOURCE_TYPES_JSON, ["Manual", "Import"]),
  defaultRateSource: process.env.DEFAULT_PACKAGE_RATE_SOURCE || "Manual",

  transportDirectionTypes: parseStringList(process.env.TRANSPORT_DIRECTION_TYPES_JSON, ["OneWay", "Return", "RoundTrip"]),
  defaultTransportDirection: process.env.DEFAULT_TRANSPORT_DIRECTION || "OneWay",
  // "Given passenger count, the engine automatically recommends a vehicle
  // (or a combination...) using a configurable rule" — PRD §7.
  vehicleSelectionRules: parseStringList(process.env.VEHICLE_SELECTION_RULES_JSON, ["Cheapest", "MinimumVehicles", "PreferredVehicle", "Manual"]),
  defaultVehicleSelectionRule: process.env.DEFAULT_VEHICLE_SELECTION_RULE || "MinimumVehicles",

  serviceChargeBasisTypes: parseStringList(process.env.SERVICE_CHARGE_BASIS_TYPES_JSON, ["PerPerson", "PerRoom", "PerNight", "PerVehicle", "PerGroup", "PerBooking", "Percentage"]),

  markupScopeTypes: parseStringList(process.env.MARKUP_SCOPE_TYPES_JSON, ["Hotel", "Transport", "Flight", "Visa", "Services", "EntirePackage"]),
  markupTypes: parseStringList(process.env.MARKUP_TYPES_JSON, ["Fixed", "Percentage"]),

  priceListTypes: parseStringList(process.env.PACKAGE_PRICE_LIST_TYPES_JSON, ["B2C", "B2B", "Corporate", "VIP"]),
  defaultPriceListType: process.env.DEFAULT_PACKAGE_PRICE_LIST_TYPE || "B2C",

  roundingRuleTypes: parseStringList(process.env.PACKAGE_ROUNDING_RULE_TYPES_JSON, ["None", "Nearest10", "Nearest100", "Nearest500", "Nearest1000", "Custom"]),
  defaultRoundingRule: process.env.DEFAULT_PACKAGE_ROUNDING_RULE || "None",

  // PRD §6 — "configurable age bands (defaults: 0-1.99 infant, 2-11.99
  // child, 12+ adult)". Only used where a caller supplies traveler ages;
  // the adults/children/infants counts on a Package are otherwise taken
  // as given, never re-derived from ages.
  ageBands: parseJson(process.env.PACKAGE_AGE_BANDS_JSON, { infantMaxAge: 1.99, childMaxAge: 11.99 }),

  packageStatuses: parseStringList(process.env.PACKAGE_STATUSES_JSON, ["Draft", "Calculated", "Quoted", "Sent", "Negotiation", "Confirmed", "Booked", "Cancelled", "Expired"]),
  defaultPackageStatus: process.env.DEFAULT_PACKAGE_STATUS || "Draft",

  // PRD §74 "Supplier Management" — supplier category is descriptive
  // metadata on the Supplier master, not a data-isolation dimension.
  supplierCategories: parseStringList(process.env.PACKAGE_SUPPLIER_CATEGORIES_JSON, ["Hotel", "Transport", "Flight", "Visa", "Service", "General"]),

  // PRD §91 "Discount Engine".
  discountTypes: parseStringList(process.env.PACKAGE_DISCOUNT_TYPES_JSON, ["Fixed", "Percentage"]),
  discountScopeTypes: parseStringList(process.env.PACKAGE_DISCOUNT_SCOPE_TYPES_JSON, ["PerPerson", "PerRoom", "TotalPackage"]),

  // PRD §41 "Commission Engine" — reuses markupTypes (Fixed/Percentage) for
  // its own `type`; only the scope set is distinct from MarkupRuleModel's.
  commissionScopeTypes: parseStringList(process.env.PACKAGE_COMMISSION_SCOPE_TYPES_JSON, ["Agent", "Destination", "Hotel", "Global"]),

  // PRD §53 "Price Validity" — "Price valid until: [Date/Time]". How long a
  // freshly-calculated room-wise matrix stays valid before it should be
  // recalculated; purely advisory (calculatePackage never blocks on an
  // expired priceValidUntil — a stale quote is a UI/process concern, not a
  // hard validation issue).
  priceValidityHours: Number(process.env.PACKAGE_PRICE_VALIDITY_HOURS) || 72,

  // PRD §89 "Quotation Generator".
  quotationStatuses: parseStringList(process.env.PACKAGE_QUOTATION_STATUSES_JSON, ["Draft", "Sent", "Accepted", "Rejected", "Expired"]),
  defaultQuotationStatus: process.env.DEFAULT_PACKAGE_QUOTATION_STATUS || "Draft",

  // PRD §55-§62 "Package Flyer Generator". Ships with one real template
  // (`Standard`) for MVP rather than blocking on all 14 PRD §58 templates —
  // more are additive `templates/packages/flyer-<name>.html` files plus one
  // more entry in this list, never a code change to the render pipeline.
  flyerTemplates: parseStringList(process.env.PACKAGE_FLYER_TEMPLATES_JSON, ["Standard"]),
  defaultFlyerTemplate: process.env.DEFAULT_PACKAGE_FLYER_TEMPLATE || "Standard",
  flyerFormats: parseStringList(process.env.PACKAGE_FLYER_FORMATS_JSON, ["PNG", "JPG", "PDF"]),
  defaultFlyerFormat: process.env.DEFAULT_PACKAGE_FLYER_FORMAT || "PNG",
  // PRD §62 "Flyer Export" sizes — width/height in CSS px at the render
  // viewport's 2x device-scale-factor (services/HtmlPdfRenderer.js).
  flyerDimensionPresets: parseJson(process.env.PACKAGE_FLYER_DIMENSION_PRESETS_JSON, {
    InstagramPost: { width: 1080, height: 1080 },
    InstagramStory: { width: 1080, height: 1920 },
    FacebookPost: { width: 1200, height: 630 },
    WhatsAppImage: { width: 1080, height: 1080 },
    Square: { width: 1080, height: 1080 },
    Portrait: { width: 1080, height: 1350 },
    A4: { width: 1240, height: 1754 },
    A5: { width: 874, height: 1240 }
  }),
  defaultFlyerDimensionPreset: process.env.DEFAULT_PACKAGE_FLYER_DIMENSION_PRESET || "Portrait"
});
