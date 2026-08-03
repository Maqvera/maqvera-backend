import mongoose from "mongoose";

const BookingWorkflowSchema = new mongoose.Schema({
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "booking_header",
    required: true,
    unique: true,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Kept in sync with BookingHeaderModel.status / bookingConfig.workflowStates.
  currentStep: {
    type: String,
    enum: ["draft", "quotation", "reserved", "confirmed", "deposit_received", "visa_processing", "ticket_issued", "travel_ready", "traveling", "completed", "cancelled", "refund_requested", "refund_completed", "archived"],
    default: "draft"
  },
  history: [{
    step: String,
    changedBy: String,
    changedByName: String,
    timestamp: { type: Date, default: Date.now },
    comments: String
  }]
}, { timestamps: true });

const BookingWorkflowModel = mongoose.model("booking_workflow", BookingWorkflowSchema);

export default BookingWorkflowModel;
