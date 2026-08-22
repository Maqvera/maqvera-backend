import PackagePricingService from "../services/PackagePricingService.js";
import PackageFlyerService from "../services/PackageFlyerService.js";
import PackageWhatsAppMessageService from "../services/PackageWhatsAppMessageService.js";
import PackageAnalyticsService from "../services/PackageAnalyticsService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already exists")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("must be")) return 400;
  return 500;
};

const userIdFrom = (req) => req.auth?.userId || req.auth?.id || null;

// PRD §50/§117 "Profit Visibility... Sales agent cannot see supplier
// cost/profit." Cost/markup/commission fields are stripped from every
// room-wise matrix row unless the caller holds package.pricing.cost.read
// (or admin) — applied uniformly wherever a matrix leaves this controller.
const COST_MATRIX_FIELDS = ["hotelCostPerPerson", "transportCostPerPerson", "flightCostPerPerson", "visaCostPerPerson", "servicesCostPerPerson", "subtotalPerPerson", "markupAmount", "commissionPerPerson"];

const redactPackageCost = (pkg, canSeeCost) => {
  if (canSeeCost || !pkg || !Array.isArray(pkg.roomWisePriceMatrix)) return pkg;
  return {
    ...pkg,
    roomWisePriceMatrix: pkg.roomWisePriceMatrix.map((row) => {
      const clean = { ...row };
      for (const field of COST_MATRIX_FIELDS) delete clean[field];
      return clean;
    })
  };
};

// ---- Room Types ----

export const createRoomType = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const roomType = await PackagePricingService.createRoomType(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Room type created successfully.", roomType, requestId);
  } catch (error) {
    console.error("createRoomType error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create room type.", requestId);
  }
};

export const listRoomTypes = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.listRoomTypes(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Room types retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listRoomTypes error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve room types.", requestId);
  }
};

// ---- Transport Vehicles ----

export const createTransportVehicle = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const vehicle = await PackagePricingService.createTransportVehicle(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Transport vehicle created successfully.", vehicle, requestId);
  } catch (error) {
    console.error("createTransportVehicle error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create transport vehicle.", requestId);
  }
};

export const listTransportVehicles = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.listTransportVehicles(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Transport vehicles retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listTransportVehicles error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve transport vehicles.", requestId);
  }
};

// ---- Hotel Rates ----

export const createHotelRate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const rate = await PackagePricingService.createHotelRate(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Hotel rate created successfully.", rate, requestId);
  } catch (error) {
    console.error("createHotelRate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create hotel rate.", requestId);
  }
};

export const listHotelRates = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.listHotelRates(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Hotel rates retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listHotelRates error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve hotel rates.", requestId);
  }
};

// ---- Transport Rates ----

export const createTransportRate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const rate = await PackagePricingService.createTransportRate(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Transport rate created successfully.", rate, requestId);
  } catch (error) {
    console.error("createTransportRate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create transport rate.", requestId);
  }
};

export const listTransportRates = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.listTransportRates(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Transport rates retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listTransportRates error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve transport rates.", requestId);
  }
};

// ---- Flight Rates ----

export const createFlightRate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const rate = await PackagePricingService.createFlightRate(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Flight rate created successfully.", rate, requestId);
  } catch (error) {
    console.error("createFlightRate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create flight rate.", requestId);
  }
};

export const listFlightRates = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.listFlightRates(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Flight rates retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listFlightRates error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve flight rates.", requestId);
  }
};

// ---- Visa Rates ----

export const createVisaRate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const rate = await PackagePricingService.createVisaRate(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Visa rate created successfully.", rate, requestId);
  } catch (error) {
    console.error("createVisaRate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create visa rate.", requestId);
  }
};

export const listVisaRates = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.listVisaRates(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Visa rates retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listVisaRates error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve visa rates.", requestId);
  }
};

// ---- Service Rates ----

export const createServiceRate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const rate = await PackagePricingService.createServiceRate(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Service rate created successfully.", rate, requestId);
  } catch (error) {
    console.error("createServiceRate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create service rate.", requestId);
  }
};

export const listServiceRates = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.listServiceRates(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Service rates retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listServiceRates error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve service rates.", requestId);
  }
};

