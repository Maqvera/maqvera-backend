import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { createEventRegistration, listEventRegistrations, getEventRegistration, deprecateEventRegistration, retireEventRegistration, reactivateEventRegistration } from "../controllers/EventRegistryController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// Enterprise Event Versioning Standard (Improvement 7). "Maintain a
// central registry. This prevents duplicate definitions."
router.use(authenticateAccessToken);

router.post("/", limiter, createEventRegistration);
router.get("/", limiter, listEventRegistrations);
router.get("/:eventName/:version", limiter, getEventRegistration);
router.post("/:eventName/:version/deprecate", limiter, deprecateEventRegistration);
router.post("/:eventName/:version/retire", limiter, retireEventRegistration);
router.post("/:eventName/:version/reactivate", limiter, reactivateEventRegistration);

export default router;
