import mongoose from "mongoose";

// "Credit Limit: Each customer may have Credit Limit, Credit Used, Credit
// Available, Credit Risk. Automatic validation before new invoices."
// Finance-owned, one profile per (tenant, customer) — kept out of
// CustomerModel entirely per Part 1's "Finance does NOT own Customers"
// boundary; Customer is referenced by id only. `creditUsed` isn't stored
// here (it's the live sum of that customer's open receivable balances —
// AccountsReceivableService.getCreditUsed) so it can never drift out of
// sync with the receivables it's supposed to reflect.
const CustomerCreditProfileSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  // 0 (default) means "no limit configured" — treated as unlimited,
  // consistent with this module's "unconfigured = permissive" stance
  // elsewhere (Financial Periods, system-account protection, etc.).
  creditLimit: {
    type: Number,
    default: 0,
    min: 0
  },
  currency: {
    type: String,
    required: true
  },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

CustomerCreditProfileSchema.index({ tenantId: 1, customerId: 1 }, { unique: true });

CustomerCreditProfileSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CustomerCreditProfileModel = mongoose.model("customer_credit_profile", CustomerCreditProfileSchema);

export default CustomerCreditProfileModel;
