import bcrypt from "bcryptjs";
import crypto from "crypto";
import mongoose from "mongoose";
import UserModel from "../models/Usermodel.js";
import EmployeeProfileModel from "../models/EmployeeProfilemodel.js";
import InvitationModel from "../models/Invitationmodel.js";
import EmploymentHistoryModel from "../models/EmploymentHistorymodel.js";
import RoleModel from "../models/Rolemodel.js";
import BranchModel from "../models/Branchmodel.js";
import DepartmentModel from "../models/Departmentmodel.js";
import PermissionModel from "../models/Permissionmodel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId, getAccessTokenExpiresInSeconds } from "../utils/authTokens.js";
import { getAuthConfig } from "../utils/authConfig.js";
import { validatePassword, recordPasswordHistory } from "../utils/passwordPolicy.js";
import { getRequestMeta, createSessionAndTokens } from "./Auth.js";
import CacheManager from "../utils/cacheManager.js";
import logger from "../utils/logger.js";

const authConfig = getAuthConfig();

let transporter = null;
try {
  const nodemailer = await import("nodemailer");
  transporter = nodemailer.default.createTransport({
    host: authConfig.smtpHost,
    port: authConfig.smtpPort,
    secure: authConfig.smtpSecure,
    auth: {
      user: authConfig.smtpUser,
      pass: authConfig.smtpPass,
    },
  });
  transporter.verify((err) => {
    if (err) logger.warn("SMTP transport not available", { error: err.message });
    else logger.info("SMTP transport ready");
  });
} catch (err) {
  logger.warn("Nodemailer unavailable, emails disabled", { error: err.message });
}

const buildEmailTemplate = (title, bodyLines, ctaLink, ctaText) => {
  const lines = bodyLines.map((line) => `<p style="margin:0 0 10px;color:#555;font-size:15px;line-height:1.6;">${line}</p>`).join("");
  const appLogo = process.env.APP_LOGO_URL || "";
  const logoHtml = appLogo ? `<img src="${appLogo}" alt="${authConfig.appName}" style="max-width:150px;margin-bottom:20px;">` : `<h1 style="color:#1a73e8;margin:0 0 10px;font-size:22px;">${authConfig.appName}</h1>`;
  const ctaHtml = ctaLink ? `<div style="text-align:center;margin:25px 0;"><a href="${ctaLink}" style="display:inline-block;background:#1a73e8;color:#fff;padding:12px 30px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px;">${ctaText || "Proceed"}</a></div>` : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${authConfig.appName}</title></head><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;"><div style="max-width:600px;margin:30px auto;background:#fff;border-radius:8px;padding:30px;box-shadow:0 2px 8px rgba(0,0,0,0.08);"><div style="text-align:center;margin-bottom:20px;">${logoHtml}</div><div>${lines}</div>${ctaHtml}<hr style="border:none;border-top:1px solid #eee;margin:25px 0;"><p style="font-size:12px;color:#888;text-align:center;">&copy; ${new Date().getFullYear()} ${authConfig.appName}. All rights reserved.</p></div></body></html>`;
};

const sendEmail = async ({ to, subject, html }) => {
  if (!transporter) {
    logger.warn("Email not sent: transporter unavailable", { to, subject });
    return;
  }
  try {
    await transporter.sendMail({ from: authConfig.emailFrom, to, subject: `${subject} - ${authConfig.appName}`, html });
  } catch (err) {
    logger.error("Email send failed", { error: err.message, to, subject });
  }
};

const sendInvitationEmail = async (email, token, firstName) => {
  const inviteUrl = `${authConfig.frontendUrl}/accept-invitation?token=${token}`;
  await sendEmail({
    to: email,
    subject: "You're invited to join",
    html: buildEmailTemplate("You're invited!", [
      `Hi ${firstName || "there"},`,
      "You have been invited to join the team. Click the button below to accept your invitation and set up your account.",
      `This invitation expires in ${authConfig.invitationExpiryDays} day${authConfig.invitationExpiryDays > 1 ? "s" : ""}.`,
    ], inviteUrl, "Accept Invitation"),
  });
};

const findUserAndProfile = async (userId, tenantId) => {
  let profile = null;
  let user = null;

  if (mongoose.Types.ObjectId.isValid(userId)) {
    profile = await EmployeeProfileModel.findOne({ _id: userId, tenantId, status: { $ne: "archived" } });
    if (!profile) {
      profile = await EmployeeProfileModel.findOne({ identityId: userId, tenantId, status: { $ne: "archived" } });
    }
  }

  if (profile?.identityId) {
    user = await UserModel.findOne({ _id: profile.identityId, tenantId, status: { $ne: "deleted" } });
  } else if (mongoose.Types.ObjectId.isValid(userId)) {
    user = await UserModel.findOne({ _id: userId, tenantId, status: { $ne: "deleted" } });
    if (user && !profile) {
      profile = await EmployeeProfileModel.findOne({ email: user.email, tenantId, status: { $ne: "archived" } });
    }
  }

  return { profile, user };
};

