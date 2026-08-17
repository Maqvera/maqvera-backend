import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { platformSchemas } from "../middleware/validateRequest.js";
import idempotency from "../middleware/idempotency.js";
import {
  createSubscriptionResource,
  listSubscriptionsResource,
  renewSubscriptionResource,
  suspendSubscriptionResource,
  reactivateSubscriptionResource
} from "../controllers/TenantSubscriptionController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// Enterprise Subscription Platform — File 0's own literal
// `POST/GET /api/v1/subscriptions`, `POST /api/v1/subscriptions/{id}/renew`
// `/suspend` `/reactivate` endpoint contract, mounted at its own real
// base path (server.js: app.use("/api/v1/subscriptions", ...)),
// deliberately separate from the self-service `/api/v1/platform/subscription`
// routes in SubscriptionPlatformRoutes.js — both are real, both stay
// working, they serve two different real call shapes (implicit-own-tenant
// vs addressed-by-id) over the exact same underlying service, never a
// duplicated implementation. See TenantSubscriptionController.js's own
// "Cross-tenant access" doc comment for why every handler here still
// resolves and verifies tenant ownership from `getAccessScope(req)` —
// never from a request-supplied tenantId — despite the id-addressed shape.
router.use(authenticateAccessToken);

router.post("/", limiter, idempotency(), validate(platformSchemas.createSubscription), createSubscriptionResource);
router.get("/", limiter, listSubscriptionsResource);
router.post("/:subscriptionId/renew", limiter, idempotency(), renewSubscriptionResource);
router.post("/:subscriptionId/suspend", limiter, validate(platformSchemas.adminSuspend), suspendSubscriptionResource);
router.post("/:subscriptionId/reactivate", limiter, reactivateSubscriptionResource);

export default router;
