import mongoose from "mongoose";

// Enterprise Budgeting & Forecasting — Finance Module Part 17.
// Centralized enterprise budgets platform (EPM). Operating independently
// from accounting General Ledger entries while supporting variance tracking
// and version control.
// Tenant-scoped only — no branchId per Master Architecture rules.
const LineItemSchema = new mongoose.Schema({
  code: { type: String, default: null },
  accountCode: { type: String, default: null },
  category: { type: String, required: true }, // Revenue | Expense | Capital | Payroll | Operational
  name: { type: String, required: true },
  allocatedAmount: { type: Number, required: true, min: 0 },
  periodBreakdown: { type: mongoose.Schema.Types.Mixed, default: {} }, // e.g. { "Q1": 10000, "Q2": 10000 } or monthly
  notes: { type: String, default: null }
}, { _id: true });

const RevisionHistorySchema = new mongoose.Schema({
  version: { type: Number, required: true },
  changedBy: { type: String, default: null },
  changedAt: { type: Date, default: Date.now },
  reason: { type: String, default: null },
  totalAmount: { type: Number, required: true },
  snapshot: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: true });

const EnterpriseBudgetSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  budgetId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    index: true
  },
  department: {
    type: String,
    default: "All",
    index: true
  },
  fiscalYear: {
    type: String,
    required: true,
    index: true
  },
  currency: {
    type: String,
    required: true,
    index: true
  },
  budgetType: {
    type: String,
    enum: ["Annual", "Quarterly", "Monthly", "Department", "Project", "Capital", "Operational"],
    default: "Annual",
    required: true,
    index: true
  },
  version: {
    type: Number,
    default: 1,
    required: true
  },
  isLatestVersion: {
    type: Boolean,
    default: true,
    index: true
  },
  parentBudgetId: {
    type: String,
    default: null,
    index: true
  },
  status: {
    type: String,
    enum: ["Draft", "Submitted", "Approved", "Published", "Archived"],
    default: "Draft",
    required: true,
    index: true
  },
  approvalStatus: {
    type: String,
    enum: ["Pending", "Submitted", "Approved", "Rejected", "RevisionRequested"],
    default: "Pending",
    index: true
  },
  owner: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: null
  },
  periodStart: {
    type: Date,
    default: null
  },
  periodEnd: {
    type: Date,
    default: null
  },
  lineItems: {
    type: [LineItemSchema],
    default: []
  },
  totalAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  publishedAt: {
    type: Date,
    default: null
  },
  publishedBy: {
    type: String,
    default: null
  },
  approvedAt: {
    type: Date,
    default: null
  },
  approvedBy: {
    type: String,
    default: null
  },
  revisionReason: {
    type: String,
    default: null
  },
  revisionHistory: {
    type: [RevisionHistorySchema],
    default: []
  },
  createdBy: {
    type: String,
    default: null
  },
  updatedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

EnterpriseBudgetSchema.index({ tenantId: 1, fiscalYear: 1, name: 1, version: 1 }, { unique: true });
EnterpriseBudgetSchema.index({ tenantId: 1, status: 1 });
EnterpriseBudgetSchema.index({ tenantId: 1, department: 1, fiscalYear: 1 });

EnterpriseBudgetSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const EnterpriseBudgetModel = mongoose.model("enterprise_budget", EnterpriseBudgetSchema);

export default EnterpriseBudgetModel;
