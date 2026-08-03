import mongoose from "mongoose";

const HotelCatalogSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    index: true
  },
  city: {
    type: String,
    required: true,
    index: true
  },
  country: {
    type: String,
    default: "Saudi Arabia"
  },
  starRating: {
    type: Number,
    min: 1,
    max: 5,
    default: 5
  },
  address: {
    type: String,
    default: null
  },
  supplier: {
    type: String,
    default: "Direct Hotel Contract"
  },
  amenities: [String],
  contacts: {
    phone: String,
    email: String,
    managerName: String
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  }
}, { timestamps: true });

HotelCatalogSchema.index({ tenantId: 1, city: 1, name: 1 });

const HotelCatalogModel = mongoose.model("hotel_catalog", HotelCatalogSchema);

export default HotelCatalogModel;
