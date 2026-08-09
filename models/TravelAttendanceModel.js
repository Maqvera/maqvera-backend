import mongoose from "mongoose";

const TravelAttendanceSchema = new mongoose.Schema({
  attendanceSessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "travel_attendance_session",
    default: null,
    index: true
  },
  travelPlanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "travel_plan",
    required: true,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  activityId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "travel_itinerary",
    default: null,
    index: true
  },
  travelerId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  travelerName: {
    type: String,
    required: true
  },
  // Matches utils/attendanceConfig.js's attendanceStatuses exactly (the
  // Attendance Lifecycle's states reconciled with the PATCH endpoint's own
  // "Allowed Statuses" list). "Scheduled" replaces the previous default of
  // "Checked In" (which falsely implied every stub record had already
  // checked in before any traveler actually had).
  status: {
    type: String,
    enum: ["Scheduled", "Present", "Checked In", "Checked Out", "Completed", "Late", "Absent", "Excused", "Emergency", "Missing"],
    default: "Scheduled",
    index: true
  },
  // Was defaulted to Date.now, meaning a freshly-created stub record would
  // report a check-in time before any traveler had actually checked in —
  // null until a real check-in is recorded.
  checkInTime: {
    type: Date,
    default: null
  },
  checkOutTime: {
    type: Date,
    default: null
  },
  location: {
    name: { type: String, default: null },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null }
  },
  verificationMethod: {
    type: String,
    enum: ["Manual", "QR Code", "NFC", "Barcode", "GPS", "Biometric", "Mobile App"],
    default: "Manual"
  },
  recordedBy: {
    type: String,
    default: "Staff"
  },
  absenceReason: {
    type: String,
    default: null
  },
  remarks: {
    type: String,
    default: null
  }
}, { timestamps: true });

TravelAttendanceSchema.index({ travelPlanId: 1, travelerId: 1, activityId: 1 });

const TravelAttendanceModel = mongoose.model("travel_attendance", TravelAttendanceSchema);

export default TravelAttendanceModel;
