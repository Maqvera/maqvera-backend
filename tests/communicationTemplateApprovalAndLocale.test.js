import test from "node:test";
import assert from "node:assert/strict";
import CommunicationTemplateService from "../services/CommunicationTemplateService.js";
import CommunicationTemplateModel from "../models/CommunicationTemplateModel.js";
import CommunicationTemplateVersionModel from "../models/CommunicationTemplateVersionModel.js";

const tenantId = "TENANT-TEST-TPLAPPROVAL-001";

function fakeTemplate(overrides = {}) {
  return {
    tenantId, templateId: "TPL-A", locale: "en", name: "Booking Confirmation", channel: "Email",
    subjectTemplate: "Confirmed", bodyTemplate: "Hi {{name}}", variables: ["name"],
    status: "Draft", version: 1, createdBy: null,
    submittedBy: null, submittedAt: null, approvedBy: null, approvedAt: null, rejectedBy: null, rejectionReason: null,
    ...overrides,
    save: async function () { return this; }
  };
}

test("CommunicationTemplateService.createTemplate — a new template always starts as Draft, never live", async () => {
  const origSave = CommunicationTemplateModel.prototype.save;
  const origFindOne = CommunicationTemplateModel.findOne;
  const origVersionCreate = CommunicationTemplateVersionModel.create;
  try {
    CommunicationTemplateModel.prototype.save = async function () { return this; };
    CommunicationTemplateModel.findOne = () => ({ lean: async () => null });
    CommunicationTemplateVersionModel.create = async () => {};

    const template = await CommunicationTemplateService.createTemplate({
      tenantId, name: "New Template", channel: "Email", bodyTemplate: "Hello {{name}}"
    });

    assert.equal(template.status, "Draft");
  } finally {
    CommunicationTemplateModel.prototype.save = origSave;
    CommunicationTemplateModel.findOne = origFindOne;
    CommunicationTemplateVersionModel.create = origVersionCreate;
  }
});

test("CommunicationTemplateService.updateTemplate — rejects a direct status:Active update (the only legitimate path to Active is approveTemplate)", async () => {
  await assert.rejects(
    async () => CommunicationTemplateService.updateTemplate({ tenantId, templateId: "TPL-A", updates: { status: "Active" } }),
    /cannot be set directly to "Active"/
  );
});

test("CommunicationTemplateService.submitForReview — Draft -> PendingApproval, and refuses from any other status", async () => {
  const origFindOne = CommunicationTemplateModel.findOne;
  try {
    const template = fakeTemplate({ status: "Draft" });
    CommunicationTemplateModel.findOne = async () => template;

    const result = await CommunicationTemplateService.submitForReview({ tenantId, templateId: "TPL-A", userId: "USER-1" });
    assert.equal(result.status, "PendingApproval");
    assert.equal(result.submittedBy, "USER-1");

    const activeTemplate = fakeTemplate({ status: "Active" });
    CommunicationTemplateModel.findOne = async () => activeTemplate;
    await assert.rejects(
      async () => CommunicationTemplateService.submitForReview({ tenantId, templateId: "TPL-A" }),
      /only Draft or Rejected templates can be submitted/
    );
  } finally {
    CommunicationTemplateModel.findOne = origFindOne;
  }
});

test("CommunicationTemplateService.approveTemplate — PendingApproval -> Active, refuses from any other status", async () => {
  const origFindOne = CommunicationTemplateModel.findOne;
  try {
    const template = fakeTemplate({ status: "PendingApproval" });
    CommunicationTemplateModel.findOne = async () => template;

    const result = await CommunicationTemplateService.approveTemplate({ tenantId, templateId: "TPL-A", userId: "ADMIN-1" });
    assert.equal(result.status, "Active");
    assert.equal(result.approvedBy, "ADMIN-1");
    assert.ok(result.approvedAt instanceof Date);

    const draftTemplate = fakeTemplate({ status: "Draft" });
    CommunicationTemplateModel.findOne = async () => draftTemplate;
    await assert.rejects(
      async () => CommunicationTemplateService.approveTemplate({ tenantId, templateId: "TPL-A" }),
      /only a PendingApproval template can be approved/
    );
  } finally {
    CommunicationTemplateModel.findOne = origFindOne;
  }
});

