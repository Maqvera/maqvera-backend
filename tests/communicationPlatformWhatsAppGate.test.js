import test from "node:test";
import assert from "node:assert/strict";
import CommunicationPlatformService from "../services/CommunicationPlatformService.js";
import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import WhatsAppConversationService from "../services/WhatsAppConversationService.js";
import CommunicationTemplateService from "../services/CommunicationTemplateService.js";
import CommunicationAuditModel from "../models/CommunicationAuditModel.js";

const tenantId = "TENANT-TEST-CPWA-001";
const phone = "+923001234567";

test("CommunicationPlatformService.requestCommunication — a free-form WhatsApp send outside the conversation window is Cancelled, never dispatched (closes the bypass around WhatsAppPlatformService's own gate)", async () => {
  const origSave = CommunicationMessageModel.prototype.save;
  const origFindOne = CommunicationMessageModel.findOne;
  const origIsOpen = WhatsAppConversationService.isWindowOpen;
  const origAuditSave = CommunicationAuditModel.prototype.save;

  try {
    CommunicationMessageModel.prototype.save = async function () { return this; };
    CommunicationMessageModel.findOne = async () => null;
    CommunicationAuditModel.prototype.save = async function () { return this; };
    WhatsAppConversationService.isWindowOpen = async () => false;

    const result = await CommunicationPlatformService.requestCommunication({
      tenantId,
      channel: "WhatsApp",
      recipient: { phone },
      content: "Hello, check out our latest offer!"
    });

    assert.equal(result.status, "Cancelled");
    assert.match(result.errorDetails.message, /required.*24-hour customer conversation window/i);
  } finally {
    CommunicationMessageModel.prototype.save = origSave;
    CommunicationMessageModel.findOne = origFindOne;
    WhatsAppConversationService.isWindowOpen = origIsOpen;
    CommunicationAuditModel.prototype.save = origAuditSave;
  }
});

test("CommunicationPlatformService.requestCommunication — a templated WhatsApp send is never subject to the conversation-window gate", async () => {
  const origSave = CommunicationMessageModel.prototype.save;
  const origFindOne = CommunicationMessageModel.findOne;
  const origIsOpen = WhatsAppConversationService.isWindowOpen;
  const origGetPublishedTemplate = CommunicationTemplateService.getPublishedTemplateForSend;
  const origAuditSave = CommunicationAuditModel.prototype.save;

  let isOpenWasCalled = false;

  try {
    CommunicationMessageModel.prototype.save = async function () { return this; };
    CommunicationMessageModel.findOne = async () => null;
    CommunicationAuditModel.prototype.save = async function () { return this; };
    WhatsAppConversationService.isWindowOpen = async () => { isOpenWasCalled = true; return false; };
    CommunicationTemplateService.getPublishedTemplateForSend = async () => ({ subjectTemplate: "", bodyTemplate: "Your booking is confirmed.", status: "Active" });

    // No delivery adapter is registered for a channel this test doesn't
    // exercise dispatch on — force a scheduled send so we only observe the
    // pre-dispatch gate, not the full provider dispatch path.
    const result = await CommunicationPlatformService.requestCommunication({
      tenantId,
      channel: "WhatsApp",
      recipient: { phone },
      templateId: "TPL-WA-1",
      templateData: {},
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });

    assert.equal(isOpenWasCalled, false, "a templateId-backed send must skip the free-form conversation-window check entirely");
    assert.equal(result.status, "Queued");
  } finally {
    CommunicationMessageModel.prototype.save = origSave;
    CommunicationMessageModel.findOne = origFindOne;
    WhatsAppConversationService.isWindowOpen = origIsOpen;
    CommunicationTemplateService.getPublishedTemplateForSend = origGetPublishedTemplate;
    CommunicationAuditModel.prototype.save = origAuditSave;
  }
});
