import mongoose from "mongoose";
import { VISA_CASE_STATUSES, VISA_TYPES } from "../utils/visaConstants.js";

const VisaCaseSchema = new mongoose.Schema({
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
  caseNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  travelerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  travelerSnapshot: {
    title: String,
    firstName: String,
    lastName: String,
    fullName: String,
    passportNumber: String,
    passportExpiry: Date,
    passportIssueCountry: String,
    gender: String,
    dateOfBirth: Date,
    nationality: String,
    phone: String,
    email: String
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "booking_header",
    default: null,
    index: true
  },
  bookingNumber: {
    type: String,
    default: null
  },
  destinationCountry: {
    type: String,
    required: true,
    index: true
  },
  countryId: { type: String, default: null, index: true },
  visaType: {
    type: String,
    required: true,
    default: VISA_TYPES.TOURIST,
    index: true
  },
  visaTypeId: { type: String, default: null, index: true },
  travelPurpose: { type: String, default: null },
  plannedTravelDate: { type: Date, default: null },
  expectedTravelDate: { type: Date, default: null },
  tags: [{ type: String }],
  workQueue: { type: String, default: "workload_queue", index: true },
  status: {
    type: String,
    default: VISA_CASE_STATUSES.INQUIRY,
    index: true
  },
  priority: {
    type: String,
    enum: ["low", "normal", "medium", "high", "vip"],
    default: "normal"
  },
  assignedTo: {
    type: String,
    default: null,
    index: true
  },
  assignedConsultantName: {
    type: String,
    default: null
  },
  embassyInfo: {
    embassyId: { type: String, default: null },
    embassyName: { type: String, default: null },
    city: { type: String, default: null },
    country: { type: String, default: null },
    submissionMethod: { type: String, enum: ["in_person", "courier", "online_portal", "agency_drop"], default: "online_portal" }
  },
  applications: [
    {
      applicationNumber: { type: String, required: true },
      visaType: { type: String, required: true },
      status: { type: String, default: "draft" },
      submissionDate: { type: Date, default: null },
      referenceNumber: { type: String, default: null },
      feeAmount: { type: Number, default: 0 },
      currency: { type: String, default: "USD" },
      notes: { type: String, default: null },
      createdBy: { type: String, default: null },
      createdAt: { type: Date, default: Date.now }
    }
  ],
  requiredDocuments: [
    {
      documentType: { type: String, required: true },
      title: { type: String, required: true },
      isMandatory: { type: Boolean, default: true },
      status: { type: String, enum: ["pending", "uploaded", "verified", "rejected", "expired"], default: "pending" },
      fileUrl: { type: String, default: null },
      objectStorageKey: { type: String, default: null },
      ocrData: mongoose.Schema.Types.Mixed,
      verificationStatus: { type: String, enum: ["unverified", "verified", "failed"], default: "unverified" },
      verifiedBy: { type: String, default: null },
      verifiedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null }
    }
  ],
  requirementProfileSnapshot: {
    profileId: { type: String, default: null },
    version: { type: Number, default: null },
    resolvedAt: { type: Date, default: null },
    processingDays: { type: Number, default: null },
    requiresInterview: { type: Boolean, default: false },
    requiresMedical: { type: Boolean, default: false },
    requiresBiometrics: { type: Boolean, default: false },
    requiresInsurance: { type: Boolean, default: false },
    eligibilityRules: { type: mongoose.Schema.Types.Mixed, default: [] },
    processingRules: { type: mongoose.Schema.Types.Mixed, default: [] },
    validityRules: { type: mongoose.Schema.Types.Mixed, default: {} },
    fees: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  embassySubmissions: [
    {
      submissionNumber: { type: String, required: true },
      embassyName: { type: String, default: null },
      submissionDate: { type: Date, default: Date.now },
      trackingNumber: { type: String, default: null },
      status: { type: String, default: "submitted" },
      notes: { type: String, default: null },
      submittedBy: { type: String, default: null }
    }
  ],
  appointments: [
    {
      appointmentType: { type: String, enum: ["biometrics", "interview", "medical", "submission", "custom"], default: "biometrics" },
      appointmentDate: { type: Date, required: true },
      location: { type: String, default: null },
      status: { type: String, enum: ["scheduled", "completed", "cancelled", "rescheduled", "no_show"], default: "scheduled" },
      referenceNumber: { type: String, default: null },
      notes: { type: String, default: null }
    }
  ],
  decision: {
    status: { type: String, enum: ["pending", "approved", "rejected", "withdrawn"], default: "pending" },
    decisionDate: { type: Date, default: null },
    visaNumber: { type: String, default: null },
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    durationOfStayDays: { type: Number, default: null },
    entriesAllowed: { type: String, enum: ["single", "double", "multiple"], default: "single" },
    rejectionReason: { type: String, default: null },
    issueCountry: { type: String, default: null }
  },
  passportTracking: {
    status: {
      type: String,
      enum: ["with_traveler", "with_agency", "submitted_to_embassy", "in_transit", "collected", "delivered"],
      default: "with_traveler"
    },
    trackingNumber: { type: String, default: null },
    courierName: { type: String, default: null },
    currentLocation: { type: String, default: null },
    lastUpdatedAt: { type: Date, default: Date.now }
  },
  incidents: [
    {
      title: { type: String, required: true },
      description: { type: String, required: true },
      severity: { type: String, enum: ["low", "medium", "high", "critical"], default: "medium" },
      status: { type: String, enum: ["open", "investigating", "resolved", "closed"], default: "open" },
      reportedAt: { type: Date, default: Date.now },
      reportedBy: { type: String, default: null }
    }
  ],
  notes: [
    {
      noteText: { type: String, required: true },
      isInternal: { type: Boolean, default: true },
      createdBy: { type: String, default: null },
      createdAt: { type: Date, default: Date.now }
    }
  ],
  timeline: [
    {
      event: { type: String, required: true },
      description: { type: String, default: null },
      statusFrom: { type: String, default: null },
      statusTo: { type: String, default: null },
      performedBy: { type: String, default: null },
      timestamp: { type: Date, default: Date.now }
    }
  ],
  attachments: [
    {
      name: { type: String, required: true },
      url: { type: String, required: true },
      objectStorageKey: { type: String, default: null },
      mimeType: { type: String, default: "application/pdf" },
      size: { type: Number, default: 0 },
      uploadedAt: { type: Date, default: Date.now }
    }
  ],
  workflow: {
    currentStep: { type: String, default: "inquiry" },
    completedSteps: [{ type: String }],
    totalSteps: { type: Number, default: 10 },
    isBlocked: { type: Boolean, default: false },
    blockReason: { type: String, default: null }
  },
  aiRecommendations: {
    riskScore: { type: Number, default: 0 },
    confidenceScore: { type: Number, default: 0 },
    recommendationText: { type: String, default: null },
    generatedAt: { type: Date, default: null }
  },
  isSoftDeleted: {
    type: Boolean,
    default: false,
    index: true
  },
  deletedAt: {
    type: Date,
    default: null
  },
  version: {
    type: Number,
    default: 1
  },
  versionHistory: [
    {
      version: Number,
      updatedBy: String,
      updatedAt: { type: Date, default: Date.now },
      changes: mongoose.Schema.Types.Mixed
    }
  ]
}, { timestamps: true });

VisaCaseSchema.index({ tenantId: 1, branchId: 1, status: 1 });
VisaCaseSchema.index({ tenantId: 1, travelerId: 1 });
VisaCaseSchema.index({ tenantId: 1, destinationCountry: 1, visaType: 1 });
VisaCaseSchema.index({ tenantId: 1, travelerId: 1, countryId: 1, visaTypeId: 1, isSoftDeleted: 1 });

const VisaCaseModel = mongoose.model("visa_case", VisaCaseSchema);

export default VisaCaseModel;
