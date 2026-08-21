import mongoose from "mongoose";
import { VISA_CASE_STATUSES, VISA_TYPES } from "../utils/visaConstants.js";

const VisaCaseSchema = new mongoose.Schema({
  tenantId: {
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
      // Visa Module PRD §8/§12 pricing breakdown, mirroring VisaTypeModel's
      // fields. `feeAmount` remains the final billed amount for backward
      // compatibility with anything already reading it — once priced via
      // VisaService.updateApplicationPricing it equals `sellingPrice`.
      vendorCost: { type: Number, default: 0 },
      governmentFee: { type: Number, default: 0 },
      insuranceFee: { type: Number, default: 0 },
      serviceCharges: { type: Number, default: 0 },
      otherCharges: { type: Number, default: 0 },
      discount: { type: Number, default: 0 },
      sellingPrice: { type: Number, default: 0 },
      feeAmount: { type: Number, default: 0 },
      currency: { type: String, default: "USD" },
      // Multi-currency balance entry — see multi-currency-booking-and-statement-
      // requirements.md §2.4a/§7. Populated only when the application was
      // created with an explicit convertedCurrency; null otherwise.
      convertedAmount: { type: Number, default: null },
      convertedCurrency: { type: String, default: null },
      conversionRate: { type: Number, default: null },
      conversionRateId: { type: mongoose.Schema.Types.ObjectId, ref: "exchange_rate", default: null },
      conversionAsOf: { type: Date, default: null },
      // Set by VisaFinanceLinkService once a real Finance-module Invoice has
      // been issued for this application's sellingPrice — null for
      // applications never priced, or priced at 0 (nothing to bill). Same
      // pattern as BookingHeaderModel.financialSnapshot.invoiceId/invoiceNumber.
      invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "invoice", default: null },
      invoiceNumber: { type: String, default: null },
      // Set by VisaFinanceLinkService once a real Finance-module
      // AccountsPayable row has been posted for this application's
      // vendorCost — null when there's no vendor cost, or none set yet.
      payableId: { type: mongoose.Schema.Types.ObjectId, ref: "accounts_payable", default: null },
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
      rejectionReason: { type: String, default: null },
      // Carried over from the Requirement Profile at case-creation time so
      // the Business Rule Engine can reference them per document.
      requiredPages: { type: Number, default: null },
      requiresSignature: { type: Boolean, default: false },
      requiresStamp: { type: Boolean, default: false }
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
      // Visa Module PRD §11/§17 — the AP-payable vendor/agent who handled
      // this submission, distinct from `embassyName` (the destination
      // processing center, still owned by EmbassyMasterModel). Optional:
      // not every submission goes through a paid third-party vendor.
      // Denormalization pattern matches BookingHeaderModel.customerName
      // alongside customerId.
      vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "vendor", default: null },
      submissionDate: { type: Date, default: Date.now },
      trackingNumber: { type: String, default: null },
      status: { type: String, default: "submitted" },
      notes: { type: String, default: null },
      submittedBy: { type: String, default: null }
    }
  ],
  // NOT dead code (corrected from an earlier trace's assumption) —
  // SchedulingEngineService.scheduleAppointment() genuinely pushes a summary
  // row here on every appointment created, for a cheap denormalized read off
  // the case aggregate without joining VisaAppointmentModel (the real,
  // detailed appointments table — reads/list go through that one, not this
  // array). Real bug, not addressed here (out of scope for this change):
  // it is write-once — updateAppointment/recordAppointmentAttendance/
  // recordAppointmentResult never sync back to this array, so an entry here
  // goes stale (wrong status/date) the moment its appointment is rescheduled,
  // cancelled, or completed. Flagging rather than fixing to keep this diff
  // reviewable; a future change should either sync all appointment mutations
  // here too, or drop this summary array and have callers read
  // VisaAppointmentModel directly.
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

VisaCaseSchema.index({ tenantId: 1, status: 1 });
VisaCaseSchema.index({ tenantId: 1, travelerId: 1 });
VisaCaseSchema.index({ tenantId: 1, destinationCountry: 1, visaType: 1 });
VisaCaseSchema.index({ tenantId: 1, travelerId: 1, countryId: 1, visaTypeId: 1, isSoftDeleted: 1 });

const VisaCaseModel = mongoose.model("visa_case", VisaCaseSchema);

export default VisaCaseModel;
