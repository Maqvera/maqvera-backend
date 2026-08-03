import mongoose from "mongoose";

const EmployeeProfileSchema = new mongoose.Schema({
  identityId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    default: null,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  branchId: {
    type: String,
    required: true,
    index: true
  },
  departmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "department",
    required: true,
    index: true
  },
  roleIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "role",
    required: true,
    index: true
  }],
  employeeCode: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  firstName: {
    type: String,
    required: true,
    index: true
  },
  lastName: {
    type: String,
    required: true,
    index: true
  },
  email: {
    type: String,
    required: true,
    index: true
  },
  phone: {
    type: String,
    required: true,
    index: true
  },
  designation: {
    type: String,
    default: null
  },
  joiningDate: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ["pending_invitation", "active", "suspended", "inactive", "archived"],
    default: "pending_invitation",
    index: true
  },
  emergencyContact: {
    type: String,
    default: null
  },
  profilePicture: {
    type: String,
    default: null
  },
  preferredLanguage: {
    type: String,
    default: "en"
  },
  timezone: {
    type: String,
    default: "UTC"
  },
  address: {
    type: String,
    default: null
  },
  notes: {
    type: String,
    default: null
  },
  permissionOverrides: {
    grant: [{ type: String }],
    revoke: [{ type: String }]
  },
  preferences: {
    language: { type: String, default: "en" },
    timezone: { type: String, default: "UTC" },
    theme: { type: String, default: "light" },
    dashboardLayout: { type: String, default: "default" },
    notificationPreferences: { type: mongoose.Schema.Types.Mixed, default: {} },
    dateFormat: { type: String, default: "YYYY-MM-DD" },
    currencyFormat: { type: String, default: "USD" }
  }
}, { timestamps: true });

EmployeeProfileSchema.index({ tenantId: 1, branchId: 1, status: 1 });

const EmployeeProfileModel = mongoose.model("employee", EmployeeProfileSchema);

export default EmployeeProfileModel;
