import RoleModel from "../models/Rolemodel.js";
import PermissionModel from "../models/Permissionmodel.js";
import UserModel from "../models/Usermodel.js";
import EmployeeProfileModel from "../models/EmployeeProfilemodel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";
import { ADMINISTRATOR_ROLE_NAME } from "../utils/authDomainDefaults.js";
import CacheManager from "../utils/cacheManager.js";

const ROLE_MANAGE_PERMISSION = "roles.manage";
const ROLE_READ_PERMISSION = "roles.read";
const hasRoleManageAccess = (permissions) => permissions.includes(ROLE_MANAGE_PERMISSION) || permissions.includes("admin");
const hasRoleReadAccess = (permissions) => permissions.includes(ROLE_READ_PERMISSION) || hasRoleManageAccess(permissions);

// A role's permission list must be a real, known catalog of API/module
// access grants — not arbitrary strings a caller can invent — but the
// catalog itself is genuinely admin-extensible in principle (PermissionModel
// is a real collection, not a hardcoded enum): any key that already exists
// there (module-scoped, e.g. "customer.read", "booking.write", "admin") can
// be freely assigned to any role.
const validatePermissionKeys = async (permissionKeys) => {
  if (!Array.isArray(permissionKeys) || permissionKeys.length === 0) {
    return { valid: false, invalidKeys: [], reason: "permissions must be a non-empty array." };
  }
  const uniqueKeys = [...new Set(permissionKeys)];
  const knownPermissions = await PermissionModel.find({ key: { $in: uniqueKeys }, status: "active" }).select("key").lean();
  const knownKeySet = new Set(knownPermissions.map((p) => p.key));
  const invalidKeys = uniqueKeys.filter((k) => !knownKeySet.has(k));
  return { valid: invalidKeys.length === 0, invalidKeys, keys: uniqueKeys };
};

// Every permission key's module is its dot-prefix by convention
// ("customer.read" -> "customer"), so an admin UI can group the catalog by
// module without a separate schema field to keep in sync.
const buildPermissionCatalog = (permissions) => {
  const grouped = {};
  permissions.forEach((p) => {
    const module = p.key.includes(".") ? p.key.split(".")[0] : "general";
    if (!grouped[module]) grouped[module] = [];
    grouped[module].push({ key: p.key, description: p.description });
  });
  return grouped;
};

/**
 * 1. GET /api/v1/permissions
 * Returns the full permission catalog (grouped by module) so an admin UI can
 * render a "which module/API/CRUD action can this role access" checklist —
 * this IS the module/API/CRUD-action granularity the permission strings
 * already carry (e.g. "customer.read" = module "customer", action "read").
 */
export const ListPermissions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!hasRoleReadAccess(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const allPermissions = await PermissionModel.find({ status: "active" }).sort({ key: 1 }).lean();
    return sendSuccess(res, 200, "Permission catalog retrieved successfully.", {
      permissions: allPermissions.map((p) => ({ key: p.key, description: p.description })),
      byModule: buildPermissionCatalog(allPermissions)
    }, requestId);
  } catch (error) {
    console.error("ListPermissions error:", error);
    return sendError(res, 500, "Unable to load permission catalog.", requestId);
  }
};

/** 2. GET /api/v1/roles — every role this tenant has defined (its own independent catalog). */
export const ListRoles = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!hasRoleReadAccess(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const roles = await RoleModel.find({ ...scope, status: { $ne: "inactive" } }).sort({ name: 1 }).lean();
    return sendSuccess(res, 200, "Roles retrieved successfully.", roles, requestId);
  } catch (error) {
    console.error("ListRoles error:", error);
    return sendError(res, 500, "Unable to load roles.", requestId);
  }
};

/** 3. GET /api/v1/roles/:roleId */
export const GetRole = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!hasRoleReadAccess(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const role = await RoleModel.findOne({ _id: req.params.roleId, ...scope }).lean();
    if (!role) return sendError(res, 404, "Role not found.", requestId);
    return sendSuccess(res, 200, "Role retrieved successfully.", role, requestId);
  } catch (error) {
    console.error("GetRole error:", error);
    return sendError(res, 500, "Unable to load role.", requestId);
  }
};

/**
 * 4. POST /api/v1/roles
 * The Company Admin defines a new custom role (e.g. "Sales Manager", "Visa
 * Officer") with exactly the module/API/CRUD permissions it should have.
 */
export const CreateRole = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!hasRoleManageAccess(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const { name, description, permissions: requestedPermissions } = req.body;
    if (!name || !name.trim()) return sendError(res, 422, "name is required.", requestId);

    const { valid, invalidKeys, keys } = await validatePermissionKeys(requestedPermissions);
    if (!valid) {
      return sendError(res, 422, invalidKeys.length > 0 ? `Unknown permission key(s): ${invalidKeys.join(", ")}.` : "permissions must be a non-empty array.", requestId);
    }

    const existing = await RoleModel.findOne({ ...scope, name: name.trim() }).lean();
    if (existing) return sendError(res, 409, `A role named "${name.trim()}" already exists for this company.`, requestId);

    const role = await RoleModel.create({
      tenantId: scope.tenantId,
      name: name.trim(),
      description: description || null,
      permissions: keys,
      isSystemRole: false,
      status: "active"
    });

    await AuditLogModel.create({
      action: "role.create", outcome: "success", reason: null,
      userId: req.auth?.id || null, tenantId: scope.tenantId, requestId,
      metadata: { roleId: role._id, name: role.name, permissions: keys }
    });
    publishEvent("RoleCreated", { tenantId: scope.tenantId, roleId: role._id.toString(), name: role.name });

    return sendSuccess(res, 201, "Role created successfully.", role, requestId);
  } catch (error) {
    console.error("CreateRole error:", error);
    if (error.code === 11000) return sendError(res, 409, "A role with this name already exists for this company.", requestId);
    return sendError(res, 500, "Unable to create role.", requestId);
  }
};

