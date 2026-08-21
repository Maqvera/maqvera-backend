import mongoose from "mongoose";

const VisaTypeSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  code: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  category: {
    type: String,
    default: "Tourism",
    index: true
  },
  description: {
    type: String,
    default: null
  },
  defaultProcessingDays: {
    type: Number,
    default: 7
  },
  defaultValidityDays: {
    type: Number,
    default: 90
  },
  // Visa Module PRD §8/§12 pricing — Vendor Cost + Government Fee +
  // Insurance + Service Charges + Other Charges - Discount = Selling Price.
  // `sellingPrice` is computed (VisaRequirementService.calculateVisaSellingPrice)
  // and stored, not derived on read, so it can be queried/reported directly.
  vendorCost: { type: Number, default: 0 },
  governmentFee: { type: Number, default: 0 },
  insuranceFee: { type: Number, default: 0 },
  serviceCharges: { type: Number, default: 0 },
  otherCharges: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  sellingPrice: { type: Number, default: 0 },
  currency: { type: String, default: "USD" },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  localization: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true });

VisaTypeSchema.index({ tenantId: 1, code: 1 }, { unique: true });

const VisaTypeModel = mongoose.model("visa_type", VisaTypeSchema);

export default VisaTypeModel;
