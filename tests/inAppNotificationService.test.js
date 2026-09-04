import test from "node:test";
import assert from "node:assert/strict";
import InAppNotificationService from "../services/InAppNotificationService.js";
import InAppNotificationModel from "../models/InAppNotificationModel.js";

const tenantId = "TENANT-TEST-NOTIF-001";
const userId = "USER-TEST-NOTIF-1";

test("InAppNotificationService.createNotification — persists the notification (Store Before Deliver) before any live push is attempted", async () => {
  const origCreate = InAppNotificationModel.create;
  const origCount = InAppNotificationModel.countDocuments;
  const created = [];

  try {
    InAppNotificationModel.create = async (doc) => ({ ...doc, _id: "NOTIF-1", status: "unread", toJSON() { return this; } });
    InAppNotificationModel.countDocuments = async () => 1;

    const result = await InAppNotificationService.createNotification({
      tenantId, userId, category: "Approval", title: "Approval required", body: "Please review.", actionUrl: "/approvals/1"
    });

    assert.equal(result.tenantId, tenantId);
    assert.equal(result.userId, userId);
    assert.equal(result.status, "unread");
    assert.equal(result.title, "Approval required");
  } finally {
    InAppNotificationModel.create = origCreate;
    InAppNotificationModel.countDocuments = origCount;
  }
});

test("InAppNotificationService.createNotification — rejects a missing required field rather than creating a malformed notification", async () => {
  await assert.rejects(
    async () => InAppNotificationService.createNotification({ tenantId, userId, category: "Approval" }),
    /required/i
  );
});

test("InAppNotificationService.listNotifications — filters by status and paginates", async () => {
  const origFind = InAppNotificationModel.find;
  const origCount = InAppNotificationModel.countDocuments;
  let capturedQuery = null;

  try {
    InAppNotificationModel.find = (query) => {
      capturedQuery = query;
      return { sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [{ _id: "N1" }, { _id: "N2" }] }) }) }) };
    };
    InAppNotificationModel.countDocuments = async () => 2;

    const result = await InAppNotificationService.listNotifications({ tenantId, userId, status: "unread", page: 1, limit: 20 });

    assert.equal(capturedQuery.status, "unread");
    assert.equal(capturedQuery.tenantId, tenantId);
    assert.equal(result.total, 2);
    assert.equal(result.data.length, 2);
  } finally {
    InAppNotificationModel.find = origFind;
    InAppNotificationModel.countDocuments = origCount;
  }
});

test("InAppNotificationService.getUnreadCount — counts only status:unread for this tenant+user", async () => {
  const origCount = InAppNotificationModel.countDocuments;
  let capturedQuery = null;
  try {
    InAppNotificationModel.countDocuments = async (query) => { capturedQuery = query; return 3; };
    const count = await InAppNotificationService.getUnreadCount({ tenantId, userId });
    assert.equal(count, 3);
    assert.deepEqual(capturedQuery, { tenantId, userId: String(userId), status: "unread" });
  } finally {
    InAppNotificationModel.countDocuments = origCount;
  }
});

test("InAppNotificationService.markAsRead — throws when the notification doesn't belong to this tenant/user (scoped, not a global lookup)", async () => {
  const origUpdate = InAppNotificationModel.findOneAndUpdate;
  try {
    InAppNotificationModel.findOneAndUpdate = () => ({ lean: async () => null });
    await assert.rejects(
      async () => InAppNotificationService.markAsRead({ tenantId, userId, notificationId: "NOTIF-404" }),
      /not found/i
    );
  } finally {
    InAppNotificationModel.findOneAndUpdate = origUpdate;
  }
});

test("InAppNotificationService.markAllAsRead — reports matched/modified counts", async () => {
  const origUpdateMany = InAppNotificationModel.updateMany;
  const origCount = InAppNotificationModel.countDocuments;
  try {
    InAppNotificationModel.updateMany = async () => ({ matchedCount: 5, modifiedCount: 5 });
    InAppNotificationModel.countDocuments = async () => 0;
    const result = await InAppNotificationService.markAllAsRead({ tenantId, userId });
    assert.equal(result.matched, 5);
    assert.equal(result.modified, 5);
  } finally {
    InAppNotificationModel.updateMany = origUpdateMany;
    InAppNotificationModel.countDocuments = origCount;
  }
});

test("InAppNotificationService.archiveNotification — moves status to archived, scoped to tenant+user", async () => {
  const origUpdate = InAppNotificationModel.findOneAndUpdate;
  let capturedQuery = null;
  let capturedUpdate = null;
  try {
    InAppNotificationModel.findOneAndUpdate = (query, update) => {
      capturedQuery = query;
      capturedUpdate = update;
      return { lean: async () => ({ _id: "NOTIF-1", status: "archived" }) };
    };
    const result = await InAppNotificationService.archiveNotification({ tenantId, userId, notificationId: "NOTIF-1" });
    assert.equal(result.status, "archived");
    assert.equal(capturedQuery.tenantId, tenantId);
    assert.equal(capturedUpdate.$set.status, "archived");
  } finally {
    InAppNotificationModel.findOneAndUpdate = origUpdate;
  }
});
