import { WebSocketServer } from "ws";
import { resolveAuthFromAccessToken, AccessTokenError } from "../middleware/authenticateAccessToken.js";
import TenantSubscriptionService from "./TenantSubscriptionService.js";

const NOTIFICATION_WS_PATH = process.env.NOTIFICATION_WS_PATH || "/ws/notifications";

const send = (ws, type, payload = {}) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
};

const connectionKey = (tenantId, userId) => `${tenantId}:${userId}`;

// One tenant+user can have several live connections (multiple browser tabs,
// desktop + mobile) — a Set per key, not a single socket, so a push reaches
// every one of them.
const connectionsByUser = new Map();

const registerConnection = (tenantId, userId, ws) => {
  const key = connectionKey(tenantId, userId);
  if (!connectionsByUser.has(key)) connectionsByUser.set(key, new Set());
  connectionsByUser.get(key).add(ws);
};

const unregisterConnection = (tenantId, userId, ws) => {
  const key = connectionKey(tenantId, userId);
  const set = connectionsByUser.get(key);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connectionsByUser.delete(key);
};

/**
 * Best-effort live push — called by InAppNotificationService AFTER the
 * notification is already durably persisted ("Store Before Deliver"). A
 * disconnected/never-connected recipient simply sees it next time they open
 * their notification center; this never being called is not data loss.
 */
export const pushNotificationToUser = (tenantId, userId, notification) => {
  const set = connectionsByUser.get(connectionKey(tenantId, String(userId)));
  if (!set || set.size === 0) return false;
  for (const ws of set) send(ws, "notification_created", { notification });
  return true;
};

export const pushUnreadCountToUser = (tenantId, userId, unreadCount) => {
  const set = connectionsByUser.get(connectionKey(tenantId, String(userId)));
  if (!set || set.size === 0) return false;
  for (const ws of set) send(ws, "unread_count", { unreadCount });
  return true;
};

/**
 * Enterprise In-App Notification Platform (Part 6) — real-time delivery
 * layer. Attached onto the raw http.Server exactly like
 * BookingVoiceSocketServer.js's own attach function (Express itself cannot
 * handle a WS upgrade) — same file, same pattern, a second path on the same
 * server rather than a second WS server/port.
 *
 * Auth reuses the SAME real JWT-verify -> subscription-enforcement ->
 * permission-resolution pipeline authenticateAccessToken's Express
 * middleware uses (middleware/authenticateAccessToken.js#resolveAuthFromAccessToken)
 * — never a second, parallel auth implementation. No extra permission check
 * beyond authentication: this is always the caller's OWN notification inbox,
 * nothing tenant-wide or another user's.
 */
export const attachNotificationSocketServer = (httpServer) => {
  const wss = new WebSocketServer({ server: httpServer, path: NOTIFICATION_WS_PATH });

  wss.on("connection", async (ws, request) => {
    // Same pause-before-any-await discipline as BookingVoiceSocketServer.js
    // — a client can send messages the instant its own `open` fires, well
    // before the auth round trip below resolves.
    ws.pause();

    let auth;
    try {
      const url = new URL(request.url, "http://localhost");
      const token = url.searchParams.get("token");
      auth = await resolveAuthFromAccessToken(token, {
        onBlocked: (tenantId, block) => {
          TenantSubscriptionService.recordBlockedRequest(tenantId, { endpoint: `WS ${NOTIFICATION_WS_PATH}`, code: block.code });
        }
      });
    } catch (error) {
      const status = error instanceof AccessTokenError ? error.status : 401;
      send(ws, "socket_error", { message: error.message || "Authentication failed.", status });
      ws.resume();
      ws.close(4001, "Unauthorized");
      return;
    }

    const userId = auth.userId || auth.id;
    if (!auth.tenantId || !userId) {
      send(ws, "socket_error", { message: "Tenant/user context is required.", status: 403 });
      ws.resume();
      ws.close(4003, "Forbidden");
      return;
    }

    registerConnection(auth.tenantId, String(userId), ws);
    send(ws, "connected", {});

    ws.on("close", () => unregisterConnection(auth.tenantId, String(userId), ws));

    ws.resume();
  });

  return wss;
};

export default attachNotificationSocketServer;
