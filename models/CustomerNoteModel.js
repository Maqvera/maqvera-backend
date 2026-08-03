import mongoose from "mongoose";

const CustomerNoteSchema = new mongoose.Schema({
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
  branchId: {
    type: String,
    default: null
  },
  authorId: {
    type: String,
    default: null
  },
  authorName: {
    type: String,
    default: "System"
  },
  category: {
    type: String,
    enum: ["Customer Service", "Sales", "Finance", "Visa", "Travel", "Medical", "Operations", "Support", "General"],
    default: "General",
    index: true
  },
  visibility: {
    type: String,
    enum: ["Internal", "Management", "Branch", "Private"],
    default: "Internal",
    index: true
  },
  content: {
    type: String,
    required: true
  },
  isImportant: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    enum: ["active", "archived"],
    default: "active",
    index: true
  },
  attachmentsCount: {
    type: Number,
    default: 0
  },
  attachments: [{
    fileName: String,
    fileUrl: String,
    mimeType: String,
    fileSize: Number
  }]
}, { timestamps: true });

CustomerNoteSchema.index({ customerId: 1, tenantId: 1, status: 1, createdAt: -1 });

const CustomerNoteModel = mongoose.model("customer_note", CustomerNoteSchema);

export default CustomerNoteModel;
