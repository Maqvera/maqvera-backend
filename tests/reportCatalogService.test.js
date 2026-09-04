import test from "node:test";
import assert from "node:assert/strict";
import ReportCatalogService from "../services/ReportCatalogService.js";
import ReportCatalogModel from "../models/ReportCatalogModel.js";

const tenantId = "TENANT-TEST-REPORTCATALOG-001";

test("ReportCatalogService.registerCatalogEntry — creates a new draft entry at version 1", async () => {
  const origFindOne = ReportCatalogModel.findOne;
  const origCreate = ReportCatalogModel.create;
  try {
    ReportCatalogModel.findOne = async () => null;
    let created = null;
    ReportCatalogModel.create = async (doc) => { created = { ...doc }; return created; };

    const entry = await ReportCatalogService.registerCatalogEntry({
      tenantId, reportKey: "TrialBalance", name: "Trial Balance", module: "Finance"
    });

    assert.equal(entry.lifecycleState, "draft");
    assert.equal(entry.currentVersion, 1);
    assert.equal(created.reportKey, "TrialBalance");
  } finally {
    ReportCatalogModel.findOne = origFindOne;
    ReportCatalogModel.create = origCreate;
  }
});

test("ReportCatalogService.registerCatalogEntry — re-registering an existing reportKey updates it in place rather than duplicating (idempotent upsert)", async () => {
  const origFindOne = ReportCatalogModel.findOne;
  const origCreate = ReportCatalogModel.create;
  try {
    const fakeEntry = {
      tenantId, reportKey: "TrialBalance", module: "Finance", name: "old name",
      category: null, tags: [], owner: null, description: null, relatedKpiKeys: [],
      save: async function () { return this; }
    };
    ReportCatalogModel.findOne = async () => fakeEntry;
    ReportCatalogModel.create = async () => { throw new Error("should not create — should update the existing entry"); };

    const updated = await ReportCatalogService.registerCatalogEntry({
      tenantId, reportKey: "TrialBalance", name: "Trial Balance", module: "Finance"
    });

    assert.equal(updated.name, "Trial Balance");
  } finally {
    ReportCatalogModel.findOne = origFindOne;
    ReportCatalogModel.create = origCreate;
  }
});

test("ReportCatalogService.registerCatalogEntry — rejects missing required fields without touching the DB", async () => {
  await assert.rejects(
    () => ReportCatalogService.registerCatalogEntry({ tenantId, name: "Missing reportKey and module" }),
    /Missing required report catalog fields/
  );
});

test("ReportCatalogService.registerCatalogEntry — rejects an unconfigured module without touching the DB", async () => {
  await assert.rejects(
    () => ReportCatalogService.registerCatalogEntry({ tenantId, reportKey: "X", name: "X", module: "NotAModule" }),
    /Invalid module/
  );
});

test("ReportCatalogService.listCatalogEntries — requires tenantId", async () => {
  await assert.rejects(() => ReportCatalogService.listCatalogEntries({}), /tenantId is required/);
});

test("ReportCatalogService.getCatalogEntry — throws when not found", async () => {
  const origFindOne = ReportCatalogModel.findOne;
  try {
    ReportCatalogModel.findOne = () => ({ lean: () => Promise.resolve(null) });
    await assert.rejects(
      () => ReportCatalogService.getCatalogEntry({ tenantId, reportKey: "doesNotExist" }),
      /not found/
    );
  } finally {
    ReportCatalogModel.findOne = origFindOne;
  }
});

test("ReportCatalogService.transitionLifecycle — allows a legal one-step forward transition (draft -> review)", async () => {
  const origFindOne = ReportCatalogModel.findOne;
  try {
    const fakeEntry = { tenantId, reportKey: "TrialBalance", lifecycleState: "draft", save: async function () { return this; } };
    ReportCatalogModel.findOne = async () => fakeEntry;

    const updated = await ReportCatalogService.transitionLifecycle({ tenantId, reportKey: "TrialBalance", lifecycleState: "review" });
    assert.equal(updated.lifecycleState, "review");
  } finally {
    ReportCatalogModel.findOne = origFindOne;
  }
});

test("ReportCatalogService.transitionLifecycle — rejects an illegal jump (draft -> archived) without adminOverride", async () => {
  const origFindOne = ReportCatalogModel.findOne;
  try {
    const fakeEntry = { tenantId, reportKey: "TrialBalance", lifecycleState: "draft", save: async function () { return this; } };
    ReportCatalogModel.findOne = async () => fakeEntry;

    await assert.rejects(
      () => ReportCatalogService.transitionLifecycle({ tenantId, reportKey: "TrialBalance", lifecycleState: "archived" }),
      /Invalid lifecycle transition/
    );
  } finally {
    ReportCatalogModel.findOne = origFindOne;
  }
});

test("ReportCatalogService.transitionLifecycle — allows an illegal jump when adminOverride is passed", async () => {
  const origFindOne = ReportCatalogModel.findOne;
  try {
    const fakeEntry = { tenantId, reportKey: "TrialBalance", lifecycleState: "draft", save: async function () { return this; } };
    ReportCatalogModel.findOne = async () => fakeEntry;

    const updated = await ReportCatalogService.transitionLifecycle({ tenantId, reportKey: "TrialBalance", lifecycleState: "archived", adminOverride: true });
    assert.equal(updated.lifecycleState, "archived");
  } finally {
    ReportCatalogModel.findOne = origFindOne;
  }
});

// ─────────────────────────────────────────────────────────────
// Seed-script idempotency — scripts/seedReportCatalog.js calls
// ReportCatalogService.registerCatalogEntry once per Finance reportType.
// Proves running that loop twice never duplicates or errors, without a
// real DB or the script's own dotenv/mongoose.connect side effects.
// ─────────────────────────────────────────────────────────────
test("seedReportCatalog pattern — registering the same set of reportTypes twice is idempotent (no duplicate create, no error)", async () => {
  const origFindOne = ReportCatalogModel.findOne;
  const origCreate = ReportCatalogModel.create;
  const store = new Map();
  const reportTypes = ["TrialBalance", "BalanceSheet", "ProfitAndLoss", "CashFlow", "Custom"];
  try {
    ReportCatalogModel.findOne = async ({ tenantId: t, reportKey }) => store.get(`${t}::${reportKey}`) || null;
    ReportCatalogModel.create = async (doc) => {
      const record = { ...doc, save: async function () { store.set(`${this.tenantId}::${this.reportKey}`, this); return this; } };
      store.set(`${doc.tenantId}::${doc.reportKey}`, record);
      return record;
    };

    for (const reportType of reportTypes) {
      await ReportCatalogService.registerCatalogEntry({ tenantId, reportKey: reportType, name: reportType, module: "Finance", lifecycleState: "published" });
    }
    assert.equal(store.size, reportTypes.length, "first pass should create exactly one entry per reportType");

    for (const reportType of reportTypes) {
      await ReportCatalogService.registerCatalogEntry({ tenantId, reportKey: reportType, name: reportType, module: "Finance", lifecycleState: "published" });
    }
    assert.equal(store.size, reportTypes.length, "second pass must update in place, not create duplicates");
  } finally {
    ReportCatalogModel.findOne = origFindOne;
    ReportCatalogModel.create = origCreate;
  }
});
