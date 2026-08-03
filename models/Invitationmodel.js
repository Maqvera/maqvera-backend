import mongoose from "mongoose";

const InvitationSchema = new mongoose.Schema({
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "employee",
    required: true,
    index: true
  },
  email: {
    type: String,
    required: true,
    index: true
  },
  token: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  status: {
    type: String,
    enum: ["pending", "accepted", "expired"],
    default: "pending",
    index: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  sentAt: {
    type: Date,
    default: Date.now
  },
  acceptedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

const InvitationModel = mongoose.model("invitation", InvitationSchema);

export default InvitationModel;
