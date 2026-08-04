import dotenv from "dotenv";
import mongoose from "mongoose";
import IncidentPolicyModel from "../models/IncidentPolicyModel.js";
import { getIncidentConfig } from "../utils/incidentConfig.js";

dotenv.config();
if (!process.env.URI || !process.env.SEED_TENANT_ID) throw new Error("URI and SEED_TENANT_ID are required.");
await mongoose.connect(process.env.URI);

const incidentConfig = getIncidentConfig();

// Visa's original category list (Documentation/Passport/Embassy/etc.) is
// kept exactly as-is — Visa incidents already depend on these names
// existing and being active — merged additively with Part 8's Travel
// Operations categories (docs/05-api/07-travel-api.md) rather than
// replacing the list, so both modules' "Category Exists" validation keeps
// working against the same seeded policy.
const visaCategories = ["Documentation", "Passport", "Embassy", "Medical", "Interview", "Biometric", "Courier", "Compliance", "Fraud", "Finance", "Customer", "Travel", "Security", "Technical", "Other"];
const mergedCategoryNames = [...new Set([...visaCategories, ...incidentConfig.defaultCategories])];

await IncidentPolicyModel.findOneAndUpdate(
  { tenantId: process.env.SEED_TENANT_ID },
  {
    tenantId: process.env.SEED_TENANT_ID,
    defaultAssignmentTeam: process.env.INCIDENT_DEFAULT_ASSIGNMENT_TEAM || incidentConfig.defaultAssignmentTeam,
    isActive: true,
    categories: mergedCategoryNames.map((name) => ({
      name,
      isActive: true,
      locksVisaCase: ["Passport", "Fraud", "Security"].includes(name) || incidentConfig.categoriesThatLockVisaCase.includes(name)
    })),
    severities: incidentConfig.defaultSeverities
  },
  { upsert: true, new: true, setDefaultsOnInsert: true }
);
await mongoose.disconnect();
console.log(`Incident policy configured for tenant ${process.env.SEED_TENANT_ID} (${mergedCategoryNames.length} categories).`);
