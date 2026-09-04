import mongoose from "mongoose";

// PRD "CRM Feature Map by Phase" Phase 4 module 40 (Pilgrim Kit Management)
// — Ihram, bags, SIM cards, guide books, distribution tracking. One real
// kit per booking (find-or-create, same convention as models/WalletModel.js's
// "one real wallet per owner/scope" — see the unique index below), with a
// per-item distribution flag rather than a whole-kit boolean, since kit
// items are typically handed out individually, not all at once.
const KitItemSchema = new mongoose.Schema({
  // Free text, not a closed enum — "Ihram"/"SIM Card"/"Guide Book"/etc. per
  // the PRD's own non-exhaustive list; a tenant may hand out different items.
  itemName: { type: String, required: true },
  quantity: { type: Number, default: 1, min: 1 },
  distributed: { type: Boolean, default: false },
  distributedAt: { type: Date, default: null },
  distributedBy: { type: String, default: null }
}, { timestamps: true });

const PilgrimKitSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "booking_header",
    required: true,
    index: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    default: null,
    index: true
  },
  items: { type: [KitItemSchema], default: [] },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

PilgrimKitSchema.index({ tenantId: 1, bookingId: 1 }, { unique: true });

PilgrimKitSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PilgrimKitModel = mongoose.model("pilgrim_kit", PilgrimKitSchema);

export default PilgrimKitModel;
