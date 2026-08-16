import BaseDeliveryAdapter from "./BaseDeliveryAdapter.js";
import { getAuthConfig } from "../../utils/authConfig.js";

let transporter = null;
let transporterInitAttempted = false;

// Reuses the exact same SMTP config (utils/authConfig.js) and real
// nodemailer transport pattern controllers/Auth.js already established for
// account emails — a new shared instance here, not a copy of Auth.js's own
// (already-working, already-tested) transporter, so this module carries
// zero risk of regressing the auth email flow.
const getTransporter = async () => {
  if (transporterInitAttempted) return transporter;
  transporterInitAttempted = true;

  const config = getAuthConfig();
  if (!config.smtpHost || !config.smtpUser || !config.smtpPass) return null;

  const nodemailer = (await import("nodemailer")).default;
  transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: { user: config.smtpUser, pass: config.smtpPass }
  });
  return transporter;
};

class EmailDeliveryAdapter extends BaseDeliveryAdapter {
  constructor() {
    super("Email");
  }

  async send({ to, subject, body, attachment }) {
    if (!to) return { status: "Failed", providerResponse: null, failureReason: "No email address available for this recipient." };

    const client = await getTransporter();
    if (!client) return { status: "NotConfigured", providerResponse: null, failureReason: "SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS)." };

    const config = getAuthConfig();
    try {
      const info = await client.sendMail({
        from: config.emailFrom,
        to,
        subject,
        html: body,
        attachments: attachment ? [{ filename: attachment.filename, content: attachment.buffer, contentType: attachment.contentType }] : undefined
      });
      return { status: "Sent", providerResponse: { messageId: info.messageId }, failureReason: null };
    } catch (error) {
      return { status: "Failed", providerResponse: null, failureReason: error.message };
    }
  }

  async checkHealth() {
    const client = await getTransporter();
    if (!client) return { channel: "Email", status: "NOT_CONFIGURED" };
    try {
      await client.verify();
      return { channel: "Email", status: "UP" };
    } catch (error) {
      return { channel: "Email", status: "DOWN", error: error.message };
    }
  }
}

export default EmailDeliveryAdapter;
