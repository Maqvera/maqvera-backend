import mongoose from "mongoose";

const CustomerFamilySchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Relationship types are configurable (Part 4) — validated dynamically in
  // the controller against utils/customerConfig.js's allowedFamilyRelationships,
  // not locked to a fixed Mongoose enum.
  relationship: {
    type: String,
    required: true
  },
  firstName: {
    type: String,
    required: true
  },
  lastName: {
    type: String,
    required: true
  },
  gender: {
    type: String,
    enum: ["male", "female", "other"],
    default: null
  },
  dateOfBirth: {
    type: Date,
    default: null
  },
  passportNumber: {
    type: String,
    default: null
  },
  phone: {
    type: String,
    default: null
  },
  email: {
    type: String,
    default: null
  },
  memberCustomerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    default: null
  },
  isTraveler: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    enum: ["active", "archived"],
    default: "active",
    index: true
  }
}, { timestamps: true });

const CustomerFamilyModel = mongoose.model("customer_family", CustomerFamilySchema);

export default CustomerFamilyModel;
