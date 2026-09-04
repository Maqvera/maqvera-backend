import test from "node:test";
import assert from "node:assert/strict";
import SearchEngineService from "../services/SearchEngineService.js";
import SearchIndexModel from "../models/SearchIndexModel.js";
import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationTemplateModel from "../models/CommunicationTemplateModel.js";
import CommunicationAuditModel from "../models/CommunicationAuditModel.js";

const tenantId = "TENANT-TEST-SEARCHCOMM-001";

test("SearchIndexModel.entityType enum accepts the three new Communication entity types (Part 16 fix)", () => {
  const enumValues = SearchIndexModel.schema.path("entityType").enumValues;
  assert.ok(enumValues.includes("CommunicationMessage"));
  assert.ok(enumValues.includes("CommunicationTemplate"));
  assert.ok(enumValues.includes("CommunicationAudit"));
});

test("SearchEngineService.indexCommunicationMessage — indexes a message found by either messageId or trackingId, since Email/SMS/WhatsApp events carry trackingId", async () => {
  const origFindOne = CommunicationMessageModel.findOne;
  const origIndexEntity = SearchEngineService.indexEntity;
  let capturedQuery = null;
  let capturedEntity = null;

  try {
    CommunicationMessageModel.findOne = (query) => {
      capturedQuery = query;
      return { lean: async () => ({ tenantId, messageId: "MSG-1", trackingId: "MSG-1", channel: "Email", status: "Delivered", subject: "Your invoice", recipient: { email: "a@b.com" }, sourceModule: "Finance", provider: "Nodemailer SMTP" }) };
    };
    SearchEngineService.indexEntity = async (entity) => { capturedEntity = entity; return entity; };

    await SearchEngineService.indexCommunicationMessage({ tenantId, messageId: "MSG-1" });

    assert.deepEqual(capturedQuery.$or, [{ messageId: "MSG-1" }, { trackingId: "MSG-1" }]);
    assert.equal(capturedEntity.entityType, "CommunicationMessage");
    assert.equal(capturedEntity.module, "Communication");
    assert.equal(capturedEntity.status, "Delivered");
    assert.match(capturedEntity.title, /Email/);
    assert.equal(capturedEntity.permissionsRequired.length, 0);
  } finally {
    CommunicationMessageModel.findOne = origFindOne;
    SearchEngineService.indexEntity = origIndexEntity;
  }
});

test("SearchEngineService.indexCommunicationMessage — soft-removes from the index when the message no longer exists", async () => {
  const origFindOne = CommunicationMessageModel.findOne;
  const origRemove = SearchEngineService.removeEntity;
  let removeCalledWith = null;

  try {
    CommunicationMessageModel.findOne = () => ({ lean: async () => null });
    SearchEngineService.removeEntity = async (args) => { removeCalledWith = args; };

    await SearchEngineService.indexCommunicationMessage({ tenantId, messageId: "MSG-GONE" });

    assert.equal(removeCalledWith.entityType, "CommunicationMessage");
    assert.equal(removeCalledWith.entityId, "MSG-GONE");
  } finally {
    CommunicationMessageModel.findOne = origFindOne;
    SearchEngineService.removeEntity = origRemove;
  }
});

test("SearchEngineService.indexCommunicationTemplate — indexes a template with channel/status facets", async () => {
  const origFindOne = CommunicationTemplateModel.findOne;
  const origIndexEntity = SearchEngineService.indexEntity;
  let capturedEntity = null;

  try {
    CommunicationTemplateModel.findOne = () => ({ lean: async () => ({ tenantId, templateId: "TPL-1", name: "Booking Confirmation", channel: "Email", status: "Active", subjectTemplate: "Confirmed", bodyTemplate: "..." }) });
    SearchEngineService.indexEntity = async (entity) => { capturedEntity = entity; return entity; };

    await SearchEngineService.indexCommunicationTemplate({ tenantId, templateId: "TPL-1" });

    assert.equal(capturedEntity.entityType, "CommunicationTemplate");
    assert.match(capturedEntity.title, /Booking Confirmation/);
    assert.equal(capturedEntity.facets.channel, "Email");
  } finally {
    CommunicationTemplateModel.findOne = origFindOne;
    SearchEngineService.indexEntity = origIndexEntity;
  }
});

test("SearchEngineService.indexCommunicationAudit — indexes an audit entry", async () => {
  const origFindOne = CommunicationAuditModel.findOne;
  const origIndexEntity = SearchEngineService.indexEntity;
  let capturedEntity = null;

  try {
    CommunicationAuditModel.findOne = () => ({ lean: async () => ({ tenantId, auditId: "AUD-1", event: "CommunicationDelivered", channel: "Email", provider: "Nodemailer SMTP", messageId: "MSG-1" }) });
    SearchEngineService.indexEntity = async (entity) => { capturedEntity = entity; return entity; };

    await SearchEngineService.indexCommunicationAudit({ tenantId, auditId: "AUD-1" });

    assert.equal(capturedEntity.entityType, "CommunicationAudit");
    assert.match(capturedEntity.title, /CommunicationDelivered/);
  } finally {
    CommunicationAuditModel.findOne = origFindOne;
    SearchEngineService.indexEntity = origIndexEntity;
  }
});
