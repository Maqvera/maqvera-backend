import mongoose from "mongoose";

// PRD "CRM Feature Map by Phase" Phase 1 module 29 (Enhanced Staff & Role
// Management: "Staff attendance tracking"). Deliberately distinct from
// models/TravelAttendanceModel.js, which tracks a TRAVELER's check-in at a
// trip activity (travelPlanId/activityId) — not an employee HR clock-in/out
// system. Kept deliberately small per the PRD's own scope note: a tracked
// log, not biometric/geo-fenced attendance.
const EmployeeAttendanceSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "employee_profile",
    required: true,
    index: true
  },
  // Normalized to UTC midnight of the attendance day — one real row per
  // employee per day (see the unique index below).
  date: {
    type: Date,
    required: true,
    index: true
  },
  clockInAt: {
    type: Date,
    default: null
  },
  clockOutAt: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ["present", "absent", "leave", "half_day"],
    default: "present",
    index: true
  },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

EmployeeAttendanceSchema.index({ tenantId: 1, employeeId: 1, date: 1 }, { unique: true });

EmployeeAttendanceSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const EmployeeAttendanceModel = mongoose.model("employee_attendance", EmployeeAttendanceSchema);

export default EmployeeAttendanceModel;