const buildEmployeeItem = (profile, user = null, branchObj = null, deptObj = null, roleObj = null) => {
  const id = profile?._id || user?._id;
  const fullName = profile ? `${profile.firstName} ${profile.lastName}`.trim() : (user?.username || "N/A");
  const email = profile?.email || user?.email;
  const branchName = branchObj?.name || profile?.branchId || user?.branchId || "N/A";
  const departmentName = deptObj?.name || "N/A";
  const roleName = roleObj?.name || user?.role || "User";

  let statusFormatted = profile?.status || user?.status || "active";
  if (statusFormatted === "pending_invitation") statusFormatted = "Pending Invitation";
  else if (statusFormatted === "active") statusFormatted = "Active";
  else if (statusFormatted === "suspended") statusFormatted = "Suspended";
  else if (statusFormatted === "inactive") statusFormatted = "Inactive";

  return {
    id,
    employeeCode: profile?.employeeCode || `${authConfig.employeeCodePrefix}-${id.toString().slice(-5).toUpperCase()}`,
    fullName,
    firstName: profile?.firstName || "",
    lastName: profile?.lastName || "",
    email,
    phone: profile?.phone || null,
    branch: branchName,
    branchId: profile?.branchId || user?.branchId,
    department: departmentName,
    departmentId: profile?.departmentId || user?.departmentId || null,
    role: roleName,
    roleIds: profile?.roleIds || [],
    designation: profile?.designation || null,
    status: statusFormatted,
    joiningDate: profile?.joiningDate || null,
    createdAt: profile?.createdAt || user?.createdAt
  };
};

export const ListUsers = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.read") && !permissions.includes("employee.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || authConfig.defaultPageSize, 10), 1), authConfig.maxPageSize);
    const search = req.query.search?.trim() || null;
    const branchId = req.query.branchId || null;
    const departmentId = req.query.departmentId || null;
    const roleId = req.query.roleId || req.query.role || null;
    const status = req.query.status || null;
    const sortField = req.query.sort || "createdAt";
    const order = req.query.order === "asc" ? 1 : -1;

    const filter = { tenantId, status: { $ne: "archived" } };
    if (branchId) filter.branchId = branchId;
    if (departmentId) filter.departmentId = departmentId;
    if (status) {
      // Archived (soft-deleted) users are never listable, even via an
      // explicit filter — Rule 2 / "Must NOT return deleted users" is absolute.
      const statusMap = {
        "active": "active", "suspended": "suspended", "inactive": "inactive",
        "pending invitation": "pending_invitation", "pending_invitation": "pending_invitation",
      };
      const mapped = statusMap[status.trim().toLowerCase()];
      if (!mapped) {
        return sendError(res, 422, `Invalid status filter "${status}". Allowed: active, suspended, inactive, pending invitation.`, requestId);
      }
      filter.status = mapped;
    }
    if (roleId && mongoose.Types.ObjectId.isValid(roleId)) {
      filter.roleIds = roleId;
    }

    if (search) {
      filter.$or = [
        { firstName: new RegExp(search, "i") },
        { lastName: new RegExp(search, "i") },
        { email: new RegExp(search, "i") },
        { phone: new RegExp(search, "i") },
        { employeeCode: new RegExp(search, "i") }
      ];
    }

    let sortOption = { [sortField]: order };
    if (sortField === "name" || sortField === "fullName") {
      sortOption = { firstName: order, lastName: order };
    }

    const totalItems = await EmployeeProfileModel.countDocuments(filter);
    const profiles = await EmployeeProfileModel.find(filter)
      .populate("departmentId")
      .populate("roleIds")
      .populate("identityId")
      .sort(sortOption)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    const branches = await BranchModel.find({ tenantKey: tenantId }).lean();
    const branchMap = new Map(branches.map((b) => [b.branchKey, b]));

    const data = profiles.map((p) => {
      const u = p.identityId && typeof p.identityId === "object" ? p.identityId : null;
      const dept = p.departmentId && typeof p.departmentId === "object" ? p.departmentId : null;
      const roleObj = Array.isArray(p.roleIds) && p.roleIds.length > 0 && typeof p.roleIds[0] === "object" ? p.roleIds[0] : null;
      const branchObj = branchMap.get(p.branchId) || null;
      return buildEmployeeItem(p, u, branchObj, dept, roleObj);
    });

    return res.status(200).json({
      success: true,
      message: "Users loaded.",
      data,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      },
      requestId
    });
  } catch (error) {
    console.error("ListUsers error:", error);
    return sendError(res, 500, "Unable to load users.", requestId);
  }
};