// ---- Markup Rules ----

export const createMarkupRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const rule = await PackagePricingService.createMarkupRule(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Markup rule created successfully.", rule, requestId);
  } catch (error) {
    console.error("createMarkupRule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create markup rule.", requestId);
  }
};

export const listMarkupRules = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.listMarkupRules(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Markup rules retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listMarkupRules error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve markup rules.", requestId);
  }
};

// ---- Packages ----

export const createPackage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const pkg = await PackagePricingService.createPackage(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Package created successfully.", pkg, requestId);
  } catch (error) {
    console.error("createPackage error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create package.", requestId);
  }
};

export const listPackages = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const canSeeCost = hasPermission(req, "package.pricing.cost.read");
    const items = (await PackagePricingService.listPackages(req.query, scope.tenantId)).map((pkg) => redactPackageCost(pkg, canSeeCost));
    return sendSuccess(res, 200, "Packages retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listPackages error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve packages.", requestId);
  }
};

export const getPackage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const pkg = await PackagePricingService.getPackageById(req.params.packageId, scope.tenantId);
    const canSeeCost = hasPermission(req, "package.pricing.cost.read");
    return sendSuccess(res, 200, "Package retrieved successfully.", redactPackageCost(pkg, canSeeCost), requestId);
  } catch (error) {
    console.error("getPackage error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve package.", requestId);
  }
};

export const calculatePackage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.calculate", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await PackagePricingService.calculatePackage(req.params.packageId, scope.tenantId, userIdFrom(req), { recalculate: !!req.body?.recalculate });
    const canSeeCost = hasPermission(req, "package.pricing.cost.read");
    return sendSuccess(res, 200, "Package calculated successfully.", redactPackageCost(result, canSeeCost), requestId);
  } catch (error) {
    console.error("calculatePackage error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to calculate package.", requestId);
  }
};

export const finalizePackage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.finalize", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const pkg = await PackagePricingService.finalizePackage(req.params.packageId, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 200, "Package finalized successfully.", pkg, requestId);
  } catch (error) {
    console.error("finalizePackage error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to finalize package.", requestId);
  }
};

export const updatePackage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { reason, ...data } = req.body || {};
    const pkg = await PackagePricingService.updatePackage(req.params.packageId, data, scope.tenantId, userIdFrom(req), reason);
    return sendSuccess(res, 200, "Package updated successfully.", pkg, requestId);
  } catch (error) {
    console.error("updatePackage error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update package.", requestId);
  }
};

export const linkPackageToBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const pkg = await PackagePricingService.linkPackageToBooking(req.params.packageId, req.body?.bookingId, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 200, "Package linked to booking successfully.", pkg, requestId);
  } catch (error) {
    console.error("linkPackageToBooking error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to link package to booking.", requestId);
  }
};

export const saveAsTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const template = await PackagePricingService.saveAsTemplate(req.params.packageId, req.body?.name, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Package template saved successfully.", template, requestId);
  } catch (error) {
    console.error("saveAsTemplate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to save package template.", requestId);
  }
};

export const listPackageTemplates = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.listPackageTemplates(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Package templates retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listPackageTemplates error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve package templates.", requestId);
  }
};

export const cloneFromTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const pkg = await PackagePricingService.cloneFromTemplate(req.params.templateId, req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Package created from template successfully.", pkg, requestId);
  } catch (error) {
    console.error("cloneFromTemplate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create package from template.", requestId);
  }
};

export const getAnalyticsSummary = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    // Profit/margin data — same visibility gate as roomWisePriceMatrix's own cost fields.
    if (!hasPermission(req, "package.pricing.cost.read")) return sendError(res, 403, "Permission denied.", requestId);

    const summary = await PackageAnalyticsService.getSummary(scope.tenantId);
    return sendSuccess(res, 200, "Package analytics retrieved successfully.", summary, requestId);
  } catch (error) {
    console.error("getAnalyticsSummary error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve package analytics.", requestId);
  }
};