test("CommunicationTemplateService.rejectTemplate — PendingApproval -> Rejected, requires a reason", async () => {
  const origFindOne = CommunicationTemplateModel.findOne;
  try {
    const template = fakeTemplate({ status: "PendingApproval" });
    CommunicationTemplateModel.findOne = async () => template;

    await assert.rejects(
      async () => CommunicationTemplateService.rejectTemplate({ tenantId, templateId: "TPL-A", userId: "ADMIN-1" }),
      /reason is required/
    );

    const result = await CommunicationTemplateService.rejectTemplate({ tenantId, templateId: "TPL-A", userId: "ADMIN-1", reason: "Wrong tone" });
    assert.equal(result.status, "Rejected");
    assert.equal(result.rejectionReason, "Wrong tone");
  } finally {
    CommunicationTemplateModel.findOne = origFindOne;
  }
});

test("CommunicationTemplateService.updateTemplate — editing a Rejected template's content returns it to Draft (needs resubmission, not stuck Rejected forever)", async () => {
  const origFindOne = CommunicationTemplateModel.findOne;
  const origVersionCreate = CommunicationTemplateVersionModel.create;
  try {
    const template = fakeTemplate({ status: "Rejected", rejectionReason: "Typo" });
    CommunicationTemplateModel.findOne = async () => template;
    CommunicationTemplateVersionModel.create = async () => {};

    const result = await CommunicationTemplateService.updateTemplate({
      tenantId, templateId: "TPL-A", updates: { bodyTemplate: "Fixed content" }
    });

    assert.equal(result.status, "Draft");
  } finally {
    CommunicationTemplateModel.findOne = origFindOne;
    CommunicationTemplateVersionModel.create = origVersionCreate;
  }
});

test("CommunicationTemplateService.getPublishedTemplateForSend — the real send-time gate: refuses anything that isn't Active", async () => {
  const origFindOne = CommunicationTemplateModel.findOne;
  try {
    CommunicationTemplateModel.findOne = () => ({ lean: async () => fakeTemplate({ status: "PendingApproval" }) });
    await assert.rejects(
      async () => CommunicationTemplateService.getPublishedTemplateForSend({ tenantId, templateId: "TPL-A" }),
      /not Active — it must be approved before it can be used to send/
    );

    CommunicationTemplateModel.findOne = () => ({ lean: async () => fakeTemplate({ status: "Active" }) });
    const template = await CommunicationTemplateService.getPublishedTemplateForSend({ tenantId, templateId: "TPL-A" });
    assert.equal(template.status, "Active");
  } finally {
    CommunicationTemplateModel.findOne = origFindOne;
  }
});

test("CommunicationTemplateService.getTemplateById — falls back to the 'en' locale variant when the requested locale doesn't exist", async () => {
  const origFindOne = CommunicationTemplateModel.findOne;
  let callArgs = [];
  try {
    CommunicationTemplateModel.findOne = (query) => {
      callArgs.push(query);
      if (query.locale === "en") return { lean: async () => fakeTemplate({ locale: "en" }) };
      return { lean: async () => null };
    };

    const template = await CommunicationTemplateService.getTemplateById({ tenantId, templateId: "TPL-A", locale: "fr" });
    assert.equal(template.locale, "en");
    assert.equal(callArgs.length, 2);
    assert.equal(callArgs[0].locale, "fr");
    assert.equal(callArgs[1].locale, "en");
  } finally {
    CommunicationTemplateModel.findOne = origFindOne;
  }
});

test("CommunicationTemplateService.createTemplate — adding a locale variant to an existing templateId reuses the same templateId, and refuses a duplicate locale", async () => {
  const origSave = CommunicationTemplateModel.prototype.save;
  const origFindOne = CommunicationTemplateModel.findOne;
  const origVersionCreate = CommunicationTemplateVersionModel.create;
  try {
    CommunicationTemplateModel.prototype.save = async function () { return this; };
    CommunicationTemplateVersionModel.create = async () => {};

    CommunicationTemplateModel.findOne = () => ({ lean: async () => null });
    const frenchVariant = await CommunicationTemplateService.createTemplate({
      tenantId, templateId: "TPL-A", locale: "fr", name: "Confirmation de réservation", channel: "Email", bodyTemplate: "Bonjour {{name}}"
    });
    assert.equal(frenchVariant.templateId, "TPL-A");
    assert.equal(frenchVariant.locale, "fr");

    CommunicationTemplateModel.findOne = () => ({ lean: async () => fakeTemplate({ locale: "fr" }) });
    await assert.rejects(
      async () => CommunicationTemplateService.createTemplate({
        tenantId, templateId: "TPL-A", locale: "fr", name: "Dup", channel: "Email", bodyTemplate: "x"
      }),
      /already exists/
    );
  } finally {
    CommunicationTemplateModel.prototype.save = origSave;
    CommunicationTemplateModel.findOne = origFindOne;
    CommunicationTemplateVersionModel.create = origVersionCreate;
  }
});
