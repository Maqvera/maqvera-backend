import mongoose from "mongoose";

// Package Pricing Engine — PRD §8 "Services" (Laundry, Meals, Insurance,
// Zamzam, SIM/eSIM, Guide, VIP, Ziyarat, Lounge, Excursions, Photography,
// Custom — unlimited, admin-defined, never a hardcoded list). `chargeBasis`
// drives how PackagePricingService divides `amount` across a room-wise
// matrix row (see utils/packagePricingConfig.js's serviceChargeBasisTypes).
const ServiceRateSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, required: true, trim: true },
  chargeBasis: { type: String, required: true },
  currency: { type: String, required: true, uppercase: true },
  amount: { type: Number, required: true, min: 0 },
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

ServiceRateSchema.index({ tenantId: 1, name: 1 });
ServiceRateSchema.index({ tenantId: 1, status: 1 });

ServiceRateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ServiceRateModel = mongoose.model("service_rate", ServiceRateSchema);

export default ServiceRateModel;