export const CreateUser = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.create") && !permissions.includes("employee.create")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const {
      firstName,
      lastName,
      email,
      phone,
      branchId,
      departmentId,
      roleIds = [],
      role,
      designation,
      joiningDate
    } = req.body;

    // departmentId is required: every employee belongs to Exactly One
    // Department (Part 1, Organization Hierarchy) — EmployeeProfileModel's
    // schema already enforces this, but validating it here turns a would-be
    // 500 (Mongoose ValidationError) into a clean 422.
    if (!firstName || !lastName || !email || !branchId || !departmentId) {
      return sendError(res, 422, "firstName, lastName, email, branchId, and departmentId are required.", requestId);
    }

    const branch = await BranchModel.findOne({ branchKey: branchId, tenantKey: tenantId, status: "active" });
    if (!branch) {
      return sendError(res, 422, "Branch not found or inactive.", requestId);
    }

    const department = await DepartmentModel.findOne({ _id: departmentId, tenantId, status: "active" });
    if (!department) {
      return sendError(res, 422, "Department not found or inactive.", requestId);
    }

    let resolvedRoleIds = [];

    if (Array.isArray(roleIds) && roleIds.length > 0) {
      const validObjectIds = roleIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
      const foundRoles = await RoleModel.find({ _id: { $in: validObjectIds }, status: "active" });
      if (foundRoles.length !== roleIds.length) {
        return sendError(res, 422, "One or more roles do not exist or are inactive.", requestId);
      }
      resolvedRoleIds = foundRoles.map((r) => r._id);
    } else if (role) {
      const rObj = await RoleModel.findOne({ name: role, status: "active" });
      if (rObj) resolvedRoleIds = [rObj._id];
    }

    // Every employee has One or More Roles (Part 1, Organization Hierarchy).
    if (resolvedRoleIds.length === 0) {
      return sendError(res, 422, "At least one valid role is required.", requestId);
    }

    const existingUser = await UserModel.findOne({ tenantId, email });
    const existingProfile = await EmployeeProfileModel.findOne({ tenantId, email });
    if (existingUser || existingProfile) {
      return sendError(res, 409, "User with this email already exists within the tenant.", requestId);
    }

    const randomSuffix = Math.floor(10000 + Math.random() * 90000);
    const employeeCode = `${authConfig.employeeCodePrefix}-${randomSuffix}`;

    // No password/identity credentials are created here — this endpoint
    // only provisions the employee profile. The real Identity/credentials
    // record (UserModel) is created later, by the employee themselves,
    // when they accept their invitation (see AcceptUserInvitation). The
    // account cannot log in until then.
    const profile = await EmployeeProfileModel.create({
      identityId: null,
      tenantId,
      branchId,
      departmentId: department._id,
      roleIds: resolvedRoleIds,
      employeeCode,
      firstName,
      lastName,
      email,
      phone: phone || "N/A",
      designation: designation || null,
      joiningDate: joiningDate ? new Date(joiningDate) : new Date(),
      status: "pending_invitation"
    });

    await EmploymentHistoryModel.create({
      employeeId: profile._id,
      tenantId,
      branchId,
      departmentId: department._id,
      roleIds: resolvedRoleIds,
      changeType: "joined",
      fromDate: new Date(),
      notes: "Employee created"
    });

    const invitationToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + authConfig.invitationExpiryDays * 24 * 60 * 60 * 1000);

    await InvitationModel.create({
      employeeId: profile._id,
      email,
      token: invitationToken,
      status: "pending",
      expiresAt,
      sentAt: new Date()
    });

    await sendInvitationEmail(email, invitationToken, firstName);
    publishEvent("UserCreated", { employeeId: profile._id.toString(), tenantId, branchId });
    publishEvent("IdentityCreated", { employeeId: profile._id.toString(), email, tenantId, identityPending: true });
    publishEvent("InvitationQueued", { employeeId: profile._id.toString(), email, token: invitationToken });
    publishEvent("NotificationRequested", { type: "invitation_email", email });

    await AuditLogModel.create({
      action: "user.create",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId,
      requestId,
      metadata: { profileId: profile._id, employeeCode }
    });

    return sendSuccess(res, 201, "User created successfully.", {
      userId: profile._id,
      employeeCode: profile.employeeCode,
      status: "Pending Invitation"
    }, requestId);
  } catch (error) {
    console.error("CreateUser error:", error);
    return sendError(res, 500, "Unable to create user.", requestId);
  }
};

export const GetUser = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.read") && !permissions.includes("employee.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { profile, user } = await findUserAndProfile(userId, tenantId);

    if (!profile && !user) {
      return sendError(res, 404, "User not found.", requestId);
    }

    const [department, roleRecords, branchObj] = await Promise.all([
      profile?.departmentId ? DepartmentModel.findById(profile.departmentId).lean() : null,
      profile?.roleIds?.length > 0 ? RoleModel.find({ _id: { $in: profile.roleIds }, status: "active" }).lean() : [],
      profile?.branchId ? BranchModel.findOne({ branchKey: profile.branchId, tenantKey: tenantId }).lean() : null,
    ]);

    const rolePermissions = [...new Set(roleRecords.flatMap((r) => r.permissions || []))];
    const overrides = profile?.permissionOverrides || { grant: [], revoke: [] };
    const effectiveSet = new Set(rolePermissions);
    (overrides.grant || []).forEach((p) => effectiveSet.add(p));
    (overrides.revoke || []).forEach((p) => effectiveSet.delete(p));

    const responseData = {
      id: profile?._id || user?._id,
      identityId: user?._id || profile?.identityId || null,
      employeeCode: profile?.employeeCode || null,
      fullName: profile ? `${profile.firstName} ${profile.lastName}`.trim() : (user?.username || "N/A"),
      firstName: profile?.firstName || "",
      lastName: profile?.lastName || "",
      username: user?.username || profile?.email?.split("@")[0],
      email: profile?.email || user?.email,
      phone: profile?.phone || null,
      designation: profile?.designation || null,
      emergencyContact: profile?.emergencyContact || null,
      address: profile?.address || null,
      profilePicture: profile?.profilePicture || null,
      preferredLanguage: profile?.preferredLanguage || "en",
      timezone: profile?.timezone || "UTC",
      notes: profile?.notes || null,
      joiningDate: profile?.joiningDate || null,
      status: profile?.status === "pending_invitation" ? "Pending Invitation" : (profile?.status || user?.status),
      tenantId: profile?.tenantId || user?.tenantId,
      branchId: profile?.branchId || user?.branchId,
      branch: branchObj?.name || profile?.branchId || user?.branchId,
      departmentId: profile?.departmentId || null,
      department: department?.name || null,
      role: roleRecords[0]?.name || user?.role || "User",
      roles: roleRecords.map((r) => ({ id: r._id, name: r.name })),
      permissions: Array.from(effectiveSet),
      permissionOverrides: overrides,
      preferences: profile?.preferences || {
        language: "en",
        timezone: "UTC",
        theme: "light",
        dashboardLayout: "default",
        notificationPreferences: {},
        dateFormat: "YYYY-MM-DD",
        currencyFormat: "USD"
      },
      createdAt: profile?.createdAt || user?.createdAt,
      updatedAt: profile?.updatedAt || user?.updatedAt
    };

    return sendSuccess(res, 200, "User loaded.", responseData, requestId);
  } catch (error) {
    console.error("GetUser error:", error);
    return sendError(res, 500, "Unable to load user.", requestId);
  }
};

