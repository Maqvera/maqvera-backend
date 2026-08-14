import mongoose from "mongoose";

// Chart of Accounts Templates — Part 36. Reusable starter-chart blueprints.
// The one real "GlobalTemplate" ownership case in this codebase: a template
// with `tenantId: null` is a genuinely tenant-agnostic system template,
// applicable to any tenant via ChartOfAccountService.applyTemplate; a
// template with a real `tenantId` is a tenant's own private, reusable
// blueprint (e.g. for provisioning a second entity's books consistently).
// Never itself an isolation boundary bypass — applying a template only ever
// creates real, tenant-scoped ChartOfAccountModel rows for the caller's own
// tenant, per the standing Company-as-Tenant architecture.
const AccountBlueprintSchema = new mongoose.Schema({
  accountCode: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: null },
  category: { type: String, required: true },
  type: { type: String, required: true },
  // References another blueprint row's own accountCode within this SAME
  // template (not a real ObjectId — resolved to a real parentId only once
  // applied to a tenant) — lets a template express hierarchy declaratively.
  parentAccountCode: { type: String, default: null },
  allowPosting: { type: Boolean, default: true },
  tags: { type: [String], default: [] }
}, { _id: false });

const ChartTemplateSchema = new mongoose.Schema({
  // null = a real, tenant-agnostic system template (seeded via
  // scripts/seedChartTemplates.js); a real string = a tenant's own private
  // template, still never crossing into another tenant's data.
  tenantId: {
    type: String,
    default: null,
    index: true
  },
  templateId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  industry: {
    type: String,
    default: null
  },
  description: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ["Active", "Archived"],
    default: "Active",
    index: true
  },
  accountBlueprints: {
    type: [AccountBlueprintSchema],
    default: []
  },
  isSystemTemplate: {
    type: Boolean,
    default: false
  },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

ChartTemplateSchema.index({ tenantId: 1, name: 1 }, { unique: true });

ChartTemplateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ChartTemplateModel = mongoose.model("chart_template", ChartTemplateSchema);

export default ChartTemplateModel;
