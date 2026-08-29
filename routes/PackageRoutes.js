import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { packagePricingSchemas } from "../middleware/validateRequest.js";
import {
  createRoomType,
  listRoomTypes,
  updateRoomType,
  createTransportVehicle,
  listTransportVehicles,
  updateTransportVehicle,
  createHotelCatalog,
  listHotelCatalog,
  updateHotelCatalog,
  createHotelRate,
  listHotelRates,
  updateHotelRate,
  createTransportRate,
  listTransportRates,
  updateTransportRate,
  createFlightRate,
  listFlightRates,
  updateFlightRate,
  createVisaRate,
  listVisaRates,
  updateVisaRate,
  createServiceRate,
  listServiceRates,
  updateServiceRate,
  createMarkupRule,
  listMarkupRules,
  updateMarkupRule,
  createSupplier,
  listSuppliers,
  updateSupplier,
  createCommissionRule,
  listCommissionRules,
  createPackage,
  listPackages,
  getPackage,
  updatePackage,
  linkPackageToBooking,
  convertPackageToBooking,
  saveAsTemplate,
  listPackageTemplates,
  updatePackageTemplate,
  cloneFromTemplate,
  getRoomCombinations,
  comparePackages,
  getAnalyticsSummary,
  calculatePackage,
  finalizePackage,
  createQuotation,
  listQuotationsForPackage,
  getQuotation,
  generateQuotationPdf,
  sendQuotation,
  convertQuotationToBooking,
  getDynamicPricingSuggestion,
  generateFlyer,
  listFlyersForPackage,
  sendWhatsAppMessage,
  bulkCreateHotelRates, bulkStatusHotelRates, cloneHotelRate, exportHotelRates,
  bulkCreateTransportRates, bulkStatusTransportRates, cloneTransportRate, exportTransportRates,
  bulkCreateFlightRates, bulkStatusFlightRates, cloneFlightRate, exportFlightRates,
  bulkCreateVisaRates, bulkStatusVisaRates, cloneVisaRate, exportVisaRates,
  bulkCreateServiceRates, bulkStatusServiceRates, cloneServiceRate, exportServiceRates
} from "../controllers/PackagePricingController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});

// Package Pricing Engine — Global-Package-Pricing-Engine-PRD-v2.1. Every
// route here touches tenant-owned cost/pricing data, so — unlike some
// reference-catalog routes elsewhere in this codebase — nothing here is
// public; every route requires authenticateAccessToken, matching the
// pattern this session already applied to visa-case reads in
// routes/VisaRoutes.js.

