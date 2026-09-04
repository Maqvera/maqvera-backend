import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import ReportTemplateService from "../services/ReportTemplateService.js";
import ReportTemplateModel from "../models/ReportTemplateModel.js";

const tenantId = "TENANT-TEST-REPORTTEMPLATE-001";

test("ReportTemplateService.resolveTemplate — returns null with no live Mongo connection (readyState guard), never throws", async () => {
  assert.notEqual(mongoose.connection?.readyState, 1, "this test assumes no live DB connection, matching the rest of this suite");
  const result = await ReportTemplateService.resolveTemplate({ tenantId, reportType: "TrialBalance", locale: "en" });
  assert.equal(result, null);
});

test("ReportTemplateService.resolveTemplate — returns null when tenantId or reportType is missing, without touching the DB", async () => {
  assert.equal(await ReportTemplateService.resolveTemplate({ tenantId: null, reportType: "TrialBalance" }), null);
  assert.equal(await ReportTemplateService.resolveTemplate({ tenantId, reportType: null }), null);
});

test("ReportTemplateService.createTemplate — rejects a duplicate tenantId+templateKey+locale combination", async () => {
  const origFindOne = ReportTemplateModel.findOne;
  const origCreate = ReportTemplateModel.create;
  try {
    ReportTemplateModel.findOne = () => ({ lean: () => Promise.resolve({ tenantId, templateKey: "financial_report", locale: "en" }) });
    ReportTemplateModel.create = async () => { throw new Error("should not be called"); };

    await assert.rejects(
      () => ReportTemplateService.createTemplate({ tenantId, templateKey: "financial_report", reportType: "TrialBalance", htmlBody: "<html></html>" }),
      /already exists/
    );
  } finally {
    ReportTemplateModel.findOne = origFindOne;
    ReportTemplateModel.create = origCreate;
  }
});

test("ReportTemplateService.createTemplate — creates a new Draft template at version 1", async () => {
  const origFindOne = ReportTemplateModel.findOne;
  const origCreate = ReportTemplateModel.create;
  try {
    ReportTemplateModel.findOne = () => ({ lean: () => Promise.resolve(null) });
    let created = null;
    ReportTemplateModel.create = async (doc) => { created = { ...doc }; return created; };

    const template = await ReportTemplateService.createTemplate({
      tenantId, templateKey: "financial_report", reportType: "TrialBalance", htmlBody: "<html>{{title}}</html>", userId: "user-1"
    });

    assert.equal(template.status, "Draft");
    assert.equal(template.version, 1);
    assert.equal(created.locale, "en");
  } finally {
    ReportTemplateModel.findOne = origFindOne;
    ReportTemplateModel.create = origCreate;
  }
});

test("ReportTemplateService.updateTemplate — bumps the version on every edit", async () => {
  const origFindOne = ReportTemplateModel.findOne;
  try {
    const fakeTemplate = { tenantId, templateKey: "financial_report", locale: "en", htmlBody: "<html>old</html>", version: 1, save: async function () { return this; } };
    ReportTemplateModel.findOne = async () => fakeTemplate;

    const updated = await ReportTemplateService.updateTemplate({ tenantId, templateKey: "financial_report", htmlBody: "<html>new</html>", userId: "user-1" });
    assert.equal(updated.htmlBody, "<html>new</html>");
    assert.equal(updated.version, 2);
  } finally {
    ReportTemplateModel.findOne = origFindOne;
  }
});

test("ReportTemplateService.setStatus — rejects an invalid status without touching the DB", async () => {
  await assert.rejects(
    () => ReportTemplateService.setStatus({ tenantId, templateKey: "financial_report", status: "NotAStatus" }),
    /Invalid template status/
  );
});
