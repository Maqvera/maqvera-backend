import mongoose from "mongoose";

const CustomerTimelineSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  module: {
    type: String,
    default: "Customer",
    index: true
  },
  eventType: {
    type: String,
    required: true,
    index: true
  },
  title: {
    type: String,
    default: null
  },
  description: {
    type: String,
    required: true
  },
  performedBy: {
    type: String,
    default: null
  },
  performedByName: {
    type: String,
    default: null
  },
  referenceId: {
    type: String,
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true });

CustomerTimelineSchema.index({ customerId: 1, tenantId: 1, createdAt: -1 });
CustomerTimelineSchema.index({ customerId: 1, module: 1, eventType: 1 });

const CustomerTimelineModel = mongoose.model("customer_timeline", CustomerTimelineSchema);

export default CustomerTimelineModel;
