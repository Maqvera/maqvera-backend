import dotenv from "dotenv";
import mongoose from "mongoose";
import NumberingSchemeModel from "../models/NumberingSchemeModel.js";
import NumberGeneratorService from "../services/NumberGeneratorService.js";

dotenv.config();
if (!process.env.URI || !process.env.SEED_TENANT_ID) throw new Error("URI and SEED_TENANT_ID are required.");
await mongoose.connect(process.env.URI);

const tenantId = process.env.SEED_TENANT_ID;
const existing = await NumberingSchemeModel.findOne({ tenantId, resourceType: "GdsVoucher", companyId: null, branchId: null }).lean();

if (existing) {
  console.log(`GDS voucher numbering scheme already exists for tenant ${tenantId} (prefix "${existing.prefix}") — nothing to do.`);
} else {
  const scheme = await NumberGeneratorService.createScheme(tenantId, {
    resourceType: "GdsVoucher",
    prefix: process.env.GDS_VOUCHER_NUMBER_PREFIX || "VOUCH",
    includeYear: true,
    sequenceLength: 6,
    allowGaps: true,
    isDefault: true
  }, "seed");
  console.log(`GDS voucher numbering scheme created for tenant ${tenantId}: prefix "${scheme.prefix}".`);
}

await mongoose.disconnect();
