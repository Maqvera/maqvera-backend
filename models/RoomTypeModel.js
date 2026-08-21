import mongoose from "mongoose";

// Package Pricing Engine — PRD §6 "Room Type & Occupancy Engine". Tenant-
// configurable room type master, replacing the hardcoded
// Single/Double/Triple/Quad/Quint enum the Excel workbooks used (Golden
// Rule 3). HotelRateModel references this by roomTypeId — only the room
// types a given hotel actually has an active rate for are ever shown to an
// agent building a package.
const RoomTypeSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, required: true, trim: true },
  // Default number of guests this room type sleeps — the divisor for
  // per-person hotel cost math (PRD §5). A package segment may still
  // override the occupancy actually used for a given room, if the agent
  // packs it differently than the default.
  defaultOccupancy: { type: Number, required: true, min: 1 },
  sortOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

RoomTypeSchema.index({ tenantId: 1, name: 1 }, { unique: true });
RoomTypeSchema.index({ tenantId: 1, active: 1, sortOrder: 1 });

RoomTypeSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const RoomTypeModel = mongoose.model("room_type", RoomTypeSchema);

export default RoomTypeModel;
