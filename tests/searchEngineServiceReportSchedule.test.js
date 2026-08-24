import test from "node:test";
import assert from "node:assert/strict";
import SearchEngineService from "../services/SearchEngineService.js";
import SearchIndexModel from "../models/SearchIndexModel.js";
import ReportScheduleModel from "../models/ReportScheduleModel.js";

const tenantId = "TENANT-TEST-SEARCHSCHED-001";

test("SearchIndexModel.entityType enum accepts ReportSchedule (Reporting Platform Part 14 fix)", () => {
  const enumValues = SearchIndexModel.schema.path("entityType").enumValues;
  assert.ok(enumValues.includes("ReportSchedule"));
});

test("SearchEngineService.indexReportSchedule — indexes a schedule with frequency/status facets", async () => {
  const origFindOne = ReportScheduleModel.findOne;
  const origIndexEntity = SearchEngineService.indexEntity;
  let capturedEntity = null;

  try {
    ReportScheduleModel.findOne = () => ({ lean: async () => ({
      tenantId, _id: "SCHED-1", name: "Weekly Executive Report", reportType: "ProfitAndLoss",
      frequency: "Weekly", status: "Active", nextRunAt: new Date("2026-02-01")
    }) });
    SearchEngineService.indexEntity = async (entity) => { capturedEntity = entity; return entity; };

    await SearchEngineService.indexReportSchedule({ tenantId, scheduleId: "SCHED-1" });

    assert.equal(capturedEntity.entityType, "ReportSchedule");
    assert.match(capturedEntity.title, /Weekly Executive Report/);
    assert.equal(capturedEntity.facets.frequency, "Weekly");
    assert.equal(capturedEntity.module, "Finance");
  } finally {
    ReportScheduleModel.findOne = origFindOne;
    SearchEngineService.indexEntity = origIndexEntity;
  }
});

test("SearchEngineService.indexReportSchedule — soft-removes from the index when the schedule no longer exists", async () => {
  const origFindOne = ReportScheduleModel.findOne;
  const origRemove = SearchEngineService.removeEntity;
  let removeCalledWith = null;

  try {
    ReportScheduleModel.findOne = () => ({ lean: async () => null });
    SearchEngineService.removeEntity = async (args) => { removeCalledWith = args; };

    await SearchEngineService.indexReportSchedule({ tenantId, scheduleId: "SCHED-GONE" });

    assert.equal(removeCalledWith.entityType, "ReportSchedule");
    assert.equal(removeCalledWith.entityId, "SCHED-GONE");
  } finally {
    ReportScheduleModel.findOne = origFindOne;
    SearchEngineService.removeEntity = origRemove;
  }
});
