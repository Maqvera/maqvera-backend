import test from "node:test";
import assert from "node:assert/strict";
import WhatsAppConversationService from "../services/WhatsAppConversationService.js";
import WhatsAppConversationModel from "../models/WhatsAppConversationModel.js";

const tenantId = "TENANT-TEST-WA-001";
const phone = "+923001234567";

test("WhatsAppConversationService.isWindowOpen — false when no conversation record exists (customer never messaged in)", async () => {
  const origFindOne = WhatsAppConversationModel.findOne;
  try {
    WhatsAppConversationModel.findOne = () => ({ lean: async () => null });
    const open = await WhatsAppConversationService.isWindowOpen({ tenantId, phone });
    assert.equal(open, false);
  } finally {
    WhatsAppConversationModel.findOne = origFindOne;
  }
});

test("WhatsAppConversationService.isWindowOpen — true within 24h of the customer's last inbound message, false after it expires", async () => {
  const origFindOne = WhatsAppConversationModel.findOne;
  try {
    WhatsAppConversationModel.findOne = () => ({
      lean: async () => ({ tenantId, phone, windowExpiresAt: new Date(Date.now() + 60 * 60 * 1000) })
    });
    assert.equal(await WhatsAppConversationService.isWindowOpen({ tenantId, phone }), true);

    WhatsAppConversationModel.findOne = () => ({
      lean: async () => ({ tenantId, phone, windowExpiresAt: new Date(Date.now() - 60 * 60 * 1000) })
    });
    assert.equal(await WhatsAppConversationService.isWindowOpen({ tenantId, phone }), false);
  } finally {
    WhatsAppConversationModel.findOne = origFindOne;
  }
});

test("WhatsAppConversationService.assertCanSendFreeform — throws a compliance error (mapped to 400 by the 'required' keyword) when the window is closed", async () => {
  const origFindOne = WhatsAppConversationModel.findOne;
  try {
    WhatsAppConversationModel.findOne = () => ({ lean: async () => null });
    await assert.rejects(
      async () => WhatsAppConversationService.assertCanSendFreeform({ tenantId, phone }),
      /required.*24-hour customer conversation window/i
    );
  } finally {
    WhatsAppConversationModel.findOne = origFindOne;
  }
});

test("WhatsAppConversationService.assertCanSendFreeform — does not throw when the window is open", async () => {
  const origFindOne = WhatsAppConversationModel.findOne;
  try {
    WhatsAppConversationModel.findOne = () => ({
      lean: async () => ({ tenantId, phone, windowExpiresAt: new Date(Date.now() + 60 * 60 * 1000) })
    });
    await WhatsAppConversationService.assertCanSendFreeform({ tenantId, phone });
  } finally {
    WhatsAppConversationModel.findOne = origFindOne;
  }
});

test("WhatsAppConversationService.recordInboundMessage — opens a window that expires ~24h from now", async () => {
  const origUpdate = WhatsAppConversationModel.findOneAndUpdate;
  try {
    let captured = null;
    WhatsAppConversationModel.findOneAndUpdate = async (_query, update) => {
      captured = update.$set;
      return { ...captured };
    };

    const before = Date.now();
    await WhatsAppConversationService.recordInboundMessage({ tenantId, phone });
    const expiresInMs = new Date(captured.windowExpiresAt).getTime() - before;

    assert.ok(expiresInMs > 23.9 * 60 * 60 * 1000 && expiresInMs <= 24.1 * 60 * 60 * 1000, `expected ~24h window, got ${expiresInMs}ms`);
    assert.ok(captured.lastInboundAt instanceof Date);
  } finally {
    WhatsAppConversationModel.findOneAndUpdate = origUpdate;
  }
});

test("WhatsAppConversationService.recordOutboundMessage — records activity but never extends windowExpiresAt", async () => {
  const origUpdate = WhatsAppConversationModel.findOneAndUpdate;
  try {
    let captured = null;
    WhatsAppConversationModel.findOneAndUpdate = async (_query, update) => {
      captured = update.$set;
      return { ...captured };
    };

    await WhatsAppConversationService.recordOutboundMessage({ tenantId, phone });

    assert.ok(captured.lastOutboundAt instanceof Date);
    assert.equal(Object.prototype.hasOwnProperty.call(captured, "windowExpiresAt"), false, "outbound sends must never open/extend the window — only inbound does");
  } finally {
    WhatsAppConversationModel.findOneAndUpdate = origUpdate;
  }
});
