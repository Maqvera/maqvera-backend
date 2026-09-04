import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import KPIDefinitionService from "../services/KPIDefinitionService.js";
import KPIDefinitionModel from "../models/KPIDefinitionModel.js";
import KPIEngine, { computeFinanceRatioFields, KPI_REGISTRY } from "../services/KPIEngine.js";
import { computeFinancialRatios } from "../services/FinancialAnalyticsService.js";

const tenantId = "TENANT-TEST-KPIDEFINITION-001";

test("KPIDefinitionService.registerDefinition — creates a new Active definition at version 1", async () => {
  const origFindOne = KPIDefinitionModel.findOne;
  const origCreate = KPIDefinitionModel.create;
  try {
    KPIDefinitionModel.findOne = async () => null;
    let created = null;
    KPIDefinitionModel.create = async (doc) => { created = { ...doc }; return created; };

    const definition = await KPIDefinitionService.registerDefinition({
      tenantId, kpiKey: "ebitdaMargin", name: "EBITDA Margin", ownerModule: "Finance", codeRef: "KPIEngine.computeFinanceMetrics.kpis.ebitdaMargin"
    });

    assert.equal(definition.status, "Active");
    assert.equal(definition.version, 1);
    assert.equal(created.kpiKey, "ebitdaMargin");
  } finally {
    KPIDefinitionModel.findOne = origFindOne;
    KPIDefinitionModel.create = origCreate;
  }
});

test("KPIDefinitionService.registerDefinition — re-registering an existing kpiKey updates it in place rather than duplicating (idempotent upsert)", async () => {
  const origFindOne = KPIDefinitionModel.findOne;
  const origCreate = KPIDefinitionModel.create;
  try {
    const fakeDefinition = {
      tenantId, kpiKey: "ebitdaMargin", ownerModule: "Finance", name: "old name", codeRef: "old.ref",
      category: null, description: null, unit: null, target: null, thresholds: { warning: 10, critical: 5 },
      save: async function () { return this; }
    };
    KPIDefinitionModel.findOne = async () => fakeDefinition;
    KPIDefinitionModel.create = async () => { throw new Error("should not create — should update the existing definition"); };

    const updated = await KPIDefinitionService.registerDefinition({
      tenantId, kpiKey: "ebitdaMargin", name: "EBITDA Margin", ownerModule: "Finance", codeRef: "KPIEngine.computeFinanceMetrics.kpis.ebitdaMargin"
    });

    assert.equal(updated.name, "EBITDA Margin");
    assert.equal(updated.codeRef, "KPIEngine.computeFinanceMetrics.kpis.ebitdaMargin");
    // A tenant's own target/thresholds edits are preserved when re-seeding.
    assert.deepEqual(updated.thresholds, { warning: 10, critical: 5 });
  } finally {
    KPIDefinitionModel.findOne = origFindOne;
    KPIDefinitionModel.create = origCreate;
  }
});

test("KPIDefinitionService.registerDefinition — rejects missing required fields without touching the DB", async () => {
  await assert.rejects(
    () => KPIDefinitionService.registerDefinition({ tenantId, name: "Missing kpiKey" }),
    /Missing required KPI definition fields/
  );
});

test("KPIDefinitionService.listDefinitions — requires tenantId", async () => {
  await assert.rejects(() => KPIDefinitionService.listDefinitions({}), /tenantId is required/);
});

test("KPIDefinitionService.getDefinition — throws when not found", async () => {
  const origFindOne = KPIDefinitionModel.findOne;
  try {
    KPIDefinitionModel.findOne = () => ({ sort: () => ({ lean: () => Promise.resolve(null) }) });
    await assert.rejects(
      () => KPIDefinitionService.getDefinition({ tenantId, kpiKey: "doesNotExist", ownerModule: "Finance" }),
      /not found/
    );
  } finally {
    KPIDefinitionModel.findOne = origFindOne;
  }
});

test("KPIDefinitionService.deprecateDefinition — sets status to Deprecated", async () => {
  const origFindOneAndUpdate = KPIDefinitionModel.findOneAndUpdate;
  try {
    KPIDefinitionModel.findOneAndUpdate = async (_filter, update) => ({ kpiKey: "ebitdaMargin", ...update.$set });
    const result = await KPIDefinitionService.deprecateDefinition({ tenantId, kpiKey: "ebitdaMargin", ownerModule: "Finance" });
    assert.equal(result.status, "Deprecated");
  } finally {
    KPIDefinitionModel.findOneAndUpdate = origFindOneAndUpdate;
  }
});

test("KPIEngine.ensureDefinitionsSeeded — returns {registered:0} without a live Mongo connection, never throws", async () => {
  assert.notEqual(mongoose.connection?.readyState, 1, "this test assumes no live DB connection, matching the rest of this suite");
  const result = await KPIEngine.ensureDefinitionsSeeded({ tenantId });
  assert.deepEqual(result, { registered: 0 });
});

