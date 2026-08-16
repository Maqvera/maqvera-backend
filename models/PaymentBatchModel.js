import mongoose from "mongoose";

// Payment Batches — Finance Module Part 17. "Batch Payments... Daily,
// Weekly, Monthly, Urgent, Custom. Batch approval configurable." Groups
// multiple VendorPaymentModel proposals for one combined execution/file
// generation run.
const PaymentBatchSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  batchNumber: {
    type: String,
    required: true,
    immutable: true
  },
  // Config-driven (paymentBatchTypes) — Daily, Weekly, Monthly, Urgent, Custom.
  batchType: { type: String, required: true },
  scheduledDate: { type: Date, required: true },
  vendorPaymentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "vendor_payment_run" }],
  totalAmount: { type: Number, default: 0 },
  currency: { type: String, required: true },
  // Open (accepting more vendor payments) -> Executing -> Completed |
  // PartiallyFailed.
  status: { type: String, enum: ["Open", "Executing", "Completed", "PartiallyFailed"], default: "Open", index: true },
  fileGeneration: {
    format: { type: String, default: null },
    generatedAt: { type: Date, default: null },
    url: { type: String, default: null },
    storageKey: { type: String, default: null },
    storageProvider: { type: String, default: null }
  },
  executedAt: { type: Date, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

PaymentBatchSchema.index({ tenantId: 1, batchNumber: 1 }, { unique: true });
PaymentBatchSchema.index({ tenantId: 1, status: 1 });

PaymentBatchSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PaymentBatchModel = mongoose.model("payment_batch", PaymentBatchSchema);

export default PaymentBatchModel;
