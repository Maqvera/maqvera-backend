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
  calculatePackage,
  finalizePackage,
  createQuotation,
  listQuotationsForPackage,
  getQuotation,
  generateQuotationPdf,
  generateFlyer,
  listFlyersForPackage,
  sendWhatsAppMessage
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

router.get("/hotel-rates", authenticateAccessToken, limiter, listHotelRates);
router.post("/hotel-rates", authenticateAccessToken, limiter, validate(packagePricingSchemas.createHotelRate), createHotelRate);
router.patch("/hotel-rates/:rateId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateHotelRate);

router.get("/transport-rates", authenticateAccessToken, limiter, listTransportRates);
router.post("/transport-rates", authenticateAccessToken, limiter, validate(packagePricingSchemas.createTransportRate), createTransportRate);
router.patch("/transport-rates/:rateId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateTransportRate);

router.get("/flight-rates", authenticateAccessToken, limiter, listFlightRates);
router.post("/flight-rates", authenticateAccessToken, limiter, validate(packagePricingSchemas.createFlightRate), createFlightRate);
router.patch("/flight-rates/:rateId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateFlightRate);

router.get("/visa-rates", authenticateAccessToken, limiter, listVisaRates);
router.post("/visa-rates", authenticateAccessToken, limiter, validate(packagePricingSchemas.createVisaRate), createVisaRate);
router.patch("/visa-rates/:rateId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateVisaRate);

router.get("/service-rates", authenticateAccessToken, limiter, listServiceRates);
router.post("/service-rates", authenticateAccessToken, limiter, validate(packagePricingSchemas.createServiceRate), createServiceRate);
router.patch("/service-rates/:rateId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateServiceRate);

router.get("/markup-rules", authenticateAccessToken, limiter, listMarkupRules);
router.post("/markup-rules", authenticateAccessToken, limiter, validate(packagePricingSchemas.createMarkupRule), createMarkupRule);
router.patch("/markup-rules/:ruleId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateMarkupRule);

router.get("/suppliers", authenticateAccessToken, limiter, listSuppliers);
router.post("/suppliers", authenticateAccessToken, limiter, validate(packagePricingSchemas.createSupplier), createSupplier);
router.patch("/suppliers/:supplierId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updateRecord), updateSupplier);

router.get("/commission-rules", authenticateAccessToken, limiter, listCommissionRules);
router.post("/commission-rules", authenticateAccessToken, limiter, validate(packagePricingSchemas.createCommissionRule), createCommissionRule);

// ---- Quotations ----
router.get("/quotations/:quotationId", authenticateAccessToken, limiter, getQuotation);
router.post("/quotations/:quotationId/pdf", authenticateAccessToken, limiter, generateQuotationPdf);

// ---- Packages ----
// This router is mounted at /api/v1/packages (server.js), so these are the
// base "/" resource routes for that mount. Registered AFTER every literal
// master/rate-data path above so a request like GET /packages/room-types
// matches the literal route, never falls through to the dynamic
// "/:packageId" routes below — same static-before-dynamic ordering used
// throughout routes/FinanceRoutes.js.
router.get("/", authenticateAccessToken, limiter, listPackages);
router.post("/", authenticateAccessToken, limiter, validate(packagePricingSchemas.createPackage), createPackage);
router.get("/:packageId", authenticateAccessToken, limiter, getPackage);
router.patch("/:packageId", authenticateAccessToken, limiter, validate(packagePricingSchemas.updatePackage), updatePackage);
router.post("/:packageId/link-booking", authenticateAccessToken, limiter, validate(packagePricingSchemas.linkBooking), linkPackageToBooking);
router.post("/:packageId/convert-to-booking", authenticateAccessToken, limiter, validate(packagePricingSchemas.convertToBooking), convertPackageToBooking);
router.post("/:packageId/calculate", authenticateAccessToken, limiter, validate(packagePricingSchemas.calculatePackage), calculatePackage);
router.post("/:packageId/finalize", authenticateAccessToken, limiter, finalizePackage);
router.get("/:packageId/quotations", authenticateAccessToken, limiter, listQuotationsForPackage);
router.post("/:packageId/quotations", authenticateAccessToken, limiter, validate(packagePricingSchemas.createQuotation), createQuotation);
router.get("/:packageId/flyers", authenticateAccessToken, limiter, listFlyersForPackage);
router.post("/:packageId/flyers", authenticateAccessToken, limiter, validate(packagePricingSchemas.generateFlyer), generateFlyer);
router.post("/:packageId/whatsapp-message", authenticateAccessToken, limiter, validate(packagePricingSchemas.sendWhatsAppMessage), sendWhatsAppMessage);

export default router;
