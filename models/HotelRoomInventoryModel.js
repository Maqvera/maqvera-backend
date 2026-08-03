import mongoose from "mongoose";

const HotelRoomInventorySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  hotelCatalogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "hotel_catalog",
    required: true,
    index: true
  },
  roomNumber: {
    type: String,
    required: true,
    index: true
  },
  floor: {
    type: String,
    default: "1"
  },
  roomType: {
    type: String,
    enum: ["Single", "Double", "Twin", "Triple", "Quad", "Suite", "Family Suite", "Custom"],
    default: "Quad",
    index: true
  },
  capacity: {
    type: Number,
    required: true,
    default: 4
  },
  status: {
    type: String,
    enum: ["available", "occupied", "cleaning", "maintenance", "reserved"],
    default: "available",
    index: true
  },
  amenities: [String],
  notes: String
}, { timestamps: true });

HotelRoomInventorySchema.index({ tenantId: 1, hotelCatalogId: 1, roomNumber: 1 }, { unique: true });

const HotelRoomInventoryModel = mongoose.model("hotel_room_inventory", HotelRoomInventorySchema);

export default HotelRoomInventoryModel;
