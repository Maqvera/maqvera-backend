import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Marketing Campaign System (PRD "CRM Feature Map by Phase" Phase 2 module
// 20) — same direct-controller-call convention as
// tests/packagePricingController.test.js's quotation test. Covers: segment
// resolution (only customers with the right contact field for the channel
// become recipients), permission gating, channel/template mismatch
// rejection, the send fan-out (one platform-service call per recipient,
// a per-recipient failure never aborts the rest), and analytics.

let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}

const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

const makeRes = () => ({
  statusCode: null,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const authAdmin = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin"] });

test("Marketing Campaign System: segment resolution, channel/template mismatch, permission gating, send fan-out with per-recipient failure isolation, analytics", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/MarketingCampaignController.js");
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const MarketingCampaignModel = (await import("../models/MarketingCampaignModel.js")).default;
  const MarketingCampaignRecipientModel = (await import("../models/MarketingCampaignRecipientModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const CommunicationTemplateService = (await import("../services/CommunicationTemplateService.js")).default;
  const EmailPlatformService = (await import("../services/EmailPlatformService.js")).default;

  const suffix = Date.now();
  const tenantId = `test-campaign-${suffix}`;

  const cleanupModels = [CustomerModel, MarketingCampaignModel, MarketingCampaignRecipientModel];
  t.after(async () => {
    await Promise.all(cleanupModels.map((m) => m.deleteMany({ tenantId })));
    await AuditLogModel.deleteMany({ tenantId });
  });

  const originalGetTemplate = CommunicationTemplateService.getPublishedTemplateForSend;
  t.after(() => { CommunicationTemplateService.getPublishedTemplateForSend = originalGetTemplate; });
  CommunicationTemplateService.getPublishedTemplateForSend = async ({ templateId }) => ({
    templateId, channel: templateId.includes("SMS") ? "SMS" : "Email",
    subjectTemplate: "Hello {{customerName}}", bodyTemplate: "Hi {{customerName}}, check out our new packages!", status: "Active"
  });

  const originalSendEmail = EmailPlatformService.sendEmail;
  t.after(() => { EmailPlatformService.sendEmail = originalSendEmail; });
  let sendAttempts = 0;
  EmailPlatformService.sendEmail = async ({ to }) => {
    sendAttempts += 1;
    if (to === "fail@example.com") throw new Error("Provider rejected this recipient.");
    return { trackingId: `STUB-${sendAttempts}`, status: "Delivered", recipients: [to] };
  };

  // ---- Fixtures: 2 customers with email (one of which will fail to send), 1 without email ----
  await CustomerModel.create({ tenantId, customerCode: `CUST-A-${suffix}`, firstName: "Has", lastName: "Email", email: `has.${suffix}@example.com`, phone: `+92300${suffix}A`.slice(0, 15) });
  await CustomerModel.create({ tenantId, customerCode: `CUST-B-${suffix}`, firstName: "Will", lastName: "Fail", email: "fail@example.com", phone: `+92300${suffix}B`.slice(0, 15) });
  await CustomerModel.create({ tenantId, customerCode: `CUST-C-${suffix}`, firstName: "No", lastName: "Email", email: `noemail.${suffix}@example.com`, phone: `+92300${suffix}C`.slice(0, 15) });
  // A CustomerModel document requires email — simulate "no usable contact
  // for this channel" via a blank string instead (still schema-valid),
  // which the segment resolution's $nin: [null, ""] filter must exclude.
  await CustomerModel.updateOne({ tenantId, customerCode: `CUST-C-${suffix}` }, { $set: { email: "" } });

  // ---- Permission gate ----
  const noPermRes = makeRes();
  await ctrl.CreateCampaign({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, body: { name: "Promo", channel: "Email", templateId: "TPL-PROMO" } }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  // ---- Channel/template mismatch ----
  const mismatchRes = makeRes();
  await ctrl.CreateCampaign({ auth: authAdmin(tenantId), body: { name: "Promo", channel: "WhatsApp", templateId: "TPL-PROMO" } }, mismatchRes);
  assert.equal(mismatchRes.statusCode, 400, JSON.stringify(mismatchRes.body));

  // ---- Create: segment resolves only the 2 customers with a real email ----
  const createRes = makeRes();
  await ctrl.CreateCampaign({ auth: authAdmin(tenantId), body: { name: "Promo", channel: "Email", templateId: "TPL-PROMO" } }, createRes);
  assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body));
  assert.equal(createRes.body.data.recipientCount, 2, "the customer with no email must be excluded from the segment");
  assert.equal(createRes.body.data.status, "draft");
  const campaignId = createRes.body.data._id.toString();

  const recipientCount = await MarketingCampaignRecipientModel.countDocuments({ tenantId, campaignId });
  assert.equal(recipientCount, 2);

  // ---- Send: permission gate ----
  const sendNoPermRes = makeRes();
  await ctrl.SendCampaign({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, params: { campaignId } }, sendNoPermRes);
  assert.equal(sendNoPermRes.statusCode, 403);

  // ---- Send: happy path with one recipient failing ----
  const sendRes = makeRes();
  await ctrl.SendCampaign({ auth: authAdmin(tenantId), params: { campaignId } }, sendRes);
  assert.equal(sendRes.statusCode, 200, JSON.stringify(sendRes.body));
  assert.equal(sendRes.body.data.status, "sent");
  assert.equal(sendRes.body.data.sentCount, 1);
  assert.equal(sendRes.body.data.failedCount, 1);
  assert.equal(sendAttempts, 2, "both recipients must be attempted even though one fails");

  const failedRecipient = await MarketingCampaignRecipientModel.findOne({ tenantId, campaignId, status: "failed" }).lean();
  assert.ok(failedRecipient, "the failing recipient must be recorded as failed, not silently dropped");
  assert.match(failedRecipient.error, /Provider rejected/);

  // ---- Send again from "sent" must be rejected, not silently re-send ----
  const sendAgainRes = makeRes();
  await ctrl.SendCampaign({ auth: authAdmin(tenantId), params: { campaignId } }, sendAgainRes);
  assert.equal(sendAgainRes.statusCode, 400);

  // ---- Analytics ----
  const analyticsRes = makeRes();
  await ctrl.GetCampaignAnalytics({ auth: authAdmin(tenantId), params: { campaignId } }, analyticsRes);
  assert.equal(analyticsRes.statusCode, 200);
  assert.equal(analyticsRes.body.data.byStatus.sent, 1);
  assert.equal(analyticsRes.body.data.byStatus.failed, 1);

  // ---- List ----
  const listRes = makeRes();
  await ctrl.ListCampaigns({ auth: authAdmin(tenantId), query: {} }, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.data.items.length, 1);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
