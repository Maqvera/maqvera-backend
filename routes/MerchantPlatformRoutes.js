import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { platformSchemas } from "../middleware/validateRequest.js";
import idempotency from "../middleware/idempotency.js";
import {
  createMerchant,
  listMerchants,
  getMerchant,
  verifyMerchant,
  joinMerchant,
  suspendMerchant,
  reactivateMerchant,
  listBillingAccounts,
  createBillingAccountResource,
  createBillingInvoice,
  addPaymentMethod,
  createOrGetWallet,
  getWallet,
  refundToMerchantWallet,
  getBillingHistory
} from "../controllers/MerchantAccountController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// Enterprise Merchant & Billing Platform (Improvement 3) — File 0's own
// spec's literal `/api/v1/merchants`, `/api/v1/billing-accounts`,
// `/api/v1/billing-invoices`, `/api/v1/payment-methods`,
// `/api/v1/wallets`, `/api/v1/merchant/refund`, `/api/v1/billing-history`
// contract. Mounted at `/api/v1` in server.js (each route below already
// carries its own real base segment).
//
// Same "no separate Platform Operator identity" cross-tenant-safety
// discipline as every other endpoint in this platform family — see
// controllers/MerchantAccountController.js's own doc comments for exactly
// where and why each handler resolves ownership from getAccessScope(req)
// rather than trusting a request-supplied id.
router.use(authenticateAccessToken);

router.post("/merchants", limiter, idempotency(), validate(platformSchemas.createMerchant), createMerchant);
router.get("/merchants", limiter, listMerchants);
router.get("/merchants/:merchantId", limiter, getMerchant);
router.post("/merchants/:merchantId/verify", limiter, verifyMerchant);
router.post("/merchants/:merchantId/join", limiter, joinMerchant);
router.post("/merchants/:merchantId/suspend", limiter, validate(platformSchemas.merchantSuspend), suspendMerchant);
router.post("/merchants/:merchantId/reactivate", limiter, reactivateMerchant);
router.get("/merchants/:merchantId/wallet", limiter, getWallet);

router.get("/billing-accounts", limiter, listBillingAccounts);
router.post("/billing-accounts", limiter, idempotency(), createBillingAccountResource);

router.post("/billing-invoices", limiter, idempotency(), createBillingInvoice);

router.post("/payment-methods", limiter, validate(platformSchemas.addPaymentMethod), addPaymentMethod);

router.post("/wallets", limiter, idempotency(), validate(platformSchemas.walletOperation), createOrGetWallet);

router.post("/merchant/refund", limiter, idempotency(), validate(platformSchemas.merchantRefund), refundToMerchantWallet);

router.get("/billing-history", limiter, getBillingHistory);

export default router;
