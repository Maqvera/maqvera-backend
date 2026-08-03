import dotenv from "dotenv";
import mongoose from "mongoose";
import IncidentPolicyModel from "../models/IncidentPolicyModel.js";

dotenv.config();
if (!process.env.URI || !process.env.SEED_TENANT_ID) throw new Error("URI and SEED_TENANT_ID are required.");
await mongoose.connect(process.env.URI);
await IncidentPolicyModel.findOneAndUpdate(
  { tenantId: process.env.SEED_TENANT_ID },
  {
    tenantId: process.env.SEED_TENANT_ID,
    defaultAssignmentTeam: process.env.INCIDENT_DEFAULT_ASSIGNMENT_TEAM || "Operations",
    isActive: true,
    categories: ["Documentation", "Passport", "Embassy", "Medical", "Interview", "Biometric", "Courier", "Compliance", "Fraud", "Finance", "Customer", "Travel", "Security", "Technical", "Other"].map((name) => ({ name, isActive: true, locksVisaCase: ["Passport", "Fraud", "Security"].includes(name) })),
    severities: [
      { name: "Low", firstResponseMins: 720, resolutionHours: 48, isActive: true, locksVisaCase: false },
      { name: "Medium", firstResponseMins: 240, resolutionHours: 24, isActive: true, locksVisaCase: false },
      { name: "High", firstResponseMins: 60, resolutionHours: 6, isActive: true, locksVisaCase: false },
      { name: "Critical", firstResponseMins: 30, resolutionHours: 2, isActive: true, locksVisaCase: true },
      { name: "Emergency", firstResponseMins: 15, resolutionHours: 1, isActive: true, locksVisaCase: true }
    ]
  },
  { upsert: true, new: true, setDefaultsOnInsert: true }
);
await mongoose.disconnect();
console.log(`Incident policy configured for tenant ${process.env.SEED_TENANT_ID}.`);
