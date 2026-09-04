import mongoose from "mongoose";

const EmbassySubmissionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  submissionNumber: {
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
  embassyId: {
    type: String,
    default: null,
    index: true
  },
  embassyName: {
    type: String,
    required: true
  },
  // Visa Module PRD §11/§17 — the AP-payable vendor/agent who handled this
  // submission, distinct from embassyId/embassyName (the destination
  // processing center). Optional. Indexed for "Vendor Business"/"Vendor
  // Outstanding" reporting once AccountsPayableModel rows reference it too.
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "vendor",
    default: null,
    index: true
  },
  destinationCountry: {
    type: String,
    required: true,
    index: true
  },
  submissionMethod: {
    type: String,
    enum: ["Courier", "In_Person", "Online_Portal", "Agency_Drop"],
    default: "Online_Portal"
  },
  status: {
    type: String,
    enum: [
      "Draft",
      "Ready",
      "Dispatched",
      "Received",
      "Under Review",
      "Additional Documents Required",
      "Interview Required",
      "Medical Required",
      "Approved",
      "Rejected",
      "Returned",
      "Closed"
    ],
    default: "Draft",
    index: true
  },
  submissionDate: {
    type: Date,
    default: Date.now
  },
  expectedProcessingDays: {
    type: Number,
    default: 7
  },
  expectedCompletionDate: {
    type: Date
  },
  actualCompletionDate: {
    type: Date,
    default: null
  },
  assignedOfficer: {
    type: String,
    default: null
  },
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "embassy_batch",
    default: null,
    index: true
  },
  batchNumber: {
    type: String,
    default: null
  },
  courierTracking: {
    dispatchNumber: { type: String, default: null },
    courierCompany: { type: String, default: null },
    trackingNumber: { type: String, default: null },
    dispatchDate: { type: Date, default: null },
    receivedDate: { type: Date, default: null },
    returnDate: { type: Date, default: null },
    courierStatus: { type: String, default: "pending" }
  },
  slaTracking: {
    submissionTime: { type: Date, default: Date.now },
    processingTimeDays: { type: Number, default: 7 },
    decisionTime: { type: Date, default: null },
    passportReturnTime: { type: Date, default: null },
    delayDays: { type: Number, default: 0 },
    isSlaBreached: { type: Boolean, default: false },
    slaPolicyName: { type: String, default: "Standard 7-Day SLA" }
  },
  additionalDocumentRequests: [
    {
      requestNumber: { type: String, required: true },
      documentType: { type: String, required: true },
      dueDate: { type: Date, required: true },
      remarks: { type: String, default: null },
      status: { type: String, enum: ["pending", "submitted", "fulfilled"], default: "pending" },
      requestedAt: { type: Date, default: Date.now }
    }
  ],
  communicationLog: [
    {
      channel: { type: String, enum: ["Email", "Phone", "Letter", "Portal_Message", "Courier_Update", "Internal_Note"], default: "Internal_Note" },
      sender: { type: String, default: "system" },
      recipient: { type: String, default: "embassy" },
      subject: { type: String, default: null },
      body: { type: String, required: true },
      loggedAt: { type: Date, default: Date.now }
    }
  ],
  decision: {
    decision: {
      type: String,
      enum: ["Approved", "Rejected", "Returned", "Pending", "Administrative Processing", "Appeal Allowed", "none"],
      default: "none"
    },
    decisionDate: { type: Date, default: null },
    visaNumber: { type: String, default: null },
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
    remarks: { type: String, default: null },
    registeredBy: { type: String, default: null }
  },
  remarks: {
    type: String,
    default: null
  },
  referenceNumber: {
    type: String,
    default: null
  },
  isSoftDeleted: {
    type: Boolean,
    default: false,
    index: true
  }
}, { timestamps: true });

EmbassySubmissionSchema.index({ tenantId: 1, visaCaseId: 1 });

const EmbassySubmissionModel = mongoose.model("embassy_submission", EmbassySubmissionSchema);

export default EmbassySubmissionModel;
