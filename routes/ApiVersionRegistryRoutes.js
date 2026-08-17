import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { createApiVersionRegistration, listApiVersionRegistrations, getApiVersionRegistration, deprecateApiVersionRegistration, sunsetApiVersionRegistration, retireApiVersionRegistration } from "../controllers/ApiVersionRegistryController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// Enterprise API Version Strategy Standard (Improvement 8). "Maintain a
// central registry" of every API's version lifecycle.
router.use(authenticateAccessToken);

router.post("/", limiter, createApiVersionRegistration);
router.get("/", limiter, listApiVersionRegistrations);
router.get("/:apiName/:version", limiter, getApiVersionRegistration);
router.post("/:apiName/:version/deprecate", limiter, deprecateApiVersionRegistration);
router.post("/:apiName/:version/sunset", limiter, sunsetApiVersionRegistration);
router.post("/:apiName/:version/retire", limiter, retireApiVersionRegistration);

export default router;
