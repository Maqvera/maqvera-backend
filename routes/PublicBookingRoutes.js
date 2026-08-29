import express from "express";
import rateLimit from "express-rate-limit";
import validate, { publicBookingSchemas } from "../middleware/validateRequest.js";
import { GetPublicPackages, GetPublicPackageDetail, CreatePublicBooking, CreatePublicLead } from "../controllers/PublicBookingController.js";

const router = express.Router();

// Public B2C Booking Site (PRD "CRM Feature Map by Phase" Phase 2 module
// 15) — the one router in this codebase mounted WITHOUT
// authenticateAccessToken anywhere on it (every other public-reachable
// surface, like the Stripe OAuth callback or webhook receivers, is a
// single narrow endpoint elsewhere, not a whole router). Tenant identity
// comes from `tenantSlug`, resolved against TenantProfileModel.publicSlug —
// never trust a client-supplied tenantId/x-tenant-id header, same
// discipline as the rest of this codebase, just entered through a
// deliberately different door since there's no JWT here to read it from.
const browseLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});
// Booking/lead creation writes real tenant data (a Customer, a Draft
// Booking, a Lead) from an anonymous caller — a materially tighter limit
// than the read-only browsing endpoints above.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});

router.get("/packages", browseLimiter, GetPublicPackages);
router.get("/packages/:id", browseLimiter, GetPublicPackageDetail);
router.post("/bookings", writeLimiter, validate(publicBookingSchemas.createBooking), CreatePublicBooking);
router.post("/leads", writeLimiter, validate(publicBookingSchemas.createLead), CreatePublicLead);

export default router;
