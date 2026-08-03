import mongoose from "mongoose";

const IncludedServiceSchema = new mongoose.Schema({
  serviceType: {
    type: String,
    enum: ["package", "flight", "hotel", "room", "visa", "transport", "insurance", "guide", "meals", "meal_plan", "ziyarat", "activity", "addon", "other"],
    required: true
  },
  serviceCategory: {
    type: String,
    enum: ["transportation", "accommodation", "immigration", "insurance", "tour", "food", "religious", "entertainment", "other"],
    default: "other"
  },
  serviceName: {
    type: String,
    required: true
  },
  supplierName: {
    type: String,
    default: null
  },
  costPrice: {
    type: Number,
    default: 0
  },
  sellingPrice: {
    type: Number,
    default: 0
  },
  quantity: {
    type: Number,
    default: 1
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { _id: true });

const ServiceTemplateSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  templateName: {
    type: String,
    required: true
  },
  templateCode: {
    type: String,
    required: true,
    index: true
  },
  bookingType: {
    type: String,
    enum: ["umrah", "hajj", "visa_only", "flight_only", "hotel_only", "transportation", "holiday_package", "corporate_travel", "custom_package"],
    required: true
  },
  description: {
    type: String,
    default: null
  },
  basePrice: {
    type: Number,
    default: 0
  },
  currencyId: {
    type: String,
    default: "USD"
  },
  includedServices: [IncludedServiceSchema],
  status: {
    type: String,
    enum: ["active", "draft", "archived"],
    default: "active",
    index: true
  }
}, { timestamps: true });

ServiceTemplateSchema.index({ tenantId: 1, templateCode: 1 }, { unique: true });

const ServiceTemplateModel = mongoose.model("service_template", ServiceTemplateSchema);

export default ServiceTemplateModel;
