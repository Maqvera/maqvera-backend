import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { tenantProfileSchemas } from "../middleware/validateRequest.js";
import { GetTenantProfile, CreateOrUpdateTenantProfile, UploadTenantProfileLogo, GetTenantSettings, UpdateTenantSettings, GetTenantTheme } from "../controllers/TenantProfileController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// memoryStorage — same pattern as BookingController.js's
// uploadSupplierDocumentFile / ExpenseController.js's uploadReceiptFile.
const uploadLogoFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
}).single("logo");

router.use(authenticateAccessToken);

router.get("/", limiter, GetTenantProfile);
router.post("/", limiter, validate(tenantProfileSchemas.createOrUpdateProfile), CreateOrUpdateTenantProfile);
router.post("/logo", limiter, uploadLogoFile, UploadTenantProfileLogo);
router.get("/theme", limiter, GetTenantTheme);
router.get("/settings", limiter, GetTenantSettings);
router.put("/settings", limiter, validate(tenantProfileSchemas.updateSettings), UpdateTenantSettings);

export default router;