export const UpdateUser = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.update") && !permissions.includes("employee.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { profile, user } = await findUserAndProfile(userId, tenantId);

    if (!profile && !user) {
      return sendError(res, 404, "User not found.", requestId);
    }

    const {
      firstName,
      lastName,
      phone,
      designation,
      emergencyContact,
      address,
      preferredLanguage,
      profilePicture,
      timezone,
      notes
    } = req.body;

    // Timezone/language are validated dynamically against Node's built-in
    // ICU data (real IANA tz list / real BCP-47 tag parsing) — no hardcoded
    // allow-list to maintain.
    if (timezone !== undefined && !Intl.supportedValuesOf("timeZone").includes(timezone)) {
      return sendError(res, 422, `Invalid timezone "${timezone}".`, requestId);
    }
    if (preferredLanguage !== undefined) {
      try {
        Intl.getCanonicalLocales([preferredLanguage]);
      } catch {
        return sendError(res, 422, `Invalid language "${preferredLanguage}".`, requestId);
      }
    }
    if (phone !== undefined && phone && profile) {
      const phoneOwner = await EmployeeProfileModel.findOne({
        tenantId, phone, status: { $ne: "archived" }, _id: { $ne: profile._id },
      }).lean();
      if (phoneOwner) {
        return sendError(res, 422, "Phone number is already in use by another employee.", requestId);
      }
    }

    if (profile) {
      if (firstName !== undefined) profile.firstName = firstName;
      if (lastName !== undefined) profile.lastName = lastName;
      if (phone !== undefined) profile.phone = phone;
      if (designation !== undefined) profile.designation = designation;
      if (emergencyContact !== undefined) profile.emergencyContact = emergencyContact;
      if (address !== undefined) profile.address = address;
      if (preferredLanguage !== undefined) profile.preferredLanguage = preferredLanguage;
      if (profilePicture !== undefined) profile.profilePicture = profilePicture;
      if (timezone !== undefined) profile.timezone = timezone;
      if (notes !== undefined) profile.notes = notes;
      await profile.save();
    }

    await AuditLogModel.create({
      action: "user.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: profile?.branchId || user?.branchId || null,
      requestId,
      metadata: { userId: user?._id, profileId: profile?._id }
    });

    publishEvent("UserUpdated", { userId: (user?._id || profile?._id).toString(), tenantId });
    publishEvent("ProfileUpdated", { userId: (user?._id || profile?._id).toString(), tenantId });

    return sendSuccess(res, 200, "User updated successfully.", { userId: profile?._id || user?._id }, requestId);
  } catch (error) {
    console.error("UpdateUser error:", error);
    return sendError(res, 500, "Unable to update user.", requestId);
  }
};

export const DeleteUser = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.delete") && !permissions.includes("employee.delete")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { profile, user } = await findUserAndProfile(userId, tenantId);

    if (!profile && !user) {
      return sendError(res, 404, "User not found.", requestId);
    }

    if (user) {
      user.status = "deleted";
      await user.save();
    }

    if (profile) {
      profile.status = "archived";
      await profile.save();

      await EmploymentHistoryModel.create({
        employeeId: profile._id,
        tenantId,
        branchId: profile.branchId,
        departmentId: profile.departmentId,
        roleIds: profile.roleIds,
        changeType: "archived",
        fromDate: new Date(),
        notes: "Employee account archived (soft delete)"
      });
    }

    await AuditLogModel.create({
      action: "user.delete",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: profile?.branchId || user?.branchId || null,
      requestId,
      metadata: { userId: user?._id, profileId: profile?._id }
    });

    publishEvent("UserArchived", { userId: (user?._id || profile?._id).toString(), tenantId });

    return sendSuccess(res, 200, "User archived successfully.", null, requestId);
  } catch (error) {
    console.error("DeleteUser error:", error);
    return sendError(res, 500, "Unable to delete user.", requestId);
  }
};

export const ArchiveUser = async (req, res) => {
  return DeleteUser(req, res);
};

export const UpdateUserRole = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.update") && !permissions.includes("employee.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { role, roleIds } = req.body;

    let targetRoleIds = [];
    let primaryRoleName = "User";

    if (Array.isArray(roleIds) && roleIds.length > 0) {
      const uniqueIds = [...new Set(roleIds)];
      const validObjectIds = uniqueIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
      const foundRoles = await RoleModel.find({ _id: { $in: validObjectIds }, status: "active" });
      if (foundRoles.length !== uniqueIds.length) {
        return sendError(res, 422, "One or more roles do not exist or are inactive.", requestId);
      }
      targetRoleIds = foundRoles.map((r) => r._id);
      primaryRoleName = foundRoles[0]?.name || primaryRoleName;
    } else if (role) {
      const rObj = await RoleModel.findOne({ name: role, status: "active" });
      if (rObj) {
        targetRoleIds = [rObj._id];
        primaryRoleName = rObj.name;
      }
    }

    if (targetRoleIds.length === 0) {
      return sendError(res, 422, "Valid role or roleIds required.", requestId);
    }

    const { profile, user } = await findUserAndProfile(userId, tenantId);
    if (!profile && !user) {
      return sendError(res, 404, "User not found.", requestId);
    }

    if (user) {
      user.role = primaryRoleName;
      await user.save();
    }

    if (profile) {
      profile.roleIds = targetRoleIds;
      await profile.save();

      await EmploymentHistoryModel.create({
        employeeId: profile._id,
        tenantId,
        branchId: profile.branchId,
        departmentId: profile.departmentId,
        roleIds: targetRoleIds,
        changeType: "role_changed",
        fromDate: new Date(),
        notes: `Roles assigned: ${primaryRoleName}`
      });
    }

    await AuditLogModel.create({
      action: "user.role.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: profile?.branchId || user?.branchId || null,
      requestId,
      metadata: { userId: user?._id, profileId: profile?._id, role: primaryRoleName, roleIds: targetRoleIds }
    });

    publishEvent("RolesAssigned", { userId: (user?._id || profile?._id).toString(), tenantId, roleIds: targetRoleIds });
    publishEvent("PermissionsRecalculated", { userId: (user?._id || profile?._id).toString(), tenantId });

    return sendSuccess(res, 200, "User roles updated successfully.", { userId, role: primaryRoleName, roleIds: targetRoleIds }, requestId);
  } catch (error) {
    console.error("UpdateUserRole error:", error);
    return sendError(res, 500, "Unable to update user role.", requestId);
  }
};

