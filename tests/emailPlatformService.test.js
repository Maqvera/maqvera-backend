import test from "node:test";
import assert from "node:assert/strict";
import EmailPlatformService from "../services/EmailPlatformService.js";
import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationPreferenceService from "../services/CommunicationPreferenceService.js";
import { getDeliveryAdapter } from "../services/delivery/index.js";

const tenantId = "TENANT-TEST-EMAIL-001";

test("EmailPlatformService.sendEmail — a successful send is recorded with a status CommunicationMessageModel's schema actually allows ('Delivered', not the adapter-level 'Sent')", async () => {
  const origSave = CommunicationMessageModel.prototype.save;
  const origFindOne = CommunicationMessageModel.findOne;
  const origPref = CommunicationPreferenceService.canSendToUser;
  const emailRouter = getDeliveryAdapter("Email");
  const origAdapterSend = emailRouter.adapters[0].instance.send;

  try {
    CommunicationMessageModel.prototype.save = async function () { return this; };
    CommunicationMessageModel.findOne = async () => null;
    CommunicationPreferenceService.canSendToUser = async () => ({ allowed: true });
    emailRouter.adapters[0].instance.send = async () => ({ status: "Sent", providerResponse: { messageId: "MSG-1" }, failureReason: null });

    const result = await EmailPlatformService.sendEmail({
      tenantId,
      to: "customer@example.com",
      subject: "Your invoice",
      content: "Here is your invoice."
    });

    // CommunicationMessageModel.status enum is
    // ["Requested","Queued","Processing","Delivered","Failed","Retried","Cancelled"]
    // — "Sent" is not a valid value and would fail schema validation on save.
    assert.equal(result.status, "Delivered");
  } finally {
    CommunicationMessageModel.prototype.save = origSave;
    CommunicationMessageModel.findOne = origFindOne;
    CommunicationPreferenceService.canSendToUser = origPref;
    emailRouter.adapters[0].instance.send = origAdapterSend;
  }
});
