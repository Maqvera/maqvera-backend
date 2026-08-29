import mongoose from "mongoose";

// PRD "CRM Feature Map by Phase" Phase 2 module 17 (Lead & Marketing
// Management) — a pre-sale inquiry, deliberately NOT modeled as a
// CustomerModel row with status "lead": CustomerModel requires both email
// AND phone (models/CustomerModel.js), which a real top-of-funnel inquiry
// (a website "request a callback" form, a walk-in with only a phone number)
// often can't satisfy yet. `status`/`source` are plain strings validated
// against utils/leadConfig.js's getLeadConfig() at the Joi layer — never a
// Mongoose `enum:` — same convention as models/QuotationModel.js's `status`.
const LeadSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  firstName: {
    type: String,
    required: true
  },
  lastName: {
    type: String,
    default: null
  },
  email: {
    type: String,
    default: null,
    index: true
  },
  phone: {
    type: String,
    default: null,
    index: true
  },
  source: {
    type: String,
    required: true,
    index: true
  },
  status: {
    type: String,
    required: true,
    index: true
  },
  assignedToUserId: {
    type: String,
    default: null,
    index: true
  },
  followUpDate: {
    type: Date,
    default: null,
    index: true
  },
  // Set by services/leadFollowUpReminderScheduler.js once a reminder has
  // gone out for the CURRENT followUpDate — cleared whenever followUpDate
  // itself changes (LeadService.updateLead), so moving the date re-arms
  // the reminder instead of it staying permanently "already sent".
  followUpReminderSentAt: {
    type: Date,
    default: null
  },
  interestedInPackageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "package",
    default: null
  },
  notes: {
    type: String,
    default: null
  },
  tags: [{ type: String }],
  // Set once by LeadController's convert action; a converted lead is never
  // deleted — it stays as the pipeline's own historical record of how this
  // customer originated.
  convertedToCustomerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    default: null,
    index: true
  },
  convertedAt: {
    type: Date,
    default: null
  },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

LeadSchema.index({ tenantId: 1, status: 1 });
LeadSchema.index({ tenantId: 1, createdAt: -1 });
LeadSchema.index({ tenantId: 1, followUpDate: 1 });

LeadSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const LeadModel = mongoose.model("lead", LeadSchema);

export default LeadModel;
