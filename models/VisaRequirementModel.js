import mongoose from "mongoose";

const VisaRequirementSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  destinationCountry: {
    type: String,
    required: true,
    index: true
  },
  embassyId: {
    type: String,
    default: null,
    index: true
  },
  visaType: {
    type: String,
    required: true,
    index: true
  },
  nationality: {
    type: String,
    default: "ALL",
    index: true
  },
  travelerCategory: {
    type: String,
    enum: ["Adult", "Child", "Infant", "Senior", "ALL"],
    default: "Adult",
    index: true
  },
  version: {
    type: Number,
    default: 1
  },
  processingDays: {
    type: Number,
    default: 7
  },
  requiresInterview: {
    type: Boolean,
    default: false
  },
  requiresMedical: {
    type: Boolean,
    default: false
  },
  requiresBiometrics: {
    type: Boolean,
    default: false
  },
  requiresInsurance: {
    type: Boolean,
    default: false
  },
  requiredDocuments: [
    {
      documentType: { type: String, required: true },
      title: { type: String, required: true },
      description: { type: String, default: null },
      isMandatory: { type: Boolean, default: true },
      allowedFormats: [{ type: String }],
      maxFileSizeMb: { type: Number, default: 10 }
    }
  ],
  eligibilityRules: [
    {
      ruleCode: { type: String, required: true },
      ruleName: { type: String, required: true },
      description: { type: String, default: null },
      minimumPassportValidityMonths: { type: Number, default: 6 },
      allowedNationalities: [{ type: String }],
      restrictedNationalities: [{ type: String }],
      minAge: { type: Number, default: 0 },
      maxAge: { type: Number, default: 120 },
      sponsorRequired: { type: Boolean, default: false },
      returnTicketRequired: { type: Boolean, default: true },
      financialThresholdAmount: { type: Number, default: 0 }
    }
  ],
  processingRules: [
    {
      mode: { type: String, enum: ["normal", "express", "urgent", "vip", "diplomatic"], default: "normal" },
      processingDays: { type: Number, default: 7 },
      additionalFee: { type: Number, default: 0 }
    }
  ],
  validityRules: {
    visaValidityDays: { type: Number, default: 90 },
    stayDurationDays: { type: Number, default: 30 },
    entryCount: { type: String, enum: ["single", "double", "multiple"], default: "single" },
    gracePeriodDays: { type: Number, default: 0 },
    extensionAllowed: { type: Boolean, default: false },
    renewalAllowed: { type: Boolean, default: false }
  },
  fees: {
    applicationFee: { type: Number, default: 0 },
    embassyFee: { type: Number, default: 0 },
    serviceFee: { type: Number, default: 0 },
    biometricFee: { type: Number, default: 0 },
    medicalFee: { type: Number, default: 0 },
    courierFee: { type: Number, default: 0 },
    urgentFee: { type: Number, default: 0 },
    currency: { type: String, default: "USD" }
  },
  specialNotes: {
    type: String,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  }
}, { timestamps: true });

VisaRequirementSchema.index({ tenantId: 1, destinationCountry: 1, visaType: 1, nationality: 1, travelerCategory: 1, version: -1 });

const VisaRequirementModel = mongoose.model("visa_requirement", VisaRequirementSchema);

export default VisaRequirementModel;
