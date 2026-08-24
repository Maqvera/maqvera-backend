import test from "node:test";
import assert from "node:assert/strict";
import WhatsAppPlatformService from "../services/WhatsAppPlatformService.js";
import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationTemplateService from "../services/CommunicationTemplateService.js";
import WhatsAppConversationService from "../services/WhatsAppConversationService.js";
import WhatsAppDeliveryAdapter from "../services/delivery/WhatsAppDeliveryAdapter.js";
import CommunicationAuditModel from "../models/CommunicationAuditModel.js";

const tenantId = "TENANT-TEST-WAPLATFORM-001";
const phone = "+923001234567";

test("WhatsAppPlatformService.sendWhatsApp — refuses a free-form send outside the conversation window (compliance gate), never silently sends", async () => {
  const origSave = CommunicationMessageModel.prototype.save;
  const origFindOne = CommunicationMessageModel.findOne;
  const origAssert = WhatsAppConversationService.assertCanSendFreeform;
  const origSend = WhatsAppDeliveryAdapter.prototype.send;

  let sendWasCalled = false;

  try {
    CommunicationMessageModel.prototype.save = async function () { return this; };
    CommunicationMessageModel.findOne = async () => null;
    WhatsAppConversationService.assertCanSendFreeform = async () => {
      throw new Error(`An approved WhatsApp template is required to message ${phone}: no open 24-hour customer conversation window (Meta's WhatsApp Business policy prohibits free-form business-initiated messages outside this window).`);
    };
    WhatsAppDeliveryAdapter.prototype.send = async function () { sendWasCalled = true; return { status: "Sent" }; };

    await assert.rejects(
      async () => WhatsAppPlatformService.sendWhatsApp({ tenantId, phone, content: "Hi there, check out our new package!" }),
      /required.*24-hour/i
    );

    assert.equal(sendWasCalled, false, "the provider must never be called once the compliance gate rejects the send");
  } finally {
    CommunicationMessageModel.prototype.save = origSave;
    CommunicationMessageModel.findOne = origFindOne;
    WhatsAppConversationService.assertCanSendFreeform = origAssert;
    WhatsAppDeliveryAdapter.prototype.send = origSend;
  }
});

test("WhatsAppPlatformService.sendWhatsApp — a templated send bypasses the conversation-window check and delivers", async () => {
  const origSave = CommunicationMessageModel.prototype.save;
  const origFindOne = CommunicationMessageModel.findOne;
  const origAssert = WhatsAppConversationService.assertCanSendFreeform;
  const origRecordOutbound = WhatsAppConversationService.recordOutboundMessage;
  const origGetPublishedTemplate = CommunicationTemplateService.getPublishedTemplateForSend;
  const origSend = WhatsAppDeliveryAdapter.prototype.send;
  const origAuditSave = CommunicationAuditModel.prototype.save;

  let assertWasCalled = false;
  let recordOutboundCalled = false;

  try {
    CommunicationMessageModel.prototype.save = async function () { return this; };
    CommunicationMessageModel.findOne = async () => null;
    CommunicationAuditModel.prototype.save = async function () { return this; };
    WhatsAppConversationService.assertCanSendFreeform = async () => { assertWasCalled = true; };
    WhatsAppConversationService.recordOutboundMessage = async () => { recordOutboundCalled = true; };
    CommunicationTemplateService.getPublishedTemplateForSend = async () => ({ bodyTemplate: "Your booking {{ref}} is confirmed.", status: "Active" });
    WhatsAppDeliveryAdapter.prototype.send = async function () { return { status: "Sent", providerResponse: { sid: "SM123" } }; };

    const result = await WhatsAppPlatformService.sendWhatsApp({
      tenantId, phone, templateId: "TPL-WA-1", templateData: { ref: "BK-1001" }
    });

    assert.equal(assertWasCalled, false, "a templated send must never go through the free-form compliance gate");
    assert.equal(result.status, "Delivered");
    assert.equal(recordOutboundCalled, true);
  } finally {
    CommunicationMessageModel.prototype.save = origSave;
    CommunicationMessageModel.findOne = origFindOne;
    WhatsAppConversationService.assertCanSendFreeform = origAssert;
    WhatsAppConversationService.recordOutboundMessage = origRecordOutbound;
    CommunicationTemplateService.getPublishedTemplateForSend = origGetPublishedTemplate;
    WhatsAppDeliveryAdapter.prototype.send = origSend;
    CommunicationAuditModel.prototype.save = origAuditSave;
  }
});

test("WhatsAppPlatformService.sendWhatsApp — a free-form send inside an open window delivers normally", async () => {
  const origSave = CommunicationMessageModel.prototype.save;
  const origFindOne = CommunicationMessageModel.findOne;
  const origAssert = WhatsAppConversationService.assertCanSendFreeform;
  const origRecordOutbound = WhatsAppConversationService.recordOutboundMessage;
  const origSend = WhatsAppDeliveryAdapter.prototype.send;
  const origAuditSave = CommunicationAuditModel.prototype.save;

  try {
    CommunicationMessageModel.prototype.save = async function () { return this; };
    CommunicationMessageModel.findOne = async () => null;
    CommunicationAuditModel.prototype.save = async function () { return this; };
    WhatsAppConversationService.assertCanSendFreeform = async () => {}; // window open — does not throw
    WhatsAppConversationService.recordOutboundMessage = async () => {};
    WhatsAppDeliveryAdapter.prototype.send = async function () { return { status: "Sent", providerResponse: { sid: "SM124" } }; };

    const result = await WhatsAppPlatformService.sendWhatsApp({ tenantId, phone, content: "Thanks for reaching out!" });

    assert.equal(result.status, "Delivered");
    assert.equal(result.phone, phone);
  } finally {
    CommunicationMessageModel.prototype.save = origSave;
    CommunicationMessageModel.findOne = origFindOne;
    WhatsAppConversationService.assertCanSendFreeform = origAssert;
    WhatsAppConversationService.recordOutboundMessage = origRecordOutbound;
    WhatsAppDeliveryAdapter.prototype.send = origSend;
    CommunicationAuditModel.prototype.save = origAuditSave;
  }
});

test("WhatsAppPlatformService.sendWhatsApp — rejects an invalid phone number before touching the conversation window or provider", async () => {
  await assert.rejects(
    async () => WhatsAppPlatformService.sendWhatsApp({ tenantId, phone: "not-a-phone", content: "Hi" }),
    /Invalid phone number format/
  );
});
