import mongoose from "mongoose";

const VisaAppointmentSchema = new mongoose.Schema({
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
  appointmentNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  visaCaseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "visa_case",
    required: true,
    index: true
  },
  caseNumber: {
    type: String,
    required: true,
    index: true
  },
  travelerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    default: null
  },
  appointmentType: {
    type: String,
    required: true,
    index: true
  },
  providerId: {
    type: String,
    default: null
  },
  providerName: {
    type: String,
    default: "VFS Global / Embassy VAC"
  },
  locationId: {
    type: String,
    default: null
  },
  location: {
    type: String,
    default: "VAC Center"
  },
  appointmentDate: {
    type: Date,
    required: true,
    index: true
  },
  appointmentTime: {
    type: String,
    required: true
  },
  durationMinutes: {
    type: Number,
    default: 30
  },
  assignedOfficer: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: [
      "Draft",
      "Scheduled",
      "Reminder Sent",
      "Confirmed",
      "Checked In",
      "In Progress",
      "Completed",
      "Rescheduled",
      "Cancelled",
      "Missed",
      "No Show",
      "Rejected"
    ],
    default: "Scheduled",
    index: true
  },
  attendance: {
    status: {
      type: String,
      enum: ["pending", "checked_in", "present", "completed", "no_show", "late", "cancelled"],
      default: "pending"
    },
    checkInTime: { type: Date, default: null },
    markedBy: { type: String, default: null },
    markedAt: { type: Date, default: null }
  },
  result: {
    outcome: {
      type: String,
      enum: [
        "pending",
        "Successful",
        "Failed",
        "Reschedule Required",
        "Medical Failed",
        "Interview Failed",
        "Interview Passed",
        "Biometric Completed",
        "Additional Documents Required",
        "Pending Review"
      ],
      default: "pending"
    },
    notes: { type: String, default: null },
    recordedBy: { type: String, default: null },
    recordedAt: { type: Date, default: null }
  },
  reminders: [
    {
      channel: { type: String, enum: ["Email", "SMS", "WhatsApp", "Push"], default: "Email" },
      scheduledFor: { type: Date, required: true },
      sentAt: { type: Date, default: null },
      status: { type: String, enum: ["pending", "sent", "failed"], default: "pending" }
    }
  ],
  rescheduleHistory: [
    {
      oldDate: { type: Date },
      oldTime: { type: String },
      newDate: { type: Date },
      newTime: { type: String },
      reason: { type: String },
      rescheduledBy: { type: String },
      rescheduledAt: { type: Date, default: Date.now }
    }
  ],
  remarks: {
    type: String,
    default: null
  },
  isSoftDeleted: {
    type: Boolean,
    default: false,
    index: true
  }
}, { timestamps: true });

VisaAppointmentSchema.index({ tenantId: 1, visaCaseId: 1, appointmentDate: 1 });

const VisaAppointmentModel = mongoose.model("visa_appointment", VisaAppointmentSchema);

export default VisaAppointmentModel;