export const UpdateUserBranch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.update") && !permissions.includes("employee.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { branchId } = req.body;

    if (!branchId) {
      return sendError(res, 422, "Branch ID is required.", requestId);
    }

    const branch = await BranchModel.findOne({ branchKey: branchId, tenantKey: tenantId, status: "active" });
    if (!branch) {
      return sendError(res, 422, "Branch not found or inactive.", requestId);
    }

    const { profile, user } = await findUserAndProfile(userId, tenantId);
    if (!profile && !user) {
      return sendError(res, 404, "User not found.", requestId);
    }

    const previousBranchId = profile?.branchId || user?.branchId || null;

    if (user) {
      user.branchId = branchId;
      await user.save();
    }

    if (profile) {
      profile.branchId = branchId;
      await profile.save();

      await EmploymentHistoryModel.create({
        employeeId: profile._id,
        tenantId,
        branchId,
        departmentId: profile.departmentId,
        roleIds: profile.roleIds,
        changeType: "transferred",
        fromDate: new Date(),
        notes: `Transferred from branch ${previousBranchId || "N/A"} to ${branchId}`
      });
    }

    await AuditLogModel.create({
      action: "user.branch.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId,
      requestId,
      metadata: { userId: user?._id, profileId: profile?._id, branchId }
    });

    publishEvent("UserBranchTransferred", { userId: (user?._id || profile?._id).toString(), tenantId, branchId });
    publishEvent("BranchTransferred", { userId: (user?._id || profile?._id).toString(), tenantId, branchId });

    return sendSuccess(res, 200, "User branch transferred.", { userId, branchId }, requestId);
  } catch (error) {
    console.error("UpdateUserBranch error:", error);
    return sendError(res, 500, "Unable to update user branch.", requestId);
  }
};

export const UpdateUserDepartment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.update") && !permissions.includes("employee.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { departmentId } = req.body;

    if (!departmentId) {
      return sendError(res, 422, "Department ID is required.", requestId);
    }

    const department = await DepartmentModel.findOne({ _id: departmentId, tenantId, status: "active" });
    if (!department) {
      return sendError(res, 422, "Department not found or inactive.", requestId);
    }

    const { profile, user } = await findUserAndProfile(userId, tenantId);
    if (!profile && !user) {
      return sendError(res, 404, "User not found.", requestId);
    }

    if (profile) {
      const previousDepartment = profile.departmentId
        ? await DepartmentModel.findById(profile.departmentId).lean()
        : null;

      profile.departmentId = departmentId;
      await profile.save();

      await EmploymentHistoryModel.create({
        employeeId: profile._id,
        tenantId,
        branchId: profile.branchId,
        departmentId,
        roleIds: profile.roleIds,
        changeType: "department_changed",
        fromDate: new Date(),
        notes: `Department changed from ${previousDepartment?.name || "N/A"} to ${department.name}`
      });
    }

    await AuditLogModel.create({
      action: "user.department.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: profile?.branchId || user?.branchId || null,
      requestId,
      metadata: { userId: user?._id, profileId: profile?._id, departmentId }
    });

    publishEvent("DepartmentChanged", { userId: (user?._id || profile?._id).toString(), tenantId, departmentId });

    return sendSuccess(res, 200, "User department updated.", { userId, departmentId }, requestId);
  } catch (error) {
    console.error("UpdateUserDepartment error:", error);
    return sendError(res, 500, "Unable to update user department.", requestId);
  }
};

