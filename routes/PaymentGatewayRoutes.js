import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { requireFeature } from "../middleware/subscriptionEnforcement.js";
import validate, { paymentGatewaySchemas } from "../middleware/validateRequest.js";
import idempotency from "../middleware/idempotency.js";
import { GetConnectUrl, OAuthCallback, DisconnectGateway, ListGateways, CreateCheckout } from "../controllers/PaymentGatewayController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// Per-Tenant Payment Gateway Integration (Stripe Connect). Deliberately
// mounted at its own `/api/v1/payment-gateways` prefix (server.js), NOT
// `/api/v1/payments` — that prefix already belongs to Finance's own
// Enterprise Payment Engine (`routes/FinanceRoutes.js` -> `controllers/PaymentController.js`,
// Part 7, AR/AP payment recording). Mounting here would have silently
// collided: Express matches routers in registration order, so a bare
// `GET /api/v1/payments/gateways` would have been swallowed by Finance's
// own `GET /payments/:paymentId` route (treating "gateways" as a
// paymentId) before ever reaching this router. Also deliberately NOT
// `router.use(authenticateAccessToken)` at the top (the shape every other
// route file in this codebase uses) — the OAuth callback below is opened
// by the BROWSER via Stripe's own redirect, with no JWT available at all;
// applying auth per-route instead keeps that one route reachable while
// every other route here stays properly authenticated.
//
// Enterprise Subscription Platform — `requireFeature("paymentGatewayConnect")`
// (PRD Issue 11, revised) applied per-route, same reason auth is per-route
// rather than a blanket `router.use(...)`: the OAuth callback has no real
// `req.auth`/tenant scope for `requireFeature` to check against at all (it's
// Stripe's own browser redirect), so gating it the same way as the other
// routes would break the callback outright, not just leave it ungated.
router.get("/connect/stripe", limiter, authenticateAccessToken, requireFeature("paymentGatewayConnect"), GetConnectUrl);
router.get("/oauth/stripe/callback", limiter, OAuthCallback); // no auth middleware — signed `state` param IS the authentication, see PaymentGatewayController.js's own doc comment
router.post("/disconnect", limiter, authenticateAccessToken, requireFeature("paymentGatewayConnect"), validate(paymentGatewaySchemas.disconnectGateway), DisconnectGateway);
router.get("/", limiter, authenticateAccessToken, requireFeature("paymentGatewayConnect"), ListGateways);
// "Customer WhatsApp par baat karta hai... phir payment link" — the
// agency's own booking flow calls this (never the customer directly).
// `idempotency()` guards against a double-click/retry creating two
// separate real Stripe Checkout Sessions for the same booking.
router.post("/checkout", limiter, authenticateAccessToken, requireFeature("paymentGatewayConnect"), idempotency(), validate(paymentGatewaySchemas.createCheckout), CreateCheckout);

export default router;
