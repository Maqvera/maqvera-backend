import express from "express";
import { HandleStripeWebhook } from "../controllers/PaymentWebhookController.js";

const router = express.Router();

// No `authenticateAccessToken` — Stripe cannot send a JWT. Real Stripe
// signature verification (inside `HandleStripeWebhook`) IS the
// authentication for this route. No rate limiter either — Stripe's own
// delivery volume/retry behavior should never be artificially throttled
// by this app; the real duplicate-delivery protection is the idempotency
// claim in the controller, not a rate limit.
//
// Critical: this router is mounted in `server.js` with `express.raw()`
// scoped to its exact path, and that mount MUST come before the global
// `app.use(express.json(...))` — Stripe signature verification needs the
// exact raw bytes Stripe signed; `express.json()` would already have
// consumed and reserialized the body by the time this router saw it.
router.post("/stripe", HandleStripeWebhook);

export default router;
