import test from "node:test";
import assert from "node:assert/strict";
import { pushNotificationToUser, pushUnreadCountToUser } from "../services/NotificationSocketServer.js";

test("pushNotificationToUser — safely returns false and never throws when the recipient has no live connection", () => {
  const result = pushNotificationToUser("TENANT-X", "USER-NOT-CONNECTED", { title: "Hi" });
  assert.equal(result, false);
});

test("pushUnreadCountToUser — safely returns false and never throws when the recipient has no live connection", () => {
  const result = pushUnreadCountToUser("TENANT-X", "USER-NOT-CONNECTED", 3);
  assert.equal(result, false);
});
