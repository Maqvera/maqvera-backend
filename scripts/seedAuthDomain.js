import dotenv from "dotenv";
import mongoose from "mongoose";
import TenantModel from "../models/Tenantmodel.js";
import UserModel from "../models/Usermodel.js";
import { ensureAdministratorRole } from "../utils/authDomainDefaults.js";

dotenv.config();

const seed = async () => {
  const uri = process.env.URI;

  if (!uri) {
    throw new Error("URI is required for seeding.");
  }

  await mongoose.connect(uri);

  // Example/dev-seed tenant only — this is no longer the app's only tenant.
  // New tenants are provisioned by real users at runtime via POST /auth/setup.
  const tenant = await TenantModel.findOneAndUpdate(
    { tenantKey: "ALNOOR" },
    { tenantKey: "ALNOOR", name: "Al Noor Travels", status: "active" },
    { upsert: true, new: true }
  );

  const role = await ensureAdministratorRole(tenant.tenantKey);

  await UserModel.updateMany(
    {
      $or: [
        { tenantId: { $exists: false } },
        { tenantId: null },
        { role: { $exists: false } },
        { role: null }
      ]
    },
    {
      $set: {
        tenantId: tenant.tenantKey,
        role: role.name
      }
    }
  );

  console.log(`Seeded tenant ${tenant.tenantKey}, role ${role.name}`);
  await mongoose.disconnect();
};

seed().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