export const UpdateUserStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.update") && !permissions.includes("employee.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { status, reason } = req.body;

    if (!status) {
      return sendError(res, 422, "Status is required.", requestId);
    }

    const inputStatus = status.trim().toLowerCase();
    const statusMap = {
      "active": "active",
      "suspended": "suspended",
      "inactive": "inactive",
      "archived": "archived",
      "pending invitation": "pending_invitation",
      "pending_invitation": "pending_invitation"
    };
    const dbStatus = statusMap[inputStatus];
    if (!dbStatus) {
      return sendError(res, 422, `Invalid status "${status.trim()}". Allowed: active, suspended, inactive, archived, pending invitation.`, requestId);
    }

    const { profile, user } = await findUserAndProfile(userId, tenantId);
    if (!profile && !user) {
      return sendError(res, 404, "User not found.", requestId);
    }

    const oldStatus = profile?.status || user?.status || "unknown";

    if (oldStatus === "archived" && dbStatus === "active") {
      return sendError(res, 422, "Archived users cannot become Active directly.", requestId);
    }

    if (dbStatus === "pending_invitation" && oldStatus !== "pending_invitation") {
      return sendError(res, 422, "Users cannot be moved back to Pending Invitation once active.", requestId);
    }

    if (user) {
      user.status = dbStatus === "archived" ? "deleted" : dbStatus;
      await user.save();
    }

    if (profile) {
      profile.status = dbStatus;
      await profile.save();

      let changeType = "reactivated";
      if (dbStatus === "suspended") changeType = "suspended";
      else if (dbStatus === "archived") changeType = "archived";

      await EmploymentHistoryModel.create({
        employeeId: profile._id,
        tenantId,
        branchId: profile.branchId,
        departmentId: profile.departmentId,
        roleIds: profile.roleIds,
        changeType,
        fromDate: new Date(),
        notes: reason || `Status changed from ${oldStatus} to ${dbStatus}`
      });
    }

    await AuditLogModel.create({
      action: "user.status.update",
      outcome: "success",
      reason: reason || null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: profile?.branchId || user?.branchId || null,
      requestId,
      metadata: { userId: user?._id, profileId: profile?._id, oldStatus, newStatus: dbStatus, reason }
    });

    if (dbStatus === "active") publishEvent("UserActivated", { userId: (user?._id || profile?._id).toString(), tenantId });
    else if (dbStatus === "suspended") publishEvent("UserSuspended", { userId: (user?._id || profile?._id).toString(), tenantId });
    else if (dbStatus === "archived") publishEvent("UserArchived", { userId: (user?._id || profile?._id).toString(), tenantId });
    else publishEvent("UserReactivated", { userId: (user?._id || profile?._id).toString(), tenantId });

    return sendSuccess(res, 200, "User status updated.", { userId, oldStatus, newStatus: dbStatus, reason }, requestId);
  } catch (error) {
    console.error("UpdateUserStatus error:", error);
    return sendError(res, 500, "Unable to update user status.", requestId);
  }
};

export const GetUserPermissions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.read") && !permissions.includes("employee.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { profile, user } = await findUserAndProfile(userId, tenantId);

    if (!profile && !user) {
      return sendError(res, 404, "User not found.", requestId);
    }

    let rolePermissions = [];
    if (profile?.roleIds?.length > 0) {
      const roleRecords = await RoleModel.find({ _id: { $in: profile.roleIds }, status: "active" });
      rolePermissions = [...new Set(roleRecords.flatMap((r) => r.permissions || []))];
    } else if (user?.role) {
      const roleRecord = await RoleModel.findOne({ name: user.role, status: "active" });
      rolePermissions = roleRecord?.permissions || [];
    }

    const overrides = profile?.permissionOverrides || { grant: [], revoke: [] };
    const granted = overrides.grant || [];
    const revoked = overrides.revoke || [];

    const effectiveSet = new Set(rolePermissions);
    granted.forEach((p) => effectiveSet.add(p));
    revoked.forEach((p) => effectiveSet.delete(p));

    return sendSuccess(res, 200, "User permissions loaded.", {
      permissions: Array.from(effectiveSet)
    }, requestId);
  } catch (error) {
    console.error("GetUserPermissions error:", error);
    return sendError(res, 500, "Unable to load permissions.", requestId);
  }
};

export const UpdateUserPermissions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.update") && !permissions.includes("employee.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { grant = [], revoke = [] } = req.body;

    if (!Array.isArray(grant) || !Array.isArray(revoke)) {
      return sendError(res, 422, "Grant and revoke must be arrays.", requestId);
    }

    const requestedKeys = [...new Set([...grant, ...revoke])];
    if (requestedKeys.length > 0) {
      const validPermissions = await PermissionModel.find({ key: { $in: requestedKeys }, status: "active" });
      if (validPermissions.length !== requestedKeys.length) {
        return sendError(res, 422, "One or more permission keys do not exist or are inactive.", requestId);
      }
    }

    const { profile, user } = await findUserAndProfile(userId, tenantId);

    if (!profile && !user) {
      return sendError(res, 404, "User not found.", requestId);
    }

    const existingOverrides = profile?.permissionOverrides || user?.permissionOverrides || { grant: [], revoke: [] };
    const mergedGrant = Array.from(new Set([...(existingOverrides.grant || []), ...grant]));
    const mergedRevoke = Array.from(new Set([...(existingOverrides.revoke || []), ...revoke]));

    const finalGrant = grant.length === 0 ? (existingOverrides.grant || []) : mergedGrant;
    const finalRevoke = revoke.length === 0 ? (existingOverrides.revoke || []) : mergedRevoke;

    if (profile) {
      profile.permissionOverrides = { grant: finalGrant, revoke: finalRevoke };
      await profile.save();
    }

    await AuditLogModel.create({
      action: "user.permissions.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: profile?.branchId || user?.branchId || null,
      requestId,
      metadata: { userId: user?._id, profileId: profile?._id, grant, revoke }
    });

    publishEvent("PermissionOverridesUpdated", { userId: (user?._id || profile?._id).toString(), tenantId, grant, revoke });

    return sendSuccess(res, 200, "User permission overrides updated.", { userId, grant, revoke }, requestId);
  } catch (error) {
    console.error("UpdateUserPermissions error:", error);
    return sendError(res, 500, "Unable to update permissions.", requestId);
  }
};

export const GetEmploymentHistory = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.read") && !permissions.includes("employee.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { profile } = await findUserAndProfile(userId, tenantId);

    if (!profile) {
      return sendError(res, 404, "Employee profile not found.", requestId);
    }

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || authConfig.defaultPageSize, 10), 1), authConfig.maxPageSize);
    const skip = (page - 1) * pageSize;

    const [history, totalItems] = await Promise.all([
      EmploymentHistoryModel.find({ employeeId: profile._id, tenantId })
        .populate("departmentId")
        .populate("roleIds")
        .sort({ fromDate: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      EmploymentHistoryModel.countDocuments({ employeeId: profile._id, tenantId })
    ]);

    return sendSuccess(res, 200, "Employment history loaded.", {
      history,
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize)
    }, requestId);
  } catch (error) {
    console.error("GetEmploymentHistory error:", error);
    return sendError(res, 500, "Unable to load employment history.", requestId);
  }
};

