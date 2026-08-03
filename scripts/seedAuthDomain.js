import dotenv from "dotenv";
import mongoose from "mongoose";
import TenantModel from "../models/Tenantmodel.js";
import BranchModel from "../models/Branchmodel.js";
import RoleModel from "../models/Rolemodel.js";
import PermissionModel from "../models/Permissionmodel.js";
import UserModel from "../models/Usermodel.js";

dotenv.config();

const permissions = [
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
  { key: "admin", description: "Full administrative override across all modules" }
];

const seed = async () => {
  const uri = process.env.URI;

  if (!uri) {
    throw new Error("URI is required for seeding.");
  }

  await mongoose.connect(uri);

  const tenant = await TenantModel.findOneAndUpdate(
    { tenantKey: "ALNOOR" },
    { tenantKey: "ALNOOR", name: "Al Noor Travels", status: "active" },
    { upsert: true, new: true }
  );

  const branch = await BranchModel.findOneAndUpdate(
    { branchKey: "KARACHI", tenantKey: tenant.tenantKey },
    { branchKey: "KARACHI", tenantKey: tenant.tenantKey, name: "Karachi Branch", status: "active" },
    { upsert: true, new: true }
  );

  await PermissionModel.bulkWrite(
    permissions.map((permission) => ({
      updateOne: {
        filter: { key: permission.key },
        update: { $set: { ...permission, status: "active" } },
        upsert: true
      }
    }))
  );

  const administratorPermissions = permissions.map((permission) => permission.key);

  const role = await RoleModel.findOneAndUpdate(
    { name: "Administrator" },
    { name: "Administrator", permissions: administratorPermissions, status: "active" },
    { upsert: true, new: true }
  );

  await UserModel.updateMany(
    {
      $or: [
        { tenantId: { $exists: false } },
        { tenantId: null },
        { branchId: { $exists: false } },
        { branchId: null },
        { role: { $exists: false } },
        { role: null }
      ]
    },
    {
      $set: {
        tenantId: tenant.tenantKey,
        branchId: branch.branchKey,
        role: role.name
      }
    }
  );

  console.log(`Seeded tenant ${tenant.tenantKey}, branch ${branch.branchKey}, role ${role.name}`);
  await mongoose.disconnect();
};

seed().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});