test("KPI_REGISTRY — no duplicate {kpiKey, ownerModule} pair (would violate KPIDefinitionModel's unique index)", () => {
  const pairs = KPI_REGISTRY.map((entry) => `${entry.ownerModule}::${entry.kpiKey}`);
  assert.equal(new Set(pairs).size, pairs.length, "every (ownerModule, kpiKey) pair in KPI_REGISTRY must be unique");
});

test("KPI_REGISTRY — every entry has the fields KPIDefinitionService.registerDefinition requires", () => {
  assert.ok(KPI_REGISTRY.length > 0);
  for (const entry of KPI_REGISTRY) {
    assert.ok(entry.kpiKey, `entry missing kpiKey: ${JSON.stringify(entry)}`);
    assert.ok(entry.name, `entry ${entry.kpiKey} missing name`);
    assert.ok(entry.ownerModule, `entry ${entry.kpiKey} missing ownerModule`);
    assert.ok(entry.codeRef, `entry ${entry.kpiKey} missing codeRef`);
  }
});

test("KPI_REGISTRY — calling KPIDefinitionService.registerDefinition for every entry twice is idempotent (no duplicate create, no error) without touching a real DB", async () => {
  const origFindOne = KPIDefinitionModel.findOne;
  const origCreate = KPIDefinitionModel.create;
  const store = new Map();
  try {
    KPIDefinitionModel.findOne = async ({ tenantId: t, kpiKey, ownerModule }) => store.get(`${t}::${kpiKey}::${ownerModule}`) || null;
    KPIDefinitionModel.create = async (doc) => {
      const record = { ...doc, save: async function () { store.set(`${this.tenantId}::${this.kpiKey}::${this.ownerModule}`, this); return this; } };
      store.set(`${doc.tenantId}::${doc.kpiKey}::${doc.ownerModule}`, record);
      return record;
    };

    for (const entry of KPI_REGISTRY) await KPIDefinitionService.registerDefinition({ tenantId, ...entry });
    assert.equal(store.size, KPI_REGISTRY.length, "first pass should create exactly one definition per registry entry");

    for (const entry of KPI_REGISTRY) await KPIDefinitionService.registerDefinition({ tenantId, ...entry });
    assert.equal(store.size, KPI_REGISTRY.length, "second pass must update in place, not create duplicates");
  } finally {
    KPIDefinitionModel.findOne = origFindOne;
    KPIDefinitionModel.create = origCreate;
  }
});

// ─────────────────────────────────────────────────────────────
// Regression test — gap 3.3's correctness fix. Proves
// KPIEngine.computeFinanceRatioFields (day-scoped) and
// FinancialAnalyticsService.computeFinancialRatios (period-scoped) now
// agree in UNIT (both percentages) and, for equivalent inputs, VALUE —
// and that both correctly return null (not a misleading 0) with no
// revenue to divide by.
// ─────────────────────────────────────────────────────────────
test("computeFinanceRatioFields vs computeFinancialRatios — agree in unit (percentage) and value for equivalent inputs", () => {
  const dayScoped = computeFinanceRatioFields({ ebitda: 500, todaysRevenue: 1000, todaysExpenses: 600, netCashFlowToday: 400 });
  const periodScoped = computeFinancialRatios({ totalAssets: 0, totalLiabilities: 0, totalEquity: 0, totalRevenue: 1000, netIncome: 400 });
  const periodEbitdaMargin = 1000 ? Math.round(((500 / 1000) * 100) * 100) / 100 : null;

  assert.equal(dayScoped.operatingMargin, periodScoped.operatingMargin, "operatingMargin must agree in value/unit for equivalent revenue+net-income inputs");
  assert.equal(dayScoped.operatingRatio, periodScoped.operatingRatio, "operatingRatio must agree in value/unit for equivalent revenue+expense inputs");
  assert.equal(dayScoped.ebitdaMargin, periodEbitdaMargin, "ebitdaMargin must agree in value/unit for equivalent ebitda+revenue inputs");
  assert.equal(dayScoped.operatingMargin, 40);
  assert.equal(dayScoped.operatingRatio, 60);
  assert.equal(dayScoped.ebitdaMargin, 50);
});

test("computeFinanceRatioFields — returns null (not a misleading 0) on a zero-revenue day, matching computeFinancialRatios' null-safety convention", () => {
  const dayScoped = computeFinanceRatioFields({ ebitda: 0, todaysRevenue: 0, todaysExpenses: 0, netCashFlowToday: 0 });
  const periodScoped = computeFinancialRatios({ totalAssets: 0, totalLiabilities: 0, totalEquity: 0, totalRevenue: 0, netIncome: 0 });

  assert.equal(dayScoped.ebitdaMargin, null);
  assert.equal(dayScoped.operatingMargin, null);
  assert.equal(dayScoped.operatingRatio, null);
  assert.equal(periodScoped.operatingMargin, null);
  assert.equal(periodScoped.operatingRatio, null);
});