export const GetUserPreferences = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.read") && !permissions.includes("employee.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { profile } = await findUserAndProfile(userId, tenantId);

    if (!profile) {
      return sendError(res, 404, "User profile not found.", requestId);
    }

    const defaultPrefs = {
      language: authConfig.defaultLanguage,
      timezone: authConfig.defaultTimezone,
      theme: authConfig.defaultTheme,
      dashboardLayout: "default",
      notificationPreferences: {},
      dateFormat: authConfig.defaultDateFormat,
      currencyFormat: authConfig.defaultCurrencyFormat
    };

    return sendSuccess(res, 200, "User preferences loaded.", profile.preferences || defaultPrefs, requestId);
  } catch (error) {
    console.error("GetUserPreferences error:", error);
    return sendError(res, 500, "Unable to load preferences.", requestId);
  }
};

export const UpdateUserPreferences = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.update") && !permissions.includes("employee.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { profile } = await findUserAndProfile(userId, tenantId);

    if (!profile) {
      return sendError(res, 404, "User profile not found.", requestId);
    }

    if (req.body.timezone !== undefined && !Intl.supportedValuesOf("timeZone").includes(req.body.timezone)) {
      return sendError(res, 422, `Invalid timezone "${req.body.timezone}".`, requestId);
    }
    if (req.body.language !== undefined) {
      try {
        Intl.getCanonicalLocales([req.body.language]);
      } catch {
        return sendError(res, 422, `Invalid language "${req.body.language}".`, requestId);
      }
    }

    const currentPrefs = profile.preferences || {};
    const allowedKeys = ["language", "timezone", "theme", "dashboardLayout", "notificationPreferences", "dateFormat", "currencyFormat"];

    allowedKeys.forEach((key) => {
      if (req.body[key] !== undefined) {
        currentPrefs[key] = req.body[key];
      }
    });

    profile.preferences = currentPrefs;
    if (req.body.language) profile.preferredLanguage = req.body.language;
    if (req.body.timezone) profile.timezone = req.body.timezone;
    await profile.save();

    await AuditLogModel.create({
      action: "user.preferences.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: profile.branchId || null,
      requestId,
      metadata: { userId: profile.identityId?.toString(), profileId: profile._id.toString(), updatedKeys: Object.keys(req.body).filter(k => allowedKeys.includes(k)) }
    });

    publishEvent("UserPreferencesUpdated", { userId: profile.identityId?.toString() || userId, tenantId, preferences: currentPrefs });

    return sendSuccess(res, 200, "User preferences updated.", profile.preferences, requestId);
  } catch (error) {
    console.error("UpdateUserPreferences error:", error);
    return sendError(res, 500, "Unable to update preferences.", requestId);
  }
};

export const InviteUser = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.create") && !permissions.includes("employee.create")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const {
      email,
      firstName,
      lastName,
      phone,
      role = "User",
      branchId,
      departmentId,
      designation
    } = req.body;

    if (!email || !firstName || !lastName || !branchId || !departmentId) {
      return sendError(res, 422, "Email, firstName, lastName, branchId, and departmentId are required.", requestId);
    }

    const branch = await BranchModel.findOne({ branchKey: branchId, tenantKey: tenantId, status: "active" });
    if (!branch) {
      return sendError(res, 422, "Branch not found or inactive.", requestId);
    }

    const department = await DepartmentModel.findOne({ _id: departmentId, tenantId, status: "active" });
    if (!department) {
      return sendError(res, 422, "Department not found or inactive.", requestId);
    }

    const existingUser = await UserModel.findOne({ tenantId, email });
    const existingProfile = await EmployeeProfileModel.findOne({ tenantId, email });

    if (existingUser || (existingProfile && existingProfile.status !== "pending_invitation")) {
      return sendError(res, 409, "User with this email already exists in the organization.", requestId);
    }

    const roleRecord = await RoleModel.findOne({ name: role, status: "active" });
    if (!roleRecord) {
      return sendError(res, 422, `Role "${role}" does not exist or is inactive.`, requestId);
    }

    let profile = existingProfile;
    if (!profile) {
      const employeeCode = `${authConfig.employeeCodePrefix}-${Math.floor(10000 + Math.random() * 90000)}`;
      profile = await EmployeeProfileModel.create({
        tenantId,
        branchId,
        departmentId: department._id,
        roleIds: [roleRecord._id],
        employeeCode,
        firstName,
        lastName,
        email,
        phone: phone || "N/A",
        designation: designation || null,
        status: "pending_invitation"
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + authConfig.invitationExpiryDays * 24 * 60 * 60 * 1000);

    await InvitationModel.deleteMany({ employeeId: profile._id, status: "pending" });

    const invitation = await InvitationModel.create({
      employeeId: profile._id,
      email,
      token,
      status: "pending",
      expiresAt,
      sentAt: new Date()
    });

    await sendInvitationEmail(email, token, firstName);

    await AuditLogModel.create({
      action: "user.invite",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId,
      requestId,
      metadata: { profileId: profile._id, invitationId: invitation._id, email }
    });

    publishEvent("InvitationCreated", { employeeId: profile._id.toString(), email, tenantId });
    publishEvent("InvitationQueued", { employeeId: profile._id.toString(), email, token });

    return sendSuccess(res, 201, "Invitation sent successfully.", {
      invitationId: invitation._id,
      employeeId: profile._id,
      email,
      token,
      expiresAt
    }, requestId);
  } catch (error) {
    console.error("InviteUser error:", error);
    return sendError(res, 500, "Unable to send invitation.", requestId);
  }
};

