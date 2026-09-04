import mongoose from "mongoose";

// B2B Agent Portal — PRD "CRM Feature Map by Phase" Phase 2 module 14.
// A genuinely separate external identity (confirmed against the PDF's own
// "sub-agent hierarchy," "agent booking portal," "credit limit" language),
// NOT a new internal staff role — an Agent logs in through its own
// credential/token path (middleware/authenticateAgentToken.js), scoped to
// only its own bookings/commissions/wallet via
// utils/accessScope.js's getAgentAccessScope, never the tenant-wide
// getAccessScope every staff-facing controller uses.
//
// `email` is globally unique (not per-tenant), mirroring models/Usermodel.js's
// own email field exactly — the same "look up by email alone, tenant comes
// along with the match" pattern controllers/Auth.js's Login already uses.
const AgentSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  phone: {
    type: String,
    default: null
  },
  passwordHash: {
    type: String,
    required: true
  },
  // Self-referencing — a sub-agent's parent is another Agent on the SAME
  // tenant (cross-tenant hierarchies make no sense; enforced in the
  // controller, not the schema).
  parentAgentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "agent",
    default: null,
    index: true
  },
  creditLimit: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ["Active", "Suspended"],
    default: "Active",
    index: true
  },
  lastLoginAt: {
    type: Date,
    default: null
  },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

AgentSchema.index({ tenantId: 1, status: 1 });

AgentSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    delete ret.passwordHash;
    return ret;
  }
});

const AgentModel = mongoose.model("agent", AgentSchema);

export default AgentModel;
