import mongoose from "mongoose";

const EmbassyBatchSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  branchId: {
    type: String,
    default: "main",
    index: true
  },
  batchNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  embassyId: {
    type: String,
    default: null
  },
  embassyName: {
    type: String,
    required: true
  },
  destinationCountry: {
    type: String,
    required: true
  },
  submissionMethod: {
    type: String,
    default: "Courier"
  },
  status: {
    type: String,
    enum: ["Draft", "Ready_for_Dispatch", "Dispatched", "Received_by_Embassy", "Processing", "Completed"],
    default: "Draft",
    index: true
  },
  casesCount: {
    type: Number,
    default: 0
  },
  submissions: [
    {
      submissionId: { type: mongoose.Schema.Types.ObjectId, ref: "embassy_submission" },
      visaCaseId: { type: mongoose.Schema.Types.ObjectId, ref: "visa_case" },
      caseNumber: { type: String, required: true }
    }
  ],
  courierManifest: {
    courierCompany: { type: String, default: null },
    trackingNumber: { type: String, default: null },
    manifestNumber: { type: String, default: null },
    dispatchedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null }
  },
  notes: {
    type: String,
    default: null
  },
  createdByName: {
    type: String,
    default: "system"
  }
}, { timestamps: true });

EmbassyBatchSchema.index({ tenantId: 1, status: 1 });

const EmbassyBatchModel = mongoose.model("embassy_batch", EmbassyBatchSchema);

export default EmbassyBatchModel;
