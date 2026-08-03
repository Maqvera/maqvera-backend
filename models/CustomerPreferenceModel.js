import mongoose from "mongoose";

const CustomerPreferenceSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    unique: true,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  preferredLanguage: {
    type: String,
    default: "en"
  },
  preferredCurrency: {
    type: String,
    default: "USD"
  },
  preferredCommunicationChannel: {
    type: String,
    enum: ["email", "whatsapp", "sms", "phone"],
    default: "whatsapp"
  },
  communicationChannel: {
    type: String,
    enum: ["email", "whatsapp", "sms", "phone"],
    default: "whatsapp"
  },
  preferredAirline: {
    type: String,
    default: null
  },
  preferredHotelCategory: {
    type: String,
    default: null
  },
  hotelPreferences: [{
    type: String
  }],
  mealPreference: {
    type: String,
    default: "halal"
  },
  seatPreference: {
    type: String,
    default: "no_preference"
  },
  specialAssistance: {
    type: String,
    default: null
  },
  wheelchairAssistance: {
    type: Boolean,
    default: false
  },
  marketingConsent: {
    type: Boolean,
    default: false
  },
  notificationPreferences: {
    email: { type: Boolean, default: true },
    sms: { type: Boolean, default: true },
    whatsapp: { type: Boolean, default: true },
    push: { type: Boolean, default: false }
  }
}, { timestamps: true });

const CustomerPreferenceModel = mongoose.model("customer_preference", CustomerPreferenceSchema);

export default CustomerPreferenceModel;
