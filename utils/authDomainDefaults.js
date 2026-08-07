import PermissionModel from "../models/Permissionmodel.js";
import RoleModel from "../models/Rolemodel.js";

// Single source of truth for the reference permission set, shared by
// scripts/seedAuthDomain.js (dev/on-prem seeding) and Auth.js's SetupTenant
// (self-service tenant onboarding) so the two never drift apart.
export const DEFAULT_PERMISSIONS = [
  { key: "customer.read", description: "Read customer records" },
  { key: "customer.create", description: "Create customer records" },
  { key: "customer.update", description: "Update customer records" },
  { key: "customer.delete", description: "Archive/delete customer records" },
  { key: "customers.read", description: "Read customer records (plural alias)" },
  { key: "customers.create", description: "Create customer records (plural alias)" },
  { key: "customers.update", description: "Update customer records (plural alias)" },
  { key: "customers.delete", description: "Archive/delete customer records (plural alias)" },
  { key: "users.read", description: "Read user/employee records" },
  { key: "users.create", description: "Create user/employee records" },
  { key: "users.update", description: "Update user/employee records" },
  { key: "users.delete", description: "Archive/delete user/employee records" },
  { key: "employee.read", description: "Read employee records (alias)" },
  { key: "employee.create", description: "Create employee records (alias)" },
  { key: "employee.update", description: "Update employee records (alias)" },
  { key: "employee.delete", description: "Archive/delete employee records (alias)" },
  { key: "booking.read", description: "Read booking records" },
  { key: "booking.create", description: "Create booking records" },
  { key: "booking.update", description: "Update booking records" },
  { key: "booking.delete", description: "Delete booking records" },
  { key: "bookings.read", description: "Read booking records (plural alias)" },
  { key: "bookings.create", description: "Create booking records (plural alias)" },
  { key: "bookings.update", description: "Update booking records (plural alias)" },
  { key: "bookings.delete", description: "Delete booking records (plural alias)" },
  { key: "travel.read", description: "Read travel plan records" },
  { key: "travel.write", description: "Create/update travel plan records" },
  { key: "travel_plans.read", description: "Read travel plan records (alias)" },
  { key: "travel_plans.write", description: "Create/update travel plan records (alias)" },
  { key: "finance.read", description: "Read finance records" },
  { key: "visa.read", description: "Read visa records" },
  { key: "reporting.read", description: "Read reporting data" },
  { key: "admin", description: "Full administrative override across all modules" },
];

export const ADMINISTRATOR_ROLE_NAME = "Administrator";

export const ensurePermissionsSeeded = async () => {
  await PermissionModel.bulkWrite(
    DEFAULT_PERMISSIONS.map((permission) => ({
      updateOne: {
        filter: { key: permission.key },
        update: { $set: { ...permission, status: "active" } },
        upsert: true,
      },
    }))
  );
};

// RoleModel.name is unique per tenant, not globally — every tenant gets its
// own independently-editable "Administrator" role document (seeded with the
// same default permission set as a starting point, not a shared reference
// every tenant is locked into). Idempotent: safe to call on every tenant
// setup, not just the first, and safe to re-run for an existing tenant.
export const ensureAdministratorRole = async (tenantId) => {
  if (!tenantId) throw new Error("tenantId is required to provision the Administrator role.");
  await ensurePermissionsSeeded();
  const administratorPermissions = DEFAULT_PERMISSIONS.map((permission) => permission.key);
  return RoleModel.findOneAndUpdate(
    { tenantId, name: ADMINISTRATOR_ROLE_NAME },
    { tenantId, name: ADMINISTRATOR_ROLE_NAME, permissions: administratorPermissions, scope: "tenant", status: "active" },
    { upsert: true, new: true }
  );
};
