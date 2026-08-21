import mongoose from "mongoose";

// Package Pricing Engine — PRD §9 "Pricing & Profit Engine". Fixed or
// percentage profit, scoped to one cost component or the entire package,
// per customer price-list type (B2C/B2B/Corporate/VIP — PRD §9).
const MarkupRuleSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, default: null },
  scope: { type: String, required: true, index: true },
  type: { type: String, required: true },
  value: { type: Number, required: true, min: 0 },
  priceListType: { type: String, required: true, index: true },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

MarkupRuleSchema.index({ tenantId: 1, priceListType: 1, scope: 1, active: 1 });

MarkupRuleSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const MarkupRuleModel = mongoose.model("markup_rule", MarkupRuleSchema);

export default MarkupRuleModel;
