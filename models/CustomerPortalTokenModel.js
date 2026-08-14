import mongoose from "mongoose";

// Enterprise Customer Payments — Finance Module Part 18 Part 4. "Customer
// Self-Service Portal." Finance-owned (Finance does NOT own Customer,
// Part 1) — references Customer by id only, the same convention as
// CustomerCollectionModel/AccountsReceivableModel. Real, unguessable
// token (crypto.randomBytes via ReceiptQrService, same generator Part 8's
// receipt/payment-link tokens already use) — the exact same
// public-token-as-access-control convention `CustomerCollectionModel`'s
// own `paymentLink.token` already established, scoped to ONE customer's
// own read-only data instead of one collection.
const CustomerPortalTokenSchema = new mongoose.Schema({
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
  token: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  viewCount: { type: Number, default: 0 },
  createdBy: { type: String, default: null }
}, { timestamps: true });

CustomerPortalTokenSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CustomerPortalTokenModel = mongoose.model("customer_portal_token", CustomerPortalTokenSchema);

export default CustomerPortalTokenModel;
