import mongoose from "mongoose";

const TravelNoteSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  travelPlanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "travel_plan",
    required: true,
    index: true
  },
  noteId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  content: {
    type: String,
    required: true
  },
  visibility: {
    type: String,
    enum: ["Internal", "Operations", "Management", "Customer Visible", "Private"],
    default: "Internal",
    index: true
  },
  mentions: [
    {
      type: String
    }
  ],
  authorId: {
    type: String,
    required: true
  },
  authorName: {
    type: String,
    default: "Staff"
  },
  editHistory: [
    {
      editedAt: { type: Date, default: Date.now },
      editedBy: { type: String, required: true },
      editedByName: { type: String, default: "Staff" },
      previousTitle: { type: String },
      previousContent: { type: String },
      previousVisibility: { type: String }
    }
  ],
  isSoftDeleted: {
    type: Boolean,
    default: false,
    index: true
  }
}, { timestamps: true });

TravelNoteSchema.index({ tenantId: 1, travelPlanId: 1, isSoftDeleted: 1 });

const TravelNoteModel = mongoose.model("travel_note", TravelNoteSchema);

export default TravelNoteModel;
