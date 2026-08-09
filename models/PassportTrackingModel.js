import mongoose from "mongoose";

const TrackingEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true },
  eventType: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  previousHolder: { type: String, default: null },
  newHolder: { type: String, required: true },
  previousLocation: { type: String, default: null },
  newLocation: { type: String, required: true },
  performedBy: { type: String, required: true },
  reason: { type: String, default: null },
  remarks: { type: String, default: null },
  digitalSignature: { type: String, default: null },
  gps: {
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null }
  }
}, { _id: true });

const PassportTrackingSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  visaCaseId: { type: mongoose.Schema.Types.ObjectId, ref: "visa_case", required: true, index: true },
  travelerId: { type: String, default: null, index: true },
  passportNumber: { type: String, required: true, index: true },
  nationality: { type: String, required: true },
  issueDate: { type: Date, default: null },
  expiryDate: { type: Date, default: null },
  currentStatus: {
    type: String,
    enum: [
      "Received", "Under Verification", "Ready For Dispatch", "Dispatched",
      "With Courier", "At Embassy", "Embassy Processing", "Returned",
      "Ready For Collection", "Collected", "Lost", "Damaged", "Cancelled"
    ],
    default: "Received",
    index: true
  },
  currentHolder: { type: String, default: "Front Desk" },
  currentLocation: { type: String, default: "Main Office" },
  trackingNumber: { type: String, default: null, index: true },
  courierCompany: { type: String, default: null },
  embassyName: { type: String, default: null },
  trackingEvents: [TrackingEventSchema],
  dispatchInfo: {
    dispatchNumber: { type: String, default: null },
    courier: { type: String, default: null },
    trackingNumber: { type: String, default: null },
    dispatchTime: { type: Date, default: null },
    expectedDelivery: { type: Date, default: null }
  },
  collectionInfo: {
    collectedBy: { type: String, default: null },
    identityVerified: { type: Boolean, default: false },
    verifiedBy: { type: String, default: null },
    collectionTime: { type: Date, default: null },
    receiptNumber: { type: String, default: null },
    remarks: { type: String, default: null }
  },
  isLost: { type: Boolean, default: false },
  isDamaged: { type: Boolean, default: false }
}, { timestamps: true });

PassportTrackingSchema.index({ tenantId: 1, visaCaseId: 1 });
PassportTrackingSchema.index({ tenantId: 1, passportNumber: 1 });

const PassportTrackingModel = mongoose.model("passport_tracking", PassportTrackingSchema);

export default PassportTrackingModel;
