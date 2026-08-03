import dotenv from "dotenv";
import mongoose from "mongoose";
import TimelinePolicyModel from "../models/TimelinePolicyModel.js";

dotenv.config();
if (!process.env.URI || !process.env.SEED_TENANT_ID) throw new Error("URI and SEED_TENANT_ID are required.");
await mongoose.connect(process.env.URI);
await TimelinePolicyModel.findOneAndUpdate(
  { tenantId: process.env.SEED_TENANT_ID },
  {
    tenantId: process.env.SEED_TENANT_ID,
    noteTypes: ["Internal", "Customer", "Embassy", "Compliance", "Finance", "Management", "AI", "Private", "Shared"],
    visibilityLevels: ["Public", "Internal", "Operations", "Management", "Customer Visible", "Private", "System"],
    maxNoteLength: Number(process.env.TIMELINE_MAX_NOTE_LENGTH || 5000),
    isActive: true
  },
  { upsert: true, new: true, setDefaultsOnInsert: true }
);
await mongoose.disconnect();
console.log(`Timeline policy configured for tenant ${process.env.SEED_TENANT_ID}.`);
