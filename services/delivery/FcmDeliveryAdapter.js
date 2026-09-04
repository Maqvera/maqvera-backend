import BaseDeliveryAdapter from "./BaseDeliveryAdapter.js";

let messagingClient = null;
let firebaseInitAttempted = false;

// Lazy singleton — same "only construct once, only when needed" pattern as
// EmailDeliveryAdapter.js's Nodemailer transport and SmsDeliveryAdapter.js's
// Twilio client. FCM (Firebase Cloud Messaging) covers Android + web push
// natively and can bridge to APNs for iOS through the same token-based
// send() call — a real second provider (raw APNs) is a genuine future
// addition, not built here (Part 5 fix scope: "start with FCM only").
const getMessagingClient = async () => {
  if (firebaseInitAttempted) return messagingClient;
  firebaseInitAttempted = true;

  const projectId = process.env.FCM_PROJECT_ID;
  const clientEmail = process.env.FCM_CLIENT_EMAIL;
  const privateKey = process.env.FCM_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) return null;

  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getMessaging } = await import("firebase-admin/messaging");

  const app = getApps().length > 0
    ? getApps()[0]
    : initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, "\n") }) });

  messagingClient = getMessaging(app);
  return messagingClient;
};

/**
 * Real push delivery via Firebase Cloud Messaging (the `firebase-admin` npm
 * package, actual Messaging API calls) — gated on
 * FCM_PROJECT_ID/FCM_CLIENT_EMAIL/FCM_PRIVATE_KEY. Throws no fake success
 * when unconfigured; returns "NotConfigured" honestly.
 *
 * Deep-link contract (Part 5): `deepLink: { screen, params }` travels in the
 * FCM `data` payload only — this adapter stays completely ignorant of what
 * `screen` values mean to any business module.
 */
class FcmDeliveryAdapter extends BaseDeliveryAdapter {
  constructor() {
    super("Push");
  }

  async send({ to, subject, body, deepLink = {} }) {
    if (!to) return { status: "Failed", providerResponse: null, failureReason: "No device token available for this recipient." };

    const messaging = await getMessagingClient();
    if (!messaging) return { status: "NotConfigured", providerResponse: null, failureReason: "FCM is not configured (FCM_PROJECT_ID/FCM_CLIENT_EMAIL/FCM_PRIVATE_KEY)." };

    try {
      const messageId = await messaging.send({
        token: to,
        notification: (subject || body) ? { title: subject || "Notification", body: body || "" } : undefined,
        data: {
          screen: String(deepLink.screen || ""),
          params: JSON.stringify(deepLink.params || {})
        }
      });
      return { status: "Sent", providerResponse: { messageId }, failureReason: null };
    } catch (error) {
      // FCM's own signal for a token that no longer exists (app uninstalled,
      // token rotated) — the caller (PushPlatformService) uses this to prune
      // the dead device from DeviceTokenModel rather than retrying it forever.
      const isInvalidToken = error?.code === "messaging/registration-token-not-registered" || error?.code === "messaging/invalid-registration-token";
      return { status: "Failed", providerResponse: null, failureReason: error.message, invalidToken: isInvalidToken };
    }
  }

  async checkHealth() {
    const messaging = await getMessagingClient();
    if (!messaging) return { channel: "Push", status: "NOT_CONFIGURED" };
    return { channel: "Push", status: "UP" };
  }
}

export default FcmDeliveryAdapter;
