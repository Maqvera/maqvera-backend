import mongoose from "mongoose";

// Enterprise Tax Engine — Finance Module Part 20. "Tax Exemptions...
// Government, Diplomatic, Educational, Medical, Export, Charity.
// Certificate based." A real, tenant-scoped exemption record
// `TaxService.calculateTax` checks before applying tax to a party's
// line — never a blanket "this customer never pays tax" flag on the
// party itself, so the exemption stays certificate-scoped, dated, and
// auditable independently of the party record. Tenant-scoped only — no
// branchId.
const TaxExemptionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // customer | vendor — whichever party the exemption certificate covers.
  partyType: { type: String, required: true },
  partyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  // Config-driven (taxExemptionTypes) — Government, Diplomatic,
  // Educational, Medical, Export, Charity.
  exemptionType: { type: String, required: true },
  certificateNumber: { type: String, required: true },
  certificateUrl: { type: String, default: null },
  // Empty = exempt from every tax code; otherwise only these.
  applicableTaxCodes: { type: [String], default: [] },
  validFrom: { type: Date, required: true },
  validUntil: { type: Date, default: null },
  // Active | Expired | Revoked. "Expired" only ever set when the caller
  // explicitly checks — same real-date-range-over-cron-status stance as
  // TaxRuleModel, except here there's no named domain event requiring a
  // scheduler to flip it (only TaxRuleExpired is named), so
  // TaxService.isExemptionApplicable checks `validUntil` directly at
  // lookup time instead.
  status: { type: String, required: true, default: "Active" },
  revokedReason: { type: String, default: null },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

TaxExemptionSchema.index({ tenantId: 1, partyType: 1, partyId: 1, status: 1 });

TaxExemptionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TaxExemptionModel = mongoose.model("tax_exemption", TaxExemptionSchema);

export default TaxExemptionModel;