export const ResendUserInvitation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("users.create") && !permissions.includes("employee.create")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { userId } = req.params;
    const { profile } = await findUserAndProfile(userId, tenantId);

    if (!profile) {
      return sendError(res, 404, "Employee profile not found.", requestId);
    }

    if (profile.status !== "pending_invitation") {
      return sendError(res, 400, "User invitation cannot be resent because account is already active.", requestId);
    }

    const cooldownKey = `resend-invitation-cooldown:${profile._id}`;
    const inCooldown = await CacheManager.get(cooldownKey);
    if (inCooldown) {
      return sendError(res, 429, "Invitation was recently resent. Please wait before trying again.", requestId);
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + authConfig.invitationExpiryDays * 24 * 60 * 60 * 1000);

    await InvitationModel.updateMany({ employeeId: profile._id, status: "pending" }, { status: "expired" });

    const invitation = await InvitationModel.create({
      employeeId: profile._id,
      email: profile.email,
      token,
      status: "pending",
      expiresAt,
      sentAt: new Date()
    });

    await sendInvitationEmail(profile.email, token, profile.firstName);
    await CacheManager.set(cooldownKey, true, authConfig.resendInvitationCooldownSeconds);

    await AuditLogModel.create({
      action: "user.invitation.resend",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: profile.branchId,
      requestId,
      metadata: { profileId: profile._id, invitationId: invitation._id }
    });

    publishEvent("InvitationQueued", { employeeId: profile._id.toString(), email: profile.email, token });

    return sendSuccess(res, 200, "Invitation resent successfully.", {
      invitationId: invitation._id,
      employeeId: profile._id,
      email: profile.email,
      token,
      expiresAt
    }, requestId);
  } catch (error) {
    console.error("ResendUserInvitation error:", error);
    return sendError(res, 500, "Unable to resend invitation.", requestId);
  }
};

export const AcceptUserInvitation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { token, username, password } = req.body;

    if (!token || !username || !password) {
      return sendError(res, 422, "Token, username, and password are required.", requestId);
    }

    const invitation = await InvitationModel.findOne({ token, status: "pending" });
    if (!invitation) {
      return sendError(res, 404, "Invalid or expired invitation token.", requestId);
    }

    if (new Date() > invitation.expiresAt) {
      invitation.status = "expired";
      await invitation.save();
      return sendError(res, 410, "Invitation token has expired.", requestId);
    }

    const profile = await EmployeeProfileModel.findById(invitation.employeeId);
    if (!profile) {
      return sendError(res, 404, "Associated employee profile not found.", requestId);
    }

    const usernameExists = await UserModel.findOne({ tenantId: profile.tenantId, username });
    if (usernameExists) {
      return sendError(res, 409, "Username already taken.", requestId);
    }

    let roleName = "User";
    if (profile.roleIds && profile.roleIds.length > 0) {
      const rRecord = await RoleModel.findById(profile.roleIds[0]);
      if (rRecord) roleName = rRecord.name;
    }

    const valErr = validatePassword(password, authConfig);
    if (valErr) return sendError(res, 400, valErr, requestId);

    const hashedPassword = await bcrypt.hash(password, authConfig.bcryptSaltRounds);
    const user = await UserModel.create({
      username,
      email: profile.email,
      password: hashedPassword,
      role: roleName,
      tenantId: profile.tenantId,
      branchId: profile.branchId,
      status: "active",
      emailVerified: true
    });
    await recordPasswordHistory(user._id, hashedPassword, profile.tenantId);

    profile.identityId = user._id;
    profile.status = "active";
    profile.joiningDate = new Date();
    await profile.save();

    invitation.status = "accepted";
    invitation.acceptedAt = new Date();
    await invitation.save();

    await EmploymentHistoryModel.create({
      employeeId: profile._id,
      tenantId: profile.tenantId,
      branchId: profile.branchId,
      departmentId: profile.departmentId,
      roleIds: profile.roleIds,
      changeType: "joined",
      fromDate: new Date(),
      notes: "Accepted invitation and registered account"
    });

    await AuditLogModel.create({
      action: "user.invitation.accept",
      outcome: "success",
      reason: null,
      userId: user._id,
      tenantId: profile.tenantId,
      branchId: profile.branchId,
      requestId,
      metadata: { profileId: profile._id, userId: user._id }
    });

    publishEvent("InvitationAccepted", { userId: user._id.toString(), employeeId: profile._id.toString(), tenantId: profile.tenantId });
    publishEvent("IdentityActivated", { userId: user._id.toString(), tenantId: profile.tenantId });

    // Doc workflow requires "Create Session" as part of acceptance — the
    // employee lands in the app immediately rather than making a separate
    // login call. Reuses Identity's own session/token issuance so this
    // stays byte-for-byte consistent with a normal login (device parsing,
    // geo resolution, SessionCreated event).
    const meta = getRequestMeta(req);
    const { accessToken, refreshToken } = await createSessionAndTokens(user, meta, false);

    return sendSuccess(res, 200, "Invitation accepted and account created successfully.", {
      userId: user._id,
      username: user.username,
      email: user.email,
      status: user.status,
      accessToken,
      refreshToken,
      expiresIn: getAccessTokenExpiresInSeconds()
    }, requestId);
  } catch (error) {
    console.error("AcceptUserInvitation error:", error);
    return sendError(res, 500, "Unable to accept invitation.", requestId);
  }
};
