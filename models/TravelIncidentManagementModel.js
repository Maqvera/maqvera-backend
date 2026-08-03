import mongoose from "mongoose";

const TravelIncidentManagementSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  branchId: {
    type: String,
    default: "default"
  },
  incidentNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  travelPlanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "travel_plan",
    required: false,
    default: null,
    index: true
  },
  visaCaseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "visa_case",
    default: null,
    index: true
  },
  visaCaseNumber: {
    type: String,
    default: null,
    index: true
  },
  sourceModule: {
    type: String,
    enum: ["Flight", "Hotel", "Transport", "Attendance", "Visa", "Finance", "Customer", "Supplier", "Guide", "Driver", "Operations", "AI Monitoring", "CRM", "HR", "Compliance"],
    default: "Visa",
    index: true
  },
  category: {
    type: String,
    default: "Operational Exception",
    index: true
  },
  severity: {
    type: String,
    enum: ["Low", "Medium", "High", "Critical", "Emergency"],
    default: "Medium",
    index: true
  },
  status: {
    type: String,
    enum: ["reported", "validated", "assigned", "in_investigation", "action_taken", "resolved", "verified", "closed", "rejected", "duplicate", "escalated", "reopened"],
    default: "reported",
    index: true
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  assignedTo: {
    type: String,
    default: null,
    index: true
  },
  assignedToName: {
    type: String,
    default: null
  },
  assignedTeam: {
    type: String,
    default: "Operations"
  },
  reportedBy: {
    type: String,
    default: null
  },
  reportedByName: {
    type: String,
    default: "Staff"
  },
  location: {
    locationId: { type: String, default: null },
    name: { type: String, default: null },
    address: { type: String, default: null },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null }
  },
  affectedTravelerIds: [
    {
      type: mongoose.Schema.Types.ObjectId
    }
  ],
  investigation: {
    evidence: [
      {
        type: { type: String, enum: ["Document", "Photo", "Video", "Audio", "Statement", "CourierReceipt", "SystemLog", "Other"], default: "Document" },
        description: { type: String, required: true },
        url: { type: String, default: null },
        gatheredBy: { type: String, default: null },
        gatheredAt: { type: Date, default: Date.now }
      }
    ],
    interviews: [
      {
        intervieweeName: { type: String, required: true },
        role: { type: String, default: "Witness" },
        summary: { type: String, required: true },
        interviewedBy: { type: String, default: null },
        interviewedAt: { type: Date, default: Date.now }
      }
    ],
    witnesses: [
      {
        name: { type: String, required: true },
        role: { type: String, default: null },
        contact: { type: String, default: null }
      }
    ],
    correctiveActions: [
      {
        action: { type: String, required: true },
        assignedTo: { type: String, default: null },
        status: { type: String, enum: ["pending", "in_progress", "completed"], default: "pending" },
        completedAt: { type: Date, default: null }
      }
    ],
    preventiveActions: [
      {
        action: { type: String, required: true },
        assignedTo: { type: String, default: null },
        status: { type: String, enum: ["pending", "in_progress", "completed"], default: "pending" },
        completedAt: { type: Date, default: null }
      }
    ],
    lessonsLearned: { type: String, default: null },
    rootCauseCategory: { type: String, enum: ["Process", "Human Error", "Supplier Failure", "Equipment Failure", "Force Majeure", "Communication Breakdown", "Other"], default: "Process" }
  },
  aiAnalysis: {
    detectedPattern: { type: String, default: null },
    riskScore: { type: Number, default: 0 },
    recommendedPreventiveActions: [{ type: String }],
    lastAnalyzedAt: { type: Date, default: null }
  },
  resolution: {
    resolutionSummary: { type: String, default: null },
    rootCause: { type: String, default: null },
    correctiveAction: { type: String, default: null },
    preventiveAction: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: String, default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: String, default: null }
  },
  attachments: [
    {
      name: { type: String, required: true },
      url: { type: String, required: true },
      mimeType: { type: String, default: "application/pdf" },
      size: { type: Number, default: 0 },
      uploadedAt: { type: Date, default: Date.now }
    }
  ],
  comments: [
    {
      authorId: { type: String, default: null },
      authorName: { type: String, default: "Staff" },
      text: { type: String, required: true },
      createdAt: { type: Date, default: Date.now }
    }
  ],
  tasks: [
    {
      taskId: { type: String, required: true },
      description: { type: String, required: true },
      assignedTo: { type: String, default: null },
      isCompleted: { type: Boolean, default: false },
      dueDate: { type: Date, default: null }
    }
  ],
  slaStatus: {
    firstResponseDueDate: { type: Date, default: null },
    firstResponseCompletedAt: { type: Date, default: null },
    firstResponseBreached: { type: Boolean, default: false },
    resolutionDueDate: { type: Date, default: null },
    resolutionCompletedAt: { type: Date, default: null },
    resolutionBreached: { type: Boolean, default: false },
    slaDueDate: { type: Date, default: null },
    isViolated: { type: Boolean, default: false }
  },
  isSoftDeleted: {
    type: Boolean,
    default: false,
    index: true
  }
}, { timestamps: true });

TravelIncidentManagementSchema.index({ tenantId: 1, visaCaseId: 1, status: 1 });
TravelIncidentManagementSchema.index({ tenantId: 1, travelPlanId: 1, status: 1 });
TravelIncidentManagementSchema.index({ tenantId: 1, category: 1, severity: 1 });

const TravelIncidentManagementModel = mongoose.model("travel_incident_management", TravelIncidentManagementSchema);

export default TravelIncidentManagementModel;
