import mongoose from "mongoose";

/**
 * Enterprise In-App Notification Platform (Part 6). A real, persisted
 * unread/read/archived inbox item — "Store Before Deliver": every
 * notification is written here FIRST (the durable source of truth), then
 * best-effort pushed live over NotificationSocketServer if the recipient is
 * currently connected. A user who wasn't online still sees it the next time
 * they open their notification center — nothing is lost to a missed push.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
const InAppNotificationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: String,
    required: true,
    index: true
  },
  // Free-form label naming the source domain (e.g. "Approval",
  // "AIApproval") — not a fixed enum, since new event sources will keep
  // being wired in without needing a schema migration each time.
  category: {
    type: String,
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  body: {
    type: String,
    default: null
  },
  actionUrl: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ["unread", "read", "archived"],
    default: "unread",
    index: true
  },
  // Groups notifications about the same underlying entity (e.g.
  // "approval:<approvalId>") so a client can collapse a burst of related
  // notifications into one thread instead of listing each individually.
  groupKey: {
    type: String,
    default: null,
    index: true
  },
  sourceEvent: {
    type: String,
    default: null
  },
  readAt: {
    type: Date,
    default: null
  },
  expiresAt: {
    type: Date,
    default: null,
    index: true
  }
}, { timestamps: true });

InAppNotificationSchema.index({ tenantId: 1, userId: 1, status: 1, createdAt: -1 });
InAppNotificationSchema.index({ tenantId: 1, userId: 1, groupKey: 1 });

InAppNotificationSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const InAppNotificationModel = mongoose.model("in_app_notification", InAppNotificationSchema);

export default InAppNotificationModel;
