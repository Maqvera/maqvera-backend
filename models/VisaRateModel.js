import mongoose from "mongoose";

// Package Pricing Engine — PRD §8 "Visa rate database". Pre-booking cost
// reference for the calculator, distinct from VisaTypeModel/VisaCaseModel
// (the operational visa-case-tracking domain, owned by VisaService — left
// untouched). `nationality: null` means the rate applies regardless of
// nationality.
const VisaRateSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  country: { type: String, required: true, trim: true, index: true },
  visaType: { type: String, required: true, trim: true },
  nationality: { type: String, default: null },
  currency: { type: String, required: true, uppercase: true },
  adultCost: { type: Number, required: true, min: 0 },
  childCost: { type: Number, default: null, min: 0 },
  infantCost: { type: Number, default: null, min: 0 },
  processingTime: { type: String, default: null },
  validFrom: { type: Date, default: null },
  validTo: { type: Date, default: null },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "package_supplier", default: null },
  contractRef: { type: String, default: null },
  receivedDate: { type: Date, default: null },
  notes: { type: String, default: null },
  documentUrl: { type: String, default: null },
  status: { type: String, required: true, index: true },
  source: { type: String, required: true },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

VisaRateSchema.index({ tenantId: 1, country: 1, visaType: 1, nationality: 1, validFrom: 1, validTo: 1 });
VisaRateSchema.index({ tenantId: 1, status: 1 });

VisaRateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const VisaRateModel = mongoose.model("visa_rate", VisaRateSchema);

export default VisaRateModel;