// ---- Master / rate data ----
router.get("/room-types", authenticateAccessToken, limiter, listRoomTypes);
router.post("/room-types", authenticateAccessToken, limiter, validate(packagePricingSchemas.createRoomType), createRoomType);
router.patch("/room-types/:roomTypeId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateRoomType);

router.get("/transport-vehicles", authenticateAccessToken, limiter, listTransportVehicles);
router.post("/transport-vehicles", authenticateAccessToken, limiter, validate(packagePricingSchemas.createTransportVehicle), createTransportVehicle);
router.patch("/transport-vehicles/:vehicleId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateTransportVehicle);

router.get("/hotel-catalog", authenticateAccessToken, limiter, listHotelCatalog);
router.post("/hotel-catalog", authenticateAccessToken, limiter, validate(packagePricingSchemas.createHotelCatalog), createHotelCatalog);
router.patch("/hotel-catalog/:hotelCatalogId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateHotelCatalog);

router.get("/hotel-rates", authenticateAccessToken, limiter, listHotelRates);
router.post("/hotel-rates", authenticateAccessToken, limiter, validate(packagePricingSchemas.createHotelRate), createHotelRate);
router.post("/hotel-rates/bulk", authenticateAccessToken, limiter, validate(packagePricingSchemas.bulkCreateRates), bulkCreateHotelRates);
router.patch("/hotel-rates/bulk-status", authenticateAccessToken, limiter, validate(packagePricingSchemas.bulkUpdateRateStatus), bulkStatusHotelRates);
router.get("/hotel-rates/export", authenticateAccessToken, limiter, exportHotelRates);
router.patch("/hotel-rates/:rateId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateHotelRate);
router.post("/hotel-rates/:rateId/clone", authenticateAccessToken, limiter, validate(packagePricingSchemas.cloneRate), cloneHotelRate);

router.get("/transport-rates", authenticateAccessToken, limiter, listTransportRates);
router.post("/transport-rates", authenticateAccessToken, limiter, validate(packagePricingSchemas.createTransportRate), createTransportRate);
router.post("/transport-rates/bulk", authenticateAccessToken, limiter, validate(packagePricingSchemas.bulkCreateRates), bulkCreateTransportRates);
router.patch("/transport-rates/bulk-status", authenticateAccessToken, limiter, validate(packagePricingSchemas.bulkUpdateRateStatus), bulkStatusTransportRates);
router.get("/transport-rates/export", authenticateAccessToken, limiter, exportTransportRates);
router.patch("/transport-rates/:rateId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateTransportRate);
router.post("/transport-rates/:rateId/clone", authenticateAccessToken, limiter, validate(packagePricingSchemas.cloneRate), cloneTransportRate);

router.get("/flight-rates", authenticateAccessToken, limiter, listFlightRates);
router.post("/flight-rates", authenticateAccessToken, limiter, validate(packagePricingSchemas.createFlightRate), createFlightRate);
router.post("/flight-rates/bulk", authenticateAccessToken, limiter, validate(packagePricingSchemas.bulkCreateRates), bulkCreateFlightRates);
router.patch("/flight-rates/bulk-status", authenticateAccessToken, limiter, validate(packagePricingSchemas.bulkUpdateRateStatus), bulkStatusFlightRates);
router.get("/flight-rates/export", authenticateAccessToken, limiter, exportFlightRates);
router.patch("/flight-rates/:rateId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateFlightRate);
router.post("/flight-rates/:rateId/clone", authenticateAccessToken, limiter, validate(packagePricingSchemas.cloneRate), cloneFlightRate);

router.get("/visa-rates", authenticateAccessToken, limiter, listVisaRates);
router.post("/visa-rates", authenticateAccessToken, limiter, validate(packagePricingSchemas.createVisaRate), createVisaRate);
router.post("/visa-rates/bulk", authenticateAccessToken, limiter, validate(packagePricingSchemas.bulkCreateRates), bulkCreateVisaRates);
router.patch("/visa-rates/bulk-status", authenticateAccessToken, limiter, validate(packagePricingSchemas.bulkUpdateRateStatus), bulkStatusVisaRates);
router.get("/visa-rates/export", authenticateAccessToken, limiter, exportVisaRates);
router.patch("/visa-rates/:rateId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateVisaRate);
router.post("/visa-rates/:rateId/clone", authenticateAccessToken, limiter, validate(packagePricingSchemas.cloneRate), cloneVisaRate);

router.get("/service-rates", authenticateAccessToken, limiter, listServiceRates);
router.post("/service-rates", authenticateAccessToken, limiter, validate(packagePricingSchemas.createServiceRate), createServiceRate);
router.post("/service-rates/bulk", authenticateAccessToken, limiter, validate(packagePricingSchemas.bulkCreateRates), bulkCreateServiceRates);
router.patch("/service-rates/bulk-status", authenticateAccessToken, limiter, validate(packagePricingSchemas.bulkUpdateRateStatus), bulkStatusServiceRates);
router.get("/service-rates/export", authenticateAccessToken, limiter, exportServiceRates);
router.patch("/service-rates/:rateId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateServiceRate);
router.post("/service-rates/:rateId/clone", authenticateAccessToken, limiter, validate(packagePricingSchemas.cloneRate), cloneServiceRate);

router.get("/markup-rules", authenticateAccessToken, limiter, listMarkupRules);
router.post("/markup-rules", authenticateAccessToken, limiter, validate(packagePricingSchemas.createMarkupRule), createMarkupRule);
router.patch("/markup-rules/:ruleId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateMarkupRule);

router.get("/suppliers", authenticateAccessToken, limiter, listSuppliers);
router.post("/suppliers", authenticateAccessToken, limiter, validate(packagePricingSchemas.createSupplier), createSupplier);
router.patch("/suppliers/:supplierId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateSupplier);

router.get("/commission-rules", authenticateAccessToken, limiter, listCommissionRules);
router.post("/commission-rules", authenticateAccessToken, limiter, validate(packagePricingSchemas.createCommissionRule), createCommissionRule);

// ---- Package Templates (PRD §82) ----
router.get("/package-templates", authenticateAccessToken, limiter, listPackageTemplates);
router.patch("/package-templates/:templateId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updatePackageTemplate), updatePackageTemplate);
router.post("/package-templates/:templateId/clone", authenticateAccessToken, limiter, validate(packagePricingSchemas.cloneFromTemplate), cloneFromTemplate);

// ---- Quotations ----
router.get("/quotations/:quotationId", authenticateAccessToken, limiter, getQuotation);
router.post("/quotations/:quotationId/pdf", authenticateAccessToken, limiter, generateQuotationPdf);
router.post("/quotations/:quotationId/send", authenticateAccessToken, limiter, validate(packagePricingSchemas.sendQuotation), sendQuotation);
router.post("/quotations/:quotationId/convert-to-booking", authenticateAccessToken, limiter, validate(packagePricingSchemas.convertQuotationToBooking), convertQuotationToBooking);

// ---- Packages ----
// This router is mounted at /api/v1/packages (server.js), so these are the
// base "/" resource routes for that mount. Registered AFTER every literal
// master/rate-data path above so a request like GET /packages/room-types
// matches the literal route, never falls through to the dynamic
// "/:packageId" routes below — same static-before-dynamic ordering used
// throughout routes/FinanceRoutes.js.
router.get("/", authenticateAccessToken, limiter, listPackages);
router.post("/", authenticateAccessToken, limiter, validate(packagePricingSchemas.createPackage), createPackage);
router.post("/compare", authenticateAccessToken, limiter, validate(packagePricingSchemas.comparePackages), comparePackages);
router.get("/analytics/summary", authenticateAccessToken, limiter, getAnalyticsSummary);
router.get("/:packageId", authenticateAccessToken, limiter, getPackage);
router.get("/:packageId/room-combinations", authenticateAccessToken, limiter, getRoomCombinations);
router.get("/:packageId/dynamic-pricing-suggestion", authenticateAccessToken, limiter, getDynamicPricingSuggestion);
router.patch("/:packageId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updatePackage), updatePackage);
router.post("/:packageId/link-booking", authenticateAccessToken, limiter, validate(packagePricingSchemas.linkBooking), linkPackageToBooking);
router.post("/:packageId/convert-to-booking", authenticateAccessToken, limiter, validate(packagePricingSchemas.convertToBooking), convertPackageToBooking);
router.post("/:packageId/save-as-template", authenticateAccessToken, limiter, validate(packagePricingSchemas.saveAsTemplate), saveAsTemplate);
router.post("/:packageId/calculate", authenticateAccessToken, limiter, validate(packagePricingSchemas.calculatePackage), calculatePackage);
router.post("/:packageId/finalize", authenticateAccessToken, limiter, finalizePackage);
router.get("/:packageId/quotations", authenticateAccessToken, limiter, listQuotationsForPackage);
router.post("/:packageId/quotations", authenticateAccessToken, limiter, validate(packagePricingSchemas.createQuotation), createQuotation);
router.get("/:packageId/flyers", authenticateAccessToken, limiter, listFlyersForPackage);
router.post("/:packageId/flyers", authenticateAccessToken, limiter, validate(packagePricingSchemas.generateFlyer), generateFlyer);
router.post("/:packageId/whatsapp-message", authenticateAccessToken, limiter, validate(packagePricingSchemas.sendWhatsAppMessage), sendWhatsAppMessage);

export default router;
