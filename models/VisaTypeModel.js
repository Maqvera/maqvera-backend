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
