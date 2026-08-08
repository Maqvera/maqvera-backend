import mongoose from "mongoose";

const TravelAttendanceSessionSchema = new mongoose.Schema({
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
    required: true,
    index: true
  },
  activityName: {
    type: String,
    required: true
  },
  attendanceWindowStart: {
    type: Date,
    required: true
  },
  attendanceWindowEnd: {
    type: Date,
    required: true
  },
  status: {
    type: String,
    enum: ["scheduled", "open", "completed", "closed"],
    default: "open",
    index: true
  },
  policy: {
    checkInWindowMinutes: { type: Number, default: 30 },
    lateThresholdMinutes: { type: Number, default: 10 },
    missingThresholdMinutes: { type: Number, default: 20 }
  }
}, { timestamps: true });

TravelAttendanceSessionSchema.index({ travelPlanId: 1, activityId: 1, tenantId: 1 });

const TravelAttendanceSessionModel = mongoose.model("travel_attendance_session", TravelAttendanceSessionSchema);

export default TravelAttendanceSessionModel;
