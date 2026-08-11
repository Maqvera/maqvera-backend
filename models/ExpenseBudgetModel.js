import mongoose from "mongoose";

// Real, minimal budget tracking — Finance Module Part 16. "Budget
// Validation: Department Budget -> Project Budget -> Cost Center Budget
// -> Approval Decision." Deliberately lean (no full enterprise Budgeting
// module — that's a separate, unbuilt roadmap Part, same as the future
// "Tax Engine"/"Settlement Engine") — just enough real, queryable
// allocation-vs-consumption tracking for ExpenseService's own budget
// check to validate against.
const ExpenseBudgetSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Department | Project | CostCenter.
  scope: {
    type: String,
    enum: ["Department", "Project", "CostCenter"],
    required: true,
    index: true
  },
  // The department's ObjectId (as a string) for scope "Department"; the
  // free-form projectId/costCenter string for the other two scopes — kept
  // as a plain string uniformly since ExpenseModel.projectId/costCenter
  // are themselves plain strings (no Project/CostCenter model exists in
  // this codebase).
  scopeRef: {
    type: String,
    required: true,
    index: true
  },
  // e.g. "2027" (yearly) or "2027-04" (monthly) — whatever granularity the
  // tenant chooses; ExpenseService matches an expense's own date against
  // whichever budget period string contains it.
  period: {
    type: String,
    required: true
  },
  currency: { type: String, required: true },
  allocatedAmount: { type: Number, required: true, min: 0 },
  // Live running total of approved/reimbursed expenses against this
  // budget — kept in sync by ExpenseService, not a point-in-time snapshot.
  consumedAmount: { type: Number, default: 0 },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

ExpenseBudgetSchema.index({ tenantId: 1, scope: 1, scopeRef: 1, period: 1 }, { unique: true });

ExpenseBudgetSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ExpenseBudgetModel = mongoose.model("expense_budget", ExpenseBudgetSchema);

export default ExpenseBudgetModel;
