import mongoose from "mongoose";

// Package Pricing Engine — PRD §55-§62 "Package Flyer Generator". One row
// per generated flyer image/PDF; the file itself is stored through the
// existing utils/documentPdfStorage.js abstraction (never re-generated on
// read — a flyer is a point-in-time export of whatever the package's
// roomWisePriceMatrix looked like when this was created).
const FlyerSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  packageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "package",
    required: true,
    index: true
  },
  template: { type: String, required: true },
  format: { type: String, required: true },
  dimensionPreset: { type: String, required: true },
  language: { type: String, default: "en" },
  displayCurrency: { type: String, default: null },
  // Which room-wise matrix rows this flyer includes — omit to include every
  // row the hotel(s) actually support (PRD §57 "only available occupancies appear").
  roomTypeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "room_type" }],
  fileUrl: { type: String, required: true },
  generatedAt: { type: Date, default: Date.now },
  generatedBy: { type: String, default: null }
}, { timestamps: true });

FlyerSchema.index({ tenantId: 1, packageId: 1, createdAt: -1 });

FlyerSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const FlyerModel = mongoose.model("package_flyer", FlyerSchema);

export default FlyerModel;
