import mongoose from "mongoose";

/**
 * Enterprise WhatsApp Platform — Conversation Window Schema (Part 4).
 * Tracks Meta's WhatsApp Business "24-hour customer service window" per
 * (tenant, recipient phone): free-form business-initiated messages are only
 * allowed while `windowExpiresAt` is in the future — i.e. within 24h of the
 * customer's own last INBOUND message. Outside that window, Meta requires an
 * approved message template; sending free-form text anyway risks the
 * WhatsApp Business account being suspended.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
const WhatsAppConversationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  phone: {
    type: String,
    required: true,
    index: true
  },
  lastInboundAt: {
    type: Date,
    default: null
  },
  lastOutboundAt: {
    type: Date,
    default: null
  },
  // Recomputed every time lastInboundAt advances — the single source of
  // truth `isWindowOpen()` reads (avoids recomputing "+24h" at every read
  // and keeps the window rule in exactly one place: recordInboundMessage()).
  windowExpiresAt: {
    type: Date,
    default: null,
    index: true
  }
}, { timestamps: true });

WhatsAppConversationSchema.index({ tenantId: 1, phone: 1 }, { unique: true });

WhatsAppConversationSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const WhatsAppConversationModel = mongoose.model("whatsapp_conversation", WhatsAppConversationSchema);

export default WhatsAppConversationModel;
