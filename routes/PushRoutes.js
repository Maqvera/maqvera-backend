import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { communicationSchemas } from "../middleware/validateRequest.js";
import {
  registerDevice,
  unregisterDevice,
  listDevices,
  sendPushController,
  getPushTrackingStatusController
} from "../controllers/PushController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, message: "Too many requests to the Push Notification Platform APIs." }
});

router.use(authenticateAccessToken);

router.post("/devices", limiter, validate(communicationSchemas.registerDevice), registerDevice);
router.get("/devices", limiter, listDevices);
router.delete("/devices/:token", limiter, unregisterDevice);

router.post("/send", limiter, validate(communicationSchemas.sendPush), sendPushController);
router.get("/:trackingId", limiter, getPushTrackingStatusController);

export default router;
