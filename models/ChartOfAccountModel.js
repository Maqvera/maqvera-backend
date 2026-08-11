import mongoose from "mongoose";

// Chart of Accounts — Finance Module Part 2. Tenant is the only isolation
// boundary in this system (see docs/06-external-integrations/03-final-architecture-no-branches-rbac.md);
// there is deliberately no branchId here even though the spec doc mentions
// "Branch Isolation" — see docs/05-api/07-finance-api.md's tenant-scope note.
//
// Hierarchy is modeled with parentId (direct edge) + ancestors (materialized
// path of every ancestor's _id, root-to-parent order) so subtree queries and
// cycle detection don't require walking parentId chains at request time.
const ChartOfAccountSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // "Immutable Account Codes" (AI Coding Rule) — enforced here as a schema
  // guarantee (Mongoose refuses writes to an immutable path after the
  // document is no longer new) in addition to the service never accepting
  // accountCode in its update path.
  accountCode: {
    type: String,
    required: true,
    trim: true,
    immutable: true
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
  // Category/type/status values are config-driven (utils/financeConfig.js)
  // rather than a hardcoded schema enum, matching this codebase's existing
  // convention for config-driven fields — Joi (middleware/validateRequest.js)
  // is the enforcement point for the current valid-value set.
  category: {
    type: String,
    required: true,
    index: true
  },
  type: {
    type: String,
    required: true,
    index: true
  },
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "chart_of_account",
    default: null,
    index: true
  },
  ancestors: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "chart_of_account"
  }],
  level: {
    type: Number,
    default: 0,
    index: true
  },
  status: {
    type: String,
    required: true,
    index: true
  },
  currency: {
    type: String,
    required: true
  },
  allowPosting: {
    type: Boolean,
    default: true
  },
  // Protected system accounts (Retained Earnings, Sales Revenue, Suspense
  // Account, ...) — never settable through the public create/update payload;
  // only provisioned by trusted server-side seeding/bootstrap code.
  isSystemAccount: {
    type: Boolean,
    default: false,
    index: true
  },
  // Set by the (future, Part 3) Journal/Posting Engine the first time a
  // journal line posts against this account. Drives the "Accounts with
  // journal entries cannot be removed" business rule ahead of the Journal
  // Engine existing — defaults false so accounts remain freely deletable
  // until something has actually posted to them.
  hasPostedTransactions: {
    type: Boolean,
    default: false
  },
  tags: [{
    type: String,
    trim: true
  }],
  createdBy: {
    type: String,
    default: null
  },
  updatedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

// "Unique Account Code" validation rule — unique per tenant, not globally.
ChartOfAccountSchema.index({ tenantId: 1, accountCode: 1 }, { unique: true });
ChartOfAccountSchema.index({ tenantId: 1, parentId: 1 });
ChartOfAccountSchema.index({ tenantId: 1, category: 1, status: 1 });
ChartOfAccountSchema.index({ tenantId: 1, ancestors: 1 });

ChartOfAccountSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ChartOfAccountModel = mongoose.model("chart_of_account", ChartOfAccountSchema);

export default ChartOfAccountModel;
