import mongoose from "mongoose";

// Package Pricing Engine — PRD §41 "Commission Engine": fixed or
// percentage commission, agent/destination/hotel-specific. Distinct from
// MarkupRuleModel — markup changes the CUSTOMER's selling price; a
// commission is an internal amount owed to whoever sold the package, and
// never affects `finalPricePerPerson`. Surfaced on the room-wise matrix as
// `commissionPerPerson`, gated behind the same cost/profit visibility
// permission as supplier cost (PRD §50).
const CommissionRuleSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, default: null },
  scope: { type: String, required: true, index: true },
  type: { type: String, required: true },
  value: { type: Number, required: true, min: 0 },
  // Populated only for the matching `scope` — Agent -> agentUserId,
  // Destination -> destinationCountry, Hotel -> hotelCatalogId, Global -> none.
  agentUserId: { type: String, default: null },
  destinationCountry: { type: String, default: null },
  hotelCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "hotel_catalog", default: null },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

CommissionRuleSchema.index({ tenantId: 1, scope: 1, active: 1 });

CommissionRuleSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CommissionRuleModel = mongoose.model("commission_rule", CommissionRuleSchema);

export default CommissionRuleModel;