export const getRoomCombinations = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const combinations = await PackagePricingService.getRoomCombinations(req.params.packageId, scope.tenantId);
    return sendSuccess(res, 200, "Room combinations retrieved successfully.", { items: combinations }, requestId);
  } catch (error) {
    console.error("getRoomCombinations error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve room combinations.", requestId);
  }
};

export const comparePackages = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const canSeeCost = hasPermission(req, "package.pricing.cost.read");
    const items = (await PackagePricingService.comparePackages(req.body?.packageIds, scope.tenantId)).map((pkg) => redactPackageCost(pkg, canSeeCost));
    return sendSuccess(res, 200, "Packages compared successfully.", { items }, requestId);
  } catch (error) {
    console.error("comparePackages error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to compare packages.", requestId);
  }
};

export const convertPackageToBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await PackagePricingService.convertPackageToBooking(req.params.packageId, req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Package converted to booking successfully.", result, requestId);
  } catch (error) {
    console.error("convertPackageToBooking error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to convert package to booking.", requestId);
  }
};

export const generateFlyer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.marketing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const flyer = await PackageFlyerService.generateFlyer(req.params.packageId, req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Flyer generated successfully.", flyer, requestId);
  } catch (error) {
    console.error("generateFlyer error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate flyer.", requestId);
  }
};

export const listFlyersForPackage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.marketing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackageFlyerService.listFlyersForPackage(req.params.packageId, scope.tenantId);
    return sendSuccess(res, 200, "Flyers retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listFlyersForPackage error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve flyers.", requestId);
  }
};

export const sendWhatsAppMessage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.marketing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await PackageWhatsAppMessageService.sendPackageMessage(req.params.packageId, req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "WhatsApp message sent successfully.", result, requestId);
  } catch (error) {
    console.error("sendWhatsAppMessage error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to send WhatsApp message.", requestId);
  }
};

// ---- Update endpoints (master/rate data) — PRD §75 rate audit trail ----

const makeUpdateHandler = (serviceMethodName, label) => async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { reason, ...data } = req.body || {};
    const idParam = Object.keys(req.params)[0];
    const record = await PackagePricingService[serviceMethodName](req.params[idParam], data, scope.tenantId, userIdFrom(req), reason);
    return sendSuccess(res, 200, `${label} updated successfully.`, record, requestId);
  } catch (error) {
    console.error(`${serviceMethodName} error:`, error);
    return sendError(res, statusFromError(error), error.message || `Failed to update ${label.toLowerCase()}.`, requestId);
  }
};

export const updateRoomType = makeUpdateHandler("updateRoomType", "Room type");
export const updateTransportVehicle = makeUpdateHandler("updateTransportVehicle", "Transport vehicle");
export const updateHotelRate = makeUpdateHandler("updateHotelRate", "Hotel rate");
export const updateTransportRate = makeUpdateHandler("updateTransportRate", "Transport rate");
export const updateFlightRate = makeUpdateHandler("updateFlightRate", "Flight rate");
export const updateVisaRate = makeUpdateHandler("updateVisaRate", "Visa rate");
export const updateServiceRate = makeUpdateHandler("updateServiceRate", "Service rate");
export const updateMarkupRule = makeUpdateHandler("updateMarkupRule", "Markup rule");
export const updateSupplier = makeUpdateHandler("updateSupplier", "Supplier");

// ---- Bulk rate management (PRD §112 / PRD v2 §14) ----

const makeBulkCreateHandler = (rateType) => async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.bulkCreateRates(rateType, req.body?.items, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, `${items.length} rate(s) created successfully.`, { items }, requestId);
  } catch (error) {
    console.error(`bulkCreate ${rateType} error:`, error);
    return sendError(res, statusFromError(error), error.message || "Failed to bulk-create rates.", requestId);
  }
};

const makeBulkStatusHandler = (rateType) => async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await PackagePricingService.bulkUpdateRateStatus(rateType, req.body?.ids, req.body?.status, scope.tenantId, userIdFrom(req), req.body?.reason);
    return sendSuccess(res, 200, "Rate status updated successfully.", result, requestId);
  } catch (error) {
    console.error(`bulkStatus ${rateType} error:`, error);
    return sendError(res, statusFromError(error), error.message || "Failed to bulk-update rate status.", requestId);
  }
};

