import test from "node:test";
import assert from "node:assert/strict";
import CommunicationPlatformService from "../services/CommunicationPlatformService.js";
import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import LegalHoldModel from "../models/LegalHoldModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import RetentionPolicyModel from "../models/RetentionPolicyModel.js";
import EventRegistryModel from "../models/EventRegistryModel.js";
import { resolveRetentionYears } from "../utils/retentionPolicy.js";

const tenantId = "TENANT-TEST-COMMRETENTION-001";
const messageId = "MSG-RETENTION-1";

// publishVersionedEvent (used internally by archivalService.js/legalHold.js)
// registers the event's (name, version) against a real EventRegistryModel
// row before publishing — mocked here purely to avoid a live-DB dependency
// in this unit test, not because the registration logic itself is under test.
function mockEventRegistry() {
  const origFindOne = EventRegistryModel.findOne;
  const origCreate = EventRegistryModel.create;
  EventRegistryModel.findOne = async () => null;
  EventRegistryModel.create = async (doc) => ({ ...doc, toJSON: () => doc });
  return () => { EventRegistryModel.findOne = origFindOne; EventRegistryModel.create = origCreate; };
}

test("CommunicationMessageModel/CommunicationAuditModel carry the standard retention/legal-hold fields", async () => {
  const { default: CommunicationAuditModel } = await import("../models/CommunicationAuditModel.js");
  const fields = ["isArchived", "archivedAt", "archivedBy", "archiveReason", "purgeEligibleAt", "retentionPolicy", "legalHold", "legalHoldReason"];
  for (const field of fields) {
    assert.ok(CommunicationMessageModel.schema.paths[field], `CommunicationMessageModel is missing "${field}"`);
    assert.ok(CommunicationAuditModel.schema.paths[field], `CommunicationAuditModel is missing "${field}"`);
  }
});

test("resolveRetentionYears — CommunicationMessage/CommunicationAudit resolve to real configured defaults, not the generic fallback, when nothing is explicitly registered", async () => {
  const origRetentionFindOne = RetentionPolicyModel.findOne;
  try {
    RetentionPolicyModel.findOne = () => ({ lean: async () => null });

    const messageYears = await resolveRetentionYears("TENANT-WITH-NO-REGISTERED-POLICY", "CommunicationMessage");
    assert.equal(messageYears.retentionYears, 2);
    assert.equal(messageYears.policyCode, null);

    const auditYears = await resolveRetentionYears("TENANT-WITH-NO-REGISTERED-POLICY", "CommunicationAudit");
    assert.equal(auditYears.retentionYears, 10);
  } finally {
    RetentionPolicyModel.findOne = origRetentionFindOne;
  }
});

test("CommunicationPlatformService.archiveMessage — archives via the shared archival engine, sets purgeEligibleAt from the real resolved retention policy", async () => {
  const origFindOne = CommunicationMessageModel.findOne;
  const origAuditLogCreate = AuditLogModel.create;
  const origRetentionFindOne = RetentionPolicyModel.findOne;
  const restoreEventRegistry = mockEventRegistry();

  const doc = {
    tenantId, messageId, status: "Delivered", isArchived: false, purgeEligibleAt: null,
    save: async function () { return this; }
  };

  try {
    CommunicationMessageModel.findOne = async () => doc;
    AuditLogModel.create = async () => {};
    RetentionPolicyModel.findOne = () => ({ lean: async () => null });

    const result = await CommunicationPlatformService.archiveMessage({ tenantId, messageId, reason: "Retention sweep", userId: "USER-1" });

    assert.equal(result.isArchived, true);
    assert.equal(result.archivedBy, "USER-1");
    assert.ok(result.purgeEligibleAt instanceof Date);
    // 2-year default for CommunicationMessage -> purgeEligibleAt roughly 2 years out.
    const yearsOut = (result.purgeEligibleAt.getFullYear() - new Date().getFullYear());
    assert.ok(yearsOut >= 1 && yearsOut <= 2, `expected ~2 years retention, got ${yearsOut}`);
  } finally {
    CommunicationMessageModel.findOne = origFindOne;
    AuditLogModel.create = origAuditLogCreate;
    RetentionPolicyModel.findOne = origRetentionFindOne;
    restoreEventRegistry();
  }
});

test("CommunicationPlatformService.purgeMessage — refuses to purge a message under legal hold", async () => {
  const origFindOne = CommunicationMessageModel.findOne;
  try {
    CommunicationMessageModel.findOne = () => ({
      lean: async () => ({ tenantId, messageId, isArchived: true, legalHold: true, legalHoldReason: "Fraud investigation", purgeEligibleAt: new Date("2020-01-01") })
    });

    await assert.rejects(
      async () => CommunicationPlatformService.purgeMessage({ tenantId, messageId, approvedBy: "ADMIN-1" }),
      /under legal hold and cannot be purged/
    );
  } finally {
    CommunicationMessageModel.findOne = origFindOne;
  }
});

test("CommunicationPlatformService.purgeMessage — refuses without an approvedBy (a secure purge must be explicitly approved)", async () => {
  await assert.rejects(
    async () => CommunicationPlatformService.purgeMessage({ tenantId, messageId }),
    /approvedBy is required/
  );
});

test("CommunicationPlatformService.applyMessageLegalHold / getMessageLegalHoldStatus — a hold applied is a hold found, using the message's own messageId as the resourceId throughout", async () => {
  const origFindOne = CommunicationMessageModel.findOne;
  const origAuditLogCreate = AuditLogModel.create;
  const origHoldCreate = LegalHoldModel.create;
  const origHoldFind = LegalHoldModel.find;
  const restoreEventRegistry = mockEventRegistry();

  const doc = { tenantId, messageId, legalHold: false, legalHoldReason: null, save: async function () { return this; } };
  const createdHolds = [];

  try {
    CommunicationMessageModel.findOne = async () => doc;
    AuditLogModel.create = async () => {};
    LegalHoldModel.create = async (data) => {
      const hold = { ...data, _id: "HOLD-1", toJSON: () => ({ ...data, _id: "HOLD-1" }) };
      createdHolds.push(hold);
      return hold;
    };
    LegalHoldModel.find = () => ({ lean: async () => createdHolds.filter((h) => h.status === "Active") });

    const applied = await CommunicationPlatformService.applyMessageLegalHold({ tenantId, messageId, reason: "Litigation hold", userId: "LEGAL-1" });
    assert.equal(applied.resourceType, "CommunicationMessage");
    assert.equal(applied.resourceId, messageId);
    assert.equal(doc.legalHold, true);

    const status = await CommunicationPlatformService.getMessageLegalHoldStatus({ tenantId, messageId });
    assert.equal(status.underLegalHold, true);
    assert.equal(status.activeHolds.length, 1);
    assert.equal(status.activeHolds[0].resourceId, messageId);
  } finally {
    CommunicationMessageModel.findOne = origFindOne;
    AuditLogModel.create = origAuditLogCreate;
    LegalHoldModel.create = origHoldCreate;
    LegalHoldModel.find = origHoldFind;
    restoreEventRegistry();
  }
});
