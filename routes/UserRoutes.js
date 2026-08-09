import express from "express";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { userSchemas } from "../middleware/validateRequest.js";
import rateLimit from "express-rate-limit";
import {
  ListUsers,
  CreateUser,
  GetUser,
  UpdateUser,
  DeleteUser,
  ArchiveUser,
  UpdateUserRole,
  UpdateUserDepartment,
  UpdateUserStatus,
  GetUserPermissions,
  UpdateUserPermissions,
  GetEmploymentHistory,
  GetUserPreferences,
  UpdateUserPreferences,
  InviteUser,
  ResendUserInvitation,
  AcceptUserInvitation
} from "../controllers/UserController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again after 15 minutes.'
});

// Invitation acceptance is public (user setting credentials with valid token)
router.post("/accept-invitation", limiter, validate(userSchemas.acceptInvitation), AcceptUserInvitation);
router.post("/:userId/accept-invitation", limiter, validate(userSchemas.acceptInvitation), AcceptUserInvitation);

// All subsequent routes require valid JWT access token
router.use(authenticateAccessToken);

// Core User / Employee CRUD
router.get("/", limiter, ListUsers);
router.post("/", limiter, validate(userSchemas.createUser), CreateUser);

// User Invitations
router.post("/invite", limiter, validate(userSchemas.inviteUser), InviteUser);
router.post("/:userId/resend-invitation", limiter, ResendUserInvitation);

// Employment History & Preferences
router.get("/:userId/employment-history", limiter, GetEmploymentHistory);
router.get("/:userId/preferences", limiter, GetUserPreferences);
router.patch("/:userId/preferences", limiter, validate(userSchemas.preferences), UpdateUserPreferences);

// Single User Details and Operations
router.get("/:userId", limiter, GetUser);
router.patch("/:userId", limiter, validate(userSchemas.updateUser), UpdateUser);
router.delete("/:userId", limiter, DeleteUser);
router.post("/:userId/archive", limiter, ArchiveUser);

// Organizational Assignments
router.patch("/:userId/role", limiter, validate(userSchemas.roleAssignment), UpdateUserRole);
router.patch("/:userId/roles", limiter, validate(userSchemas.roleAssignment), UpdateUserRole);
router.patch("/:userId/department", limiter, validate(userSchemas.departmentAssignment), UpdateUserDepartment);
router.patch("/:userId/status", limiter, validate(userSchemas.updateStatus), UpdateUserStatus);

// Permission Management
router.get("/:userId/permissions", limiter, GetUserPermissions);
router.patch("/:userId/permissions", limiter, validate(userSchemas.permissions), UpdateUserPermissions);
router.patch("/:userId/permission-overrides", limiter, validate(userSchemas.permissions), UpdateUserPermissions);

export default router;