const makeCloneHandler = (rateType) => async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const idParam = Object.keys(req.params)[0];
    const clone = await PackagePricingService.cloneRate(rateType, req.params[idParam], req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Rate cloned successfully.", clone, requestId);
  } catch (error) {
    console.error(`clone ${rateType} error:`, error);
    return sendError(res, statusFromError(error), error.message || "Failed to clone rate.", requestId);
  }
};

const makeExportHandler = (rateType) => async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { content, filename } = await PackagePricingService.exportRatesToCsv(rateType, req.query, scope.tenantId);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(content);
  } catch (error) {
    console.error(`export ${rateType} error:`, error);
    return sendError(res, 500, error.message || "Failed to export rates.", requestId);
  }
};

export const bulkCreateHotelRates = makeBulkCreateHandler("hotel-rates");
export const bulkCreateTransportRates = makeBulkCreateHandler("transport-rates");
export const bulkCreateFlightRates = makeBulkCreateHandler("flight-rates");
export const bulkCreateVisaRates = makeBulkCreateHandler("visa-rates");
export const bulkCreateServiceRates = makeBulkCreateHandler("service-rates");

export const bulkStatusHotelRates = makeBulkStatusHandler("hotel-rates");
export const bulkStatusTransportRates = makeBulkStatusHandler("transport-rates");
export const bulkStatusFlightRates = makeBulkStatusHandler("flight-rates");
export const bulkStatusVisaRates = makeBulkStatusHandler("visa-rates");
export const bulkStatusServiceRates = makeBulkStatusHandler("service-rates");

export const cloneHotelRate = makeCloneHandler("hotel-rates");
export const cloneTransportRate = makeCloneHandler("transport-rates");
export const cloneFlightRate = makeCloneHandler("flight-rates");
export const cloneVisaRate = makeCloneHandler("visa-rates");
export const cloneServiceRate = makeCloneHandler("service-rates");

export const exportHotelRates = makeExportHandler("hotel-rates");
export const exportTransportRates = makeExportHandler("transport-rates");
export const exportFlightRates = makeExportHandler("flight-rates");
export const exportVisaRates = makeExportHandler("visa-rates");
export const exportServiceRates = makeExportHandler("service-rates");

// ---- Suppliers ----

export const createSupplier = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const supplier = await PackagePricingService.createSupplier(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Supplier created successfully.", supplier, requestId);
  } catch (error) {
    console.error("createSupplier error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create supplier.", requestId);
  }
};

export const listSuppliers = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.listSuppliers(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Suppliers retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listSuppliers error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve suppliers.", requestId);
  }
};

// ---- Commission Rules ----

export const createCommissionRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const rule = await PackagePricingService.createCommissionRule(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Commission rule created successfully.", rule, requestId);
  } catch (error) {
    console.error("createCommissionRule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create commission rule.", requestId);
  }
};

export const listCommissionRules = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.cost.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.listCommissionRules(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Commission rules retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listCommissionRules error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve commission rules.", requestId);
  }
};

// ---- Quotations ----

export const createQuotation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.quotation.manage", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const quotation = await PackagePricingService.createQuotation(req.params.packageId, req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Quotation created successfully.", quotation, requestId);
  } catch (error) {
    console.error("createQuotation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create quotation.", requestId);
  }
};

export const listQuotationsForPackage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PackagePricingService.listQuotationsForPackage(req.params.packageId, scope.tenantId);
    return sendSuccess(res, 200, "Quotations retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listQuotationsForPackage error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve quotations.", requestId);
  }
};

export const getQuotation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.read", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const quotation = await PackagePricingService.getQuotationById(req.params.quotationId, scope.tenantId);
    return sendSuccess(res, 200, "Quotation retrieved successfully.", quotation, requestId);
  } catch (error) {
    console.error("getQuotation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve quotation.", requestId);
  }
};

export const generateQuotationPdf = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "package.pricing.quotation.manage", "package.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const quotation = await PackagePricingService.generateQuotationPdf(req.params.quotationId, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 200, "Quotation PDF generated successfully.", quotation, requestId);
  } catch (error) {
    console.error("generateQuotationPdf error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate quotation PDF.", requestId);
  }
};
