import InAppNotificationModel from "../models/InAppNotificationModel.js";
import { pushNotificationToUser, pushUnreadCountToUser } from "./NotificationSocketServer.js";

/**
 * Enterprise In-App Notification Platform Service (Part 6).
 * "Store Before Deliver": every call to createNotification() persists the
 * row FIRST — the durable, authoritative record a client reads on open —
 * then best-effort pushes it live if the recipient is currently connected.
 * A missed/never-attempted push is never data loss.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
class InAppNotificationService {
  static async createNotification({
    tenantId,
    userId,
    category,
    title,
    body = null,
    actionUrl = null,
    groupKey = null,
    sourceEvent = null,
    expiresAt = null
  }) {
    if (!tenantId || !userId || !category || !title) {
      throw new Error("tenantId, userId, category, and title are required.");
    }

    const notification = await InAppNotificationModel.create({
      tenantId, userId: String(userId), category, title, body, actionUrl, groupKey, sourceEvent, expiresAt
    });

    const payload = notification.toJSON();
    pushNotificationToUser(tenantId, String(userId), payload);

    const unreadCount = await this.getUnreadCount({ tenantId, userId });
    pushUnreadCountToUser(tenantId, String(userId), unreadCount);

    return payload;
  }

  static async listNotifications({ tenantId, userId, status = null, page = 1, limit = 20 }) {
    if (!tenantId || !userId) throw new Error("tenantId and userId are required.");

    const query = { tenantId, userId: String(userId) };
    if (status) query.status = status;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      InAppNotificationModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      InAppNotificationModel.countDocuments(query)
    ]);

    return { data, total, page: Number(page), limit: Number(limit) };
  }

  static async getUnreadCount({ tenantId, userId }) {
    if (!tenantId || !userId) throw new Error("tenantId and userId are required.");
    return InAppNotificationModel.countDocuments({ tenantId, userId: String(userId), status: "unread" });
  }

  static async markAsRead({ tenantId, userId, notificationId }) {
    if (!tenantId || !userId || !notificationId) throw new Error("tenantId, userId, and notificationId are required.");

    const notification = await InAppNotificationModel.findOneAndUpdate(
      { _id: notificationId, tenantId, userId: String(userId) },
      { $set: { status: "read", readAt: new Date() } },
      { new: true }
    ).lean();
    if (!notification) throw new Error(`Notification ${notificationId} not found.`);

    pushUnreadCountToUser(tenantId, String(userId), await this.getUnreadCount({ tenantId, userId }));
    return notification;
  }

  static async markAllAsRead({ tenantId, userId }) {
    if (!tenantId || !userId) throw new Error("tenantId and userId are required.");

    const result = await InAppNotificationModel.updateMany(
      { tenantId, userId: String(userId), status: "unread" },
      { $set: { status: "read", readAt: new Date() } }
    );

    pushUnreadCountToUser(tenantId, String(userId), 0);
    return { matched: result.matchedCount ?? result.n ?? 0, modified: result.modifiedCount ?? result.nModified ?? 0 };
  }

  static async archiveNotification({ tenantId, userId, notificationId }) {
    if (!tenantId || !userId || !notificationId) throw new Error("tenantId, userId, and notificationId are required.");

    const notification = await InAppNotificationModel.findOneAndUpdate(
      { _id: notificationId, tenantId, userId: String(userId) },
      { $set: { status: "archived" } },
      { new: true }
    ).lean();
    if (!notification) throw new Error(`Notification ${notificationId} not found.`);
    return notification;
  }
}

export default InAppNotificationService;
