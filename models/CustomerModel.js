import mongoose from "mongoose";

const CustomerSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  branchId: {
    type: String,
    required: true,
    index: true
  },
  customerCode: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  type: {
    type: String,
    enum: ["individual", "family", "corporate", "travel_agent", "referral_partner", "walk_in", "online", "government", "ngo"],
    default: "individual",
    index: true
  },
  category: {
    type: String,
    enum: ["regular", "premium", "vip", "blacklisted", "corporate", "frequent_traveler", "loyalty_member"],
    default: "regular",
    index: true
  },
  status: {
    type: String,
    enum: ["lead", "qualified_lead", "customer", "traveler", "repeat_traveler", "vip_customer", "active", "inactive", "archived"],
    default: "active",
    index: true
  },
  title: {
    type: String,
    default: null
  },
  firstName: {
    type: String,
    required: true,
    index: true
  },
  middleName: {
    type: String,
    default: null
  },
  lastName: {
    type: String,
    required: true,
    index: true
  },
  companyName: {
    type: String,
    default: null
  },
  email: {
    type: String,
    required: true,
    index: true
  },
  phone: {
    type: String,
    required: true,
    index: true
  },
  alternatePhone: {
    type: String,
    default: null
  },
  nationalId: {
    type: String,
    default: null,
    index: true
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
  maritalStatus: {
    type: String,
    enum: ["single", "married", "divorced", "widowed"],
    default: null
  },
  nationality: {
    type: String,
    default: null
  },
  preferredLanguage: {
    type: String,
    default: "en"
  },
  preferredCurrency: {
    type: String,
    default: "USD"
  },
  marketingConsent: {
    type: Boolean,
    default: false
  },
  profilePhoto: {
    type: String,
    default: null
  },
  timezone: {
    type: String,
    default: "UTC"
  },
  address: {
    street: { type: String, default: null },
    city: { type: String, default: null },
    state: { type: String, default: null },
    postalCode: { type: String, default: null },
    country: { type: String, default: null }
  },
  // A customer can have multiple phones/emails/addresses (Business Rules,
  // Part 1). `phone`/`email`/`address` above stay as the flat "primary"
  // projection so existing list/search/duplicate-detection code keeps
  // working unchanged; these arrays hold the full detail and are the
  // source of truth once a customer has more than one of any of them.
  phones: [{
    number: { type: String, required: true },
    label: { type: String, enum: ["mobile", "home", "work", "other"], default: "mobile" },
    isPrimary: { type: Boolean, default: false }
  }],
  emails: [{
    address: { type: String, required: true },
    label: { type: String, enum: ["personal", "work", "other"], default: "personal" },
    isPrimary: { type: Boolean, default: false }
  }],
  addresses: [{
    type: { type: String, enum: ["home", "work", "billing", "mailing", "other"], default: "home" },
    street: { type: String, default: null },
    city: { type: String, default: null },
    state: { type: String, default: null },
    postalCode: { type: String, default: null },
    country: { type: String, default: null },
    isPrimary: { type: Boolean, default: false }
  }],
  passports: [{
    passportNumber: { type: String, required: true },
    countryId: { type: String, default: null },
    countryOfIssue: { type: String, default: null },
    issueDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null },
    placeOfIssue: { type: String, default: null },
    isPrimary: { type: Boolean, default: true },
    status: { type: String, enum: ["active", "expiring_soon", "expired", "cancelled", "lost", "renewed"], default: "active" }
  }],
  emergencyContacts: [{
    name: String,
    relationship: String,
    phone: String,
    email: String
  }],
  mahramInformation: {
    relationship: { type: String, default: null },
    mahramCustomerId: { type: String, default: null },
    name: { type: String, default: null }
  },
  medicalInformation: {
    bloodGroup: { type: String, default: null },
    allergies: [{ type: String }],
    medicalConditions: [{ type: String }],
    specialAssistance: { type: String, default: null }
  },
  assignedTo: {
    type: String,
    default: null,
    index: true
  },
  lastBookingDate: {
    type: Date,
    default: null
  },
  completenessScore: {
    type: Number,
    default: 0
  },
  healthScore: {
    type: String,
    enum: ["Excellent", "Good", "Average", "Poor"],
    default: "Good"
  },
  tags: [{
    type: String,
    index: true
  }],
  notes: {
    type: String,
    default: null
  },
  versions: [{
    version: { type: Number, required: true },
    changedAt: { type: Date, default: Date.now },
    changedBy: { type: String, default: null },
    snapshot: { type: mongoose.Schema.Types.Mixed }
  }]
}, { timestamps: true });

CustomerSchema.index({ tenantId: 1, email: 1 });
CustomerSchema.index({ tenantId: 1, phone: 1 });
CustomerSchema.index({ tenantId: 1, nationalId: 1 });
CustomerSchema.index({ tenantId: 1, status: 1, branchId: 1 });
CustomerSchema.index({ tenantId: 1, createdAt: -1 });
CustomerSchema.index({ tenantId: 1, "phones.number": 1 });
CustomerSchema.index({ tenantId: 1, "emails.address": 1 });

// Ranked full-text search backing GET /customers/search (Part 3). MongoDB
// only permits one text index per collection, so every fuzzy-searchable
// field is combined here with relevance weights; exact-identifier fields
// (phone/customerCode/nationalId/passport number) are matched separately
// via regex in the controller since text indexes don't do substring matches.
CustomerSchema.index(
  { firstName: "text", lastName: "text", companyName: "text", tags: "text" },
  { name: "customer_search_text_index", weights: { firstName: 10, lastName: 10, companyName: 5, tags: 3 } }
);

const CustomerModel = mongoose.model("customer", CustomerSchema);

export default CustomerModel;
