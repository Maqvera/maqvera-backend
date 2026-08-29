import mongoose from "mongoose";

// PRD "CRM Feature Map by Phase" Phase 4 module 40 (Review & Rating System)
// — post-trip customer review, hotel/package/guide/driver rating.
// `status` gates whether a review is ever shown publicly ("published on
// website" per the PRD) — a moderation step, matching this codebase's own
// document-verification-before-trust convention (e.g.
// CustomerDocumentModel's verification status).
const ReviewSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "booking_header",
    required: true,
    index: true
  },
  packageRating: { type: Number, min: 1, max: 5, default: null },
  hotelRating: { type: Number, min: 1, max: 5, default: null },
  guideRating: { type: Number, min: 1, max: 5, default: null },
  driverRating: { type: Number, min: 1, max: 5, default: null },
  comment: { type: String, default: null },
  status: {
    type: String,
    enum: ["pending", "published", "hidden"],
    default: "pending",
    index: true
  },
  moderatedBy: { type: String, default: null },
  moderatedAt: { type: Date, default: null },
  createdBy: { type: String, default: null }
}, { timestamps: true });

ReviewSchema.index({ tenantId: 1, bookingId: 1 }, { unique: true });
ReviewSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

ReviewSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ReviewModel = mongoose.model("review", ReviewSchema);

export default ReviewModel;
