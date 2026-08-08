import express from "express";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { roleSchemas } from "../middleware/validateRequest.js";
import rateLimit from "express-rate-limit";
import {
  ListPermissions,
  ListRoles,
  GetRole,
  CreateRole,
  UpdateRole,
  DeleteRole
} from "../controllers/RoleController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken);

// Fixed-segment route must be registered before the "/:roleId" wildcard.
router.get("/permissions", limiter, ListPermissions);

router.get("/", limiter, ListRoles);
router.post("/", limiter, validate(roleSchemas.createRole), CreateRole);
router.get("/:roleId", limiter, GetRole);
router.patch("/:roleId", limiter, validate(roleSchemas.updateRole), UpdateRole);
router.delete("/:roleId", limiter, DeleteRole);

export default router;