/**
 * 5. PATCH /api/v1/roles/:roleId
 * Reconfigure a role's permission set — this is the "admin decides which
 * APIs/CRUD operations/dashboard sections a role can access" control point.
 * The role's name is immutable once created (avoids silently breaking
 * anything that already refers to it by name); description/permissions/
 * status are freely editable, including for the seeded system role (its
 * permission set can be tightened/loosened by the admin — only outright
 * deletion is blocked for system roles, see DeleteRole).
 */
export const UpdateRole = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!hasRoleManageAccess(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const role = await RoleModel.findOne({ _id: req.params.roleId, ...scope });
    if (!role) return sendError(res, 404, "Role not found.", requestId);

    const { description, permissions: requestedPermissions, status } = req.body;
    const changes = {};

    if (requestedPermissions !== undefined) {
      const { valid, invalidKeys, keys } = await validatePermissionKeys(requestedPermissions);
      if (!valid) {
        return sendError(res, 422, invalidKeys.length > 0 ? `Unknown permission key(s): ${invalidKeys.join(", ")}.` : "permissions must be a non-empty array.", requestId);
      }
      role.permissions = keys;
      changes.permissions = keys;
    }
    if (description !== undefined) {
      role.description = description || null;
      changes.description = role.description;
    }
    if (status !== undefined) {
      if (!["active", "inactive"].includes(status)) return sendError(res, 422, `Invalid status "${status}". Must be "active" or "inactive".`, requestId);
      role.status = status;
      changes.status = status;
    }

    if (Object.keys(changes).length === 0) return sendError(res, 400, "No valid fields provided for update.", requestId);

    await role.save();
    // Permission checks are cached per (tenantId, roleName) in
    // middleware/authenticateAccessToken.js — invalidate so a permission
    // change takes effect on the affected users' very next request, not
    // after the cache TTL happens to expire.
    await CacheManager.invalidate(`role:permissions:${scope.tenantId}:${role.name}`);

    await AuditLogModel.create({
      action: "role.update", outcome: "success", reason: null,
      userId: req.auth?.id || null, tenantId: scope.tenantId, requestId,
      metadata: { roleId: role._id, name: role.name, changes }
    });
    publishEvent("RoleUpdated", { tenantId: scope.tenantId, roleId: role._id.toString(), name: role.name, changes });

    return sendSuccess(res, 200, "Role updated successfully.", role, requestId);
  } catch (error) {
    console.error("UpdateRole error:", error);
    return sendError(res, 500, "Unable to update role.", requestId);
  }
};

/** 6. DELETE /api/v1/roles/:roleId */
export const DeleteRole = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!hasRoleManageAccess(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const role = await RoleModel.findOne({ _id: req.params.roleId, ...scope });
    if (!role) return sendError(res, 404, "Role not found.", requestId);

    if (role.isSystemRole || role.name === ADMINISTRATOR_ROLE_NAME) {
      return sendError(res, 403, "The system Administrator role cannot be deleted.", requestId);
    }

    // A role still assigned to real users/employees cannot be deleted out
    // from under them — this would silently strip their access with no
    // audit trail. The admin must reassign those users to a different role first.
    const [userCount, profileCount] = await Promise.all([
      UserModel.countDocuments({ tenantId: scope.tenantId, role: role.name, status: { $ne: "deleted" } }),
      EmployeeProfileModel.countDocuments({ tenantId: scope.tenantId, roleIds: role._id, status: { $ne: "archived" } })
    ]);
    if (userCount > 0 || profileCount > 0) {
      return sendError(res, 409, `This role is still assigned to ${userCount + profileCount} user(s)/employee(s). Reassign them before deleting the role.`, requestId);
    }

    await RoleModel.deleteOne({ _id: role._id });
    await CacheManager.invalidate(`role:permissions:${scope.tenantId}:${role.name}`);

    await AuditLogModel.create({
      action: "role.delete", outcome: "success", reason: null,
      userId: req.auth?.id || null, tenantId: scope.tenantId, requestId,
      metadata: { roleId: role._id, name: role.name }
    });
    publishEvent("RoleDeleted", { tenantId: scope.tenantId, roleId: role._id.toString(), name: role.name });

    return sendSuccess(res, 200, "Role deleted successfully.", null, requestId);
  } catch (error) {
    console.error("DeleteRole error:", error);
    return sendError(res, 500, "Unable to delete role.", requestId);
  }
};
