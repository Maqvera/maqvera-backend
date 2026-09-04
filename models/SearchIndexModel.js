import mongoose from "mongoose";

const SearchIndexSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  entityType: {
    type: String,
    enum: [
      "TravelPlan",
      "Booking",
      "Customer",
      "Traveler",
      "Flight",
      "Hotel",
      "Transport",
      "ItineraryActivity",
      "Attendance",
      "Incident",
      "Task",
      "Note",
      "TimelineEvent",
      "Document",
      "Visa",
      "VisaCase",
      "Passport",
      "EmbassySubmission",
      "Appointment",
      "Invoice",
      "Payment",
      "Receipt",
      "JournalEntry",
      "GLAccount",
      "Vendor",
      "Expense",
      "BankAccount",
      "AuditEvent",
      "FinancialReport",
      "ReportSchedule",
      "CommunicationMessage",
      "CommunicationTemplate",
      "CommunicationAudit"
    ],
    required: true,
    index: true
  },
  entityId: {
    type: String,
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ""
  },
  keywords: [
    {
      type: String,
      index: true
    }
  ],
  matchedFields: [
    {
      field: { type: String },
      value: { type: String }
    }
  ],
  module: {
    type: String,
    required: true,
    index: true
  },
  status: {
    type: String,
    default: "Active",
    index: true
  },
  facets: { type: mongoose.Schema.Types.Mixed, default: {} },
  navigationUrl: {
    type: String,
    required: true
  },
  permissionsRequired: [
    {
      type: String
    }
  ],
  relevanceBaseScore: {
    type: Number,
    default: 100
  },
  isSoftDeleted: {
    type: Boolean,
    default: false,
    index: true
  }
}, { timestamps: true });

SearchIndexSchema.index({ tenantId: 1, entityType: 1, entityId: 1 }, { unique: true });
SearchIndexSchema.index({ tenantId: 1, entityType: 1, status: 1, isSoftDeleted: 1 });
SearchIndexSchema.index({ title: "text", description: "text", "keywords": "text" });

const SearchIndexModel = mongoose.model("search_index", SearchIndexSchema);

export default SearchIndexModel;
