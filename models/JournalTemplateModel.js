import mongoose from "mongoose";

// "Journal Templates" — File 2, Journal Platform Part 2, item 18.
// Tenant-scoped only (unlike ChartTemplateModel's tenant-agnostic
// "GlobalTemplate" case): a journal template's lineBlueprints reference
// real accountCode values, which only exist within one tenant's own Chart
// of Accounts, so a template can never be meaningfully shared across
// tenants the way a generic chart-of-accounts blueprint can. No example
// templates are seeded for fictional business processes (Salary/
// Subscription/Merchant Settlement/Depreciation) — the mechanism is
// generic and real; a tenant authors its own templates against its own
// accounts. See docs/05-api/07-finance-api.md Part 39.
const JournalTemplateLineSchema = new mongoose.Schema({
  accountCode: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: null
  },
  debit: {
    type: Number,
    default: 0,
    min: 0
  },
  credit: {
    type: Number,
    default: 0,
    min: 0
  },
  dimensions: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { _id: false });

const JournalTemplateSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  templateId: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: null
  },
  // Config-driven (financeConfig.journalTypes) — the journalType every
  // journal created from this template will carry, unless overridden.
  journalType: {
    type: String,
    required: true
  },
  currency: {
    type: String,
    default: null
  },
  lineBlueprints: {
    type: [JournalTemplateLineSchema],
    validate: {
      validator: (lines) => Array.isArray(lines) && lines.length >= 2,
      message: "A journal template requires at least two line blueprints."
    }
  },
  status: {
    type: String,
    default: "Active"
  },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

JournalTemplateSchema.index({ tenantId: 1, templateId: 1 }, { unique: true });

JournalTemplateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const JournalTemplateModel = mongoose.model("journal_template", JournalTemplateSchema);

export default JournalTemplateModel;
