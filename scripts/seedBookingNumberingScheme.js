import dotenv from "dotenv";
import mongoose from "mongoose";
import NumberingSchemeModel from "../models/NumberingSchemeModel.js";
import NumberGeneratorService from "../services/NumberGeneratorService.js";

dotenv.config();
if (!process.env.URI || !process.env.SEED_TENANT_ID) throw new Error("URI and SEED_TENANT_ID are required.");
await mongoose.connect(process.env.URI);

const tenantId = process.env.SEED_TENANT_ID;
const existing = await NumberingSchemeModel.findOne({ tenantId, resourceType: "Booking", companyId: null, branchId: null }).lean();

if (existing) {
  console.log(`Booking numbering scheme already exists for tenant ${tenantId} (prefix "${existing.prefix}") — nothing to do.`);
} else {
  const scheme = await NumberGeneratorService.createScheme(tenantId, {
    resourceType: "Booking",
    prefix: process.env.BOOKING_NUMBER_PREFIX || "BK",
    includeYear: true,
    sequenceLength: 6,
    allowGaps: true,
    isDefault: true
  }, "seed");
  console.log(`Booking numbering scheme created for tenant ${tenantId}: prefix "${scheme.prefix}".`);
}

await mongoose.disconnect();
