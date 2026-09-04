import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import authenticateVendorPortalToken from "../middleware/authenticateVendorPortalToken.js";
import {
  issueSupplierPortalToken, listSupplierPortalTokens, revokeSupplierPortalToken,
  getMySupplierProfile, submitSupplierInvoice, listMySupplierInvoices, listMySupplierPayments
} from "../controllers/SupplierPortalController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});

// ---- Supplier-side (X-Supplier-Token, own vendor's data only) ----
router.get("/me", authenticateVendorPortalToken, limiter, getMySupplierProfile);
router.post("/invoices", authenticateVendorPortalToken, limiter, submitSupplierInvoice);
router.get("/invoices", authenticateVendorPortalToken, limiter, listMySupplierInvoices);
router.get("/payments", authenticateVendorPortalToken, limiter, listMySupplierPayments);

// ---- Staff-side (existing tenant token) — issue/revoke a supplier's own credential ----
router.post("/vendors/:vendorId/tokens", authenticateAccessToken, limiter, issueSupplierPortalToken);
router.get("/vendors/:vendorId/tokens", authenticateAccessToken, limiter, listSupplierPortalTokens);
router.post("/tokens/:tokenId/revoke", authenticateAccessToken, limiter, revokeSupplierPortalToken);

export default router;
