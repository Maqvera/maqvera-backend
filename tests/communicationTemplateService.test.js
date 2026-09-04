import test from "node:test";
import assert from "node:assert/strict";
import CommunicationTemplateService from "../services/CommunicationTemplateService.js";
import CommunicationTemplateModel from "../models/CommunicationTemplateModel.js";
import CommunicationTemplateVersionModel from "../models/CommunicationTemplateVersionModel.js";

const tenantId = "TENANT-TEST-TPL-001";

function mockFindOneResult(result) {
  return {
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  };
}

test("CommunicationTemplateService.updateTemplate — every prior version's content is preserved in history, not overwritten", async () => {
  const origTemplateFindOne = CommunicationTemplateModel.findOne;
  const origVersionCreate = CommunicationTemplateVersionModel.create;

  // Simulates history that already exists from createTemplate() having snapshotted version 1.
  const versionHistory = [
    { tenantId, templateId: "TPL-TEST-1", version: 1, bodyTemplate: "Hello {{name}}, your booking is confirmed." }
  ];

  const fakeTemplate = {
    tenantId,
    templateId: "TPL-TEST-1",
    name: "Booking Confirmation",
    channel: "Email",
    subjectTemplate: "Your booking is confirmed",
    bodyTemplate: versionHistory[0].bodyTemplate,
    variables: ["name"],
    status: "Active",
    version: 1,
    createdBy: null,
    save: async function () { return this; }
  };

  try {
    CommunicationTemplateModel.findOne = async () => fakeTemplate;
    CommunicationTemplateVersionModel.create = async (doc) => { versionHistory.push(doc); return doc; };

    const updated = await CommunicationTemplateService.updateTemplate({
      tenantId,
      templateId: "TPL-TEST-1",
      updates: { bodyTemplate: "Hi {{name}}! Your booking is confirmed." },
      userId: "USER-1"
    });

    assert.equal(updated.version, 2);
    assert.equal(updated.bodyTemplate, "Hi {{name}}! Your booking is confirmed.");

    // The bug this fixes: previously `template.version += 1; await template.save();`
    // overwrote the document in place with no history row at all — version 1's content
    // was gone the instant it was edited. Now it must still be retrievable.
    assert.equal(versionHistory.length, 2);
    assert.equal(versionHistory[0].version, 1);
    assert.equal(versionHistory[0].bodyTemplate, "Hello {{name}}, your booking is confirmed.");
    assert.equal(versionHistory[1].version, 2);
    assert.equal(versionHistory[1].bodyTemplate, "Hi {{name}}! Your booking is confirmed.");
  } finally {
    CommunicationTemplateModel.findOne = origTemplateFindOne;
    CommunicationTemplateVersionModel.create = origVersionCreate;
  }
});

test("CommunicationTemplateService.rollbackTemplate — restores a prior version's content as a new version, keeping full history", async () => {
  const origTemplateFindOne = CommunicationTemplateModel.findOne;
  const origVersionFindOne = CommunicationTemplateVersionModel.findOne;
  const origVersionCreate = CommunicationTemplateVersionModel.create;

  const versionHistory = [
    { tenantId, templateId: "TPL-TEST-2", version: 1, name: "Booking Confirmation", channel: "Email", subjectTemplate: "Confirmed", bodyTemplate: "Original content A", variables: [], status: "Active" },
    { tenantId, templateId: "TPL-TEST-2", version: 2, name: "Booking Confirmation", channel: "Email", subjectTemplate: "Confirmed", bodyTemplate: "Edited content B", variables: [], status: "Active" }
  ];

  const fakeTemplate = {
    tenantId,
    templateId: "TPL-TEST-2",
    name: "Booking Confirmation",
    channel: "Email",
    subjectTemplate: "Confirmed",
    bodyTemplate: "Edited content B",
    variables: [],
    status: "Active",
    version: 2,
    createdBy: null,
    save: async function () { return this; }
  };

  try {
    CommunicationTemplateModel.findOne = async () => fakeTemplate;
    CommunicationTemplateVersionModel.findOne = ({ version }) =>
      mockFindOneResult(versionHistory.find((v) => v.version === version) ?? null);
    CommunicationTemplateVersionModel.create = async (doc) => { versionHistory.push(doc); return doc; };

    const rolledBack = await CommunicationTemplateService.rollbackTemplate({
      tenantId,
      templateId: "TPL-TEST-2",
      toVersion: 1,
      userId: "USER-1"
    });

    assert.equal(rolledBack.bodyTemplate, "Original content A");
    assert.equal(rolledBack.version, 3);

    // Rollback itself must be recorded, not delete/rewrite anything — 3 rows total.
    assert.equal(versionHistory.length, 3);
    assert.equal(versionHistory[2].version, 3);
    assert.equal(versionHistory[2].bodyTemplate, "Original content A");
  } finally {
    CommunicationTemplateModel.findOne = origTemplateFindOne;
    CommunicationTemplateVersionModel.findOne = origVersionFindOne;
    CommunicationTemplateVersionModel.create = origVersionCreate;
  }
});

test("CommunicationTemplateService.rollbackTemplate — rejects an unknown target version", async () => {
  const origTemplateFindOne = CommunicationTemplateModel.findOne;
  const origVersionFindOne = CommunicationTemplateVersionModel.findOne;

  const fakeTemplate = {
    tenantId,
    templateId: "TPL-TEST-3",
    version: 1,
    bodyTemplate: "Content",
    save: async function () { return this; }
  };

  try {
    CommunicationTemplateModel.findOne = async () => fakeTemplate;
    CommunicationTemplateVersionModel.findOne = () => mockFindOneResult(null);

    await assert.rejects(
      async () => {
        await CommunicationTemplateService.rollbackTemplate({
          tenantId,
          templateId: "TPL-TEST-3",
          toVersion: 99
        });
      },
      /Version 99 not found/
    );
  } finally {
    CommunicationTemplateModel.findOne = origTemplateFindOne;
    CommunicationTemplateVersionModel.findOne = origVersionFindOne;
  }
});